"""Rebuild the shipped native engine with pinned Xerces and Emscripten.

Requires Python 3, git, CMake and Ninja on PATH. Build tools and downloads stay
under .artifacts/native-rebuild. No Docker, Java, system install or network I/O
is involved when using the resulting validation engine.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
XERCES_COMMIT = '32ff60fb42931f73ce0720cd8868b50c883223e7'
EMSDK_COMMIT = '0dfff153dc3c596948ac088b8853006c570f2609'
EMSCRIPTEN_VERSION = '5.0.6'


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def checkout(url, target, revision, generated=()):
    created = not (target / '.git').exists()
    if created:
        run(['git', 'clone', '--no-checkout', url, target])
    else:
        changes = subprocess.check_output(['git', '-C', str(target), 'status', '--porcelain'], text=True).splitlines()
        if any(line not in ['?? ' + name for name in generated] for line in changes):
            raise RuntimeError(f'Pinned source checkout has local changes: {target}')
    actual = subprocess.check_output(['git', '-C', str(target), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != revision:
        run(['git', '-C', target, 'fetch', '--depth=1', 'origin', revision])
    if created or actual != revision:
        run(['git', '-C', target, 'checkout', '--detach', revision])
    changes = subprocess.check_output(['git', '-C', str(target), 'status', '--porcelain'], text=True).splitlines()
    if any(line not in ['?? ' + name for name in generated] for line in changes):
        raise RuntimeError(f'Pinned source checkout has local changes: {target}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT / '.artifacts/native-rebuild')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--xerces-source', type=Path, help='Reuse a checkout; its pinned revision and clean state are checked')
    parser.add_argument('--emsdk', type=Path, help='Reuse a pinned SDK checkout')
    parser.add_argument('--build-directory', type=Path, help='Reuse an existing CMake build directory')
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    work = args.workspace.resolve()
    work.mkdir(parents=True, exist_ok=True)
    xerces = (args.xerces_source or work / 'xerces-c').resolve()
    sdk = (args.emsdk or work / 'emsdk').resolve()
    build = (args.build_directory or work / 'build').resolve()
    checkout('https://github.com/harshanacz/apache-xerces-c.git', xerces, XERCES_COMMIT)
    checkout('https://github.com/emscripten-core/emsdk.git', sdk, EMSDK_COMMIT, generated=('emsdk_set_env.bat', 'emsdk_set_env.sh'))
    run([sys.executable, sdk / 'emsdk.py', 'install', EMSCRIPTEN_VERSION])
    run([sys.executable, sdk / 'emsdk.py', 'activate', EMSCRIPTEN_VERSION])
    env = os.environ.copy()
    env['EM_CONFIG'] = str(sdk / '.emscripten')
    cmake = shutil.which('cmake')
    ninja = shutil.which('ninja')
    if not cmake or not ninja:
        raise RuntimeError('CMake and Ninja must be available on PATH')
    run([cmake, '-S', xerces, '-B', build, '-G', 'Ninja',
         f'-DCMAKE_MAKE_PROGRAM={ninja}',
         f'-DCMAKE_TOOLCHAIN_FILE={sdk / "upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"}',
         '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_BUILD_TYPE=Release',
         '-DBUILD_SHARED_LIBS=OFF', '-Dnetwork=OFF', '-Dthreads=OFF',
         '-Dtranscoder=gnuiconv', '-Dmessage-loader=inmemory', '-DCMAKE_CXX_FLAGS=-fexceptions'], env=env)
    run([cmake, '--build', build, '--target', 'xerces-c', '--parallel', args.jobs], env=env)
    output = ROOT / 'native/runtime'
    output.mkdir(parents=True, exist_ok=True)
    run([sys.executable, sdk / 'upstream/emscripten/em++.py', ROOT / 'native/xerces-validation.cpp',
         f'-I{xerces / "src"}', f'-I{build / "src"}', build / 'src/libxerces-c.a',
         '--bind', '-std=c++17', '-fexceptions', '-sDISABLE_EXCEPTION_CATCHING=0',
         '-sASYNCIFY=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sALLOW_MEMORY_GROWTH=1',
         '-sEXPORTED_FUNCTIONS=["_xw_add_source","_xw_add_type_query","_xw_set_features","_xw_set_type_namespace","_xw_query_type","_xw_compile","_xw_validate","_xw_dispose","_malloc","_free"]',
         '-sEXPORTED_RUNTIME_METHODS=["ccall","stringToNewUTF8"]', '-O2',
         '-o', output / 'xerces-engine.js'], env=env)
    files = [ROOT / 'native/xerces-validation.cpp', output / 'xerces-engine.js', output / 'xerces-engine.wasm']
    manifest = {
        'xercesRevision': XERCES_COMMIT,
        'emsdkRevision': EMSDK_COMMIT,
        'emscriptenVersion': EMSCRIPTEN_VERSION,
        'sha256': {str(path.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
    }
    (output / 'provenance.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('Rebuilt native/runtime/xerces-engine.js and xerces-engine.wasm')


if __name__ == '__main__':
    main()
