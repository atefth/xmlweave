import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Spaces exercise Windows argument handling in every CI consumer run.
const temporary = await mkdtemp(join(tmpdir(), 'xmlweave consumer '));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this fixture through npm run test:consumers.');
function run(command, args, cwd = temporary) {
  return execFileSync(command === npm ? process.execPath : command,
    command === npm ? [npmCli, ...args] : args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const version = process.env.XMLWEAVE_TYPESCRIPT_VERSION || '7.0.2';
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename), `typescript@${version}`]);
  const source = `import { parseXml, createDocument, serializeXml, mutateXml, XmlError, type Document, type Element, type Node } from 'xmlweave';
const doc: Document = parseXml('<root/>');
const element: Element | null = doc.documentElement;
const node: Node = doc;
const created: Document = createDocument(null, 'root');
const xml: string = serializeXml(created);
mutateXml(doc, document => { document.documentElement?.setAttribute('checked', 'yes'); });
const error: Error = new XmlError('INVALID_ARGUMENT', 'parse', 'invalid');
void [element, node, xml, error];\n`;
  await writeFile(join(temporary, 'consumer.mts'), source);
  await writeFile(join(temporary, 'consumer.cts'), source);
  const compiler = join(temporary, 'node_modules/typescript/bin/tsc');
  for (const mode of ['Node16', 'NodeNext', 'Bundler']) {
    const files = mode === 'Bundler' ? ['consumer.mts'] : ['consumer.mts', 'consumer.cts'];
    await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: mode === 'Bundler' ? 'ESNext' : mode, moduleResolution: mode,
      strict: true, skipLibCheck: false, lib: ['ES2022'], types: [], noEmit: true }, files }));
    run(process.execPath, [compiler, '-p', 'tsconfig.json']);
  }
  await writeFile(join(temporary, 'consumer.mjs'), `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from 'xmlweave';
const cjs = createRequire(import.meta.url)('xmlweave');
for (const name of Object.keys(esm)) assert.equal(esm[name], cjs[name], name);
const doc = esm.parseXml('<root/>');
assert.equal(cjs.serializeXml(doc), '<root/>');
const created = cjs.createDocument(null, 'created');
assert.equal(esm.serializeXml(created), '<created/>');
try { esm.parseXml('<broken>'); assert.fail('Expected parse error'); }
catch (error) { assert.ok(error instanceof cjs.XmlError); }
`);
  run(process.execPath, ['consumer.mjs']);
  const metadata = JSON.parse(run(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('xmlweave/package.json')))" ]));
  assert.equal(metadata.version, '0.1.0-dev.0');
  console.log(`Packed consumer checks passed: Node ${process.version}, TypeScript ${version}, Node16/NodeNext/Bundler, ES-only declarations and mixed ESM/CJS identity.`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
