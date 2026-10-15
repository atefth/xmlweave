import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const modules = {
  index: [['slimdom', 'LICENSE']],
  xpath: [['fontoxpath', 'LICENSE.md'], ['prsc', 'LICENSE'], ['xspattern', 'LICENSE']],
  stream: [['saxes', 'LICENSE'], ['xmlchars', 'LICENSE']],
  schema: [], transform: [],
};
const namesBuilt = [];
for (const [name, licenses] of Object.entries(modules)) {
  try { await access(`src/${name}.ts`); } catch { continue; }
  const notices = [];
  for (const [dependency, filename] of licenses) {
    const text = await readFile(dependency === 'saxes' ? 'licenses/saxes.LICENSE' : `node_modules/${dependency}/${filename}`, 'utf8');
    await writeFile(`dist/${dependency}.LICENSE`, text);
    notices.push(`${dependency}\n${text}`);
  }
  await build({ entryPoints: [`src/${name}.ts`], outfile: `dist/${name}.cjs`, bundle: true,
    platform: 'neutral', mainFields: ['module', 'main'], format: 'cjs', target: 'es2022', sourcemap: true,
    external: ['libxml2-wasm', 'xslt-processor'],
    plugins: [{ name: 'shared-core', setup(builder) {
      if (name !== 'index') builder.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: './index.cjs', external: true }));
    } }],
    banner: notices.length ? { js: `/*! Bundled dependency notices\n${notices.join('\n\n')}\n*/` } : undefined });
  const api = await import(new URL(`../dist/${name}.cjs`, import.meta.url));
  const exported = Object.keys(api.default).filter(key => key !== '__esModule');
  await writeFile(`dist/${name}.js`, `import implementation from './${name}.cjs';\nexport const { ${exported.join(', ')} } = implementation;\n`);
  namesBuilt.push(name);
}
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
for (const name of namesBuilt) {
  const declaration = await readFile(`dist/${name}.d.ts`, 'utf8');
  await writeFile(`dist/${name}.d.cts`, declaration.replace(/import \* as dom from/, 'import type * as dom from').replace(/(from\s+['"]slimdom['"])(\s*;)/g,
    '$1 with { "resolution-mode": "import" }$2').replace(/(['"])\.\/index\.js\1/g, '$1./index.cjs$1'));
}
console.log(`Built shared implementations and ESM/CJS declarations: ${namesBuilt.join(', ')}.`);
