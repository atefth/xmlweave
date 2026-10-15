import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const engineLicense = await readFile('node_modules/slimdom/LICENSE', 'utf8');
await writeFile('dist/slimdom.LICENSE', engineLicense);
// A single implementation preserves constructor identity across import/require.
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', bundle: true,
  platform: 'neutral', format: 'cjs', target: 'es2022', sourcemap: true,
  banner: { js: `/*! Bundled slimdom 4.3.5\n${engineLicense}\n*/` } });
const api = await import(new URL('../dist/index.cjs', import.meta.url));
const names = Object.keys(api.default).filter(name => name !== '__esModule');
await writeFile('dist/index.js', `import implementation from './index.cjs';\nexport const { ${names.join(', ')} } = implementation;\n`);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
const declaration = await readFile('dist/index.d.ts', 'utf8');
await writeFile('dist/index.d.cts', declaration.replace(/import \* as dom from/, 'import type * as dom from').replace(/(from\s+['"]slimdom['"])(\s*;)/g,
  '$1 with { "resolution-mode": "import" }$2'));
console.log('Built shared implementation, ESM entry and both declaration formats.');
