# Native validation engine

`xerces-validation.cpp` is XMLWeave's SAX2/PSVI bridge. Packed artifact contents
keep one runtime copy under `dist`; the `native` directory retains the bridge
source and these build instructions. The shipped runtime is
compiled from Apache Xerces-C++ with network access and threads disabled.
The JavaScript adapter provides explicit in-memory resource resolution; the
isolated adapter provides enforceable host deadlines by terminating its worker.

Pinned build inputs:

| Input | Revision |
| --- | --- |
| [Xerces-C++ fork](https://github.com/harshanacz/apache-xerces-c) | `32ff60fb42931f73ce0720cd8868b50c883223e7` |
| [Emscripten SDK](https://github.com/emscripten-core/emsdk) | `0dfff153dc3c596948ac088b8853006c570f2609` |
| Compiler release | Emscripten `5.0.6` |

The fork reports Xerces-C++ 4.0.0. It is used for its WebAssembly build support;
this does not imply full conformance or endorsement by Apache. The complete
upstream source is available at the pinned revision. XMLWeave's changes are the
separate bridge in this directory, not unrecorded patches to that source tree.

With Python 3, Git, CMake and Ninja available, run `npm run build:native` from a
repository checkout. The script downloads pinned sources and compiler into
`.artifacts/native-rebuild`, builds a static library, then regenerates
`runtime/xerces-engine.js` and `runtime/xerces-engine.wasm`. First use requires
network access for the source/compiler downloads. Runtime validation does not.
Compiler flags and native exports are recorded in `scripts/build-xerces.py`.
Build with `npm run build`, then run the native Node tests and
`npm run test:validation-browser` to verify the newly built assets.

Apache License 2.0 and its NOTICE are retained in `licenses/xerces-c.LICENSE`
and `licenses/xerces-c.NOTICE`. The evaluation project's MIT attribution is
retained in `licenses/xerces-wasm-validator.LICENSE`. Builds embed these sources
into the shipped WebAssembly; the package retains the licenses and this bridge.
