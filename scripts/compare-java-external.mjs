import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const directory = new URL('test/fixtures/w3c-structures/', root);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const runtime = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 10000 });
if (runtime.error || runtime.status !== 0) throw new Error('Java is required for external observations.');
async function source(record) {
  const bytes = await readFile(new URL('upstream/' + record.path, directory));
  if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256)
    throw new Error('Changed upstream bytes: ' + record.path);
  return { kind: 'bytes', bytes, systemId: `https://raw.githubusercontent.com/w3c/xsdtests/${manifest.revision}/${record.path}` };
}
const encode = text => Buffer.from(text, 'utf8').toString('base64');
const records = [], frames = [];
for (const group of manifest.groups) {
  const schema = group.tests.find(item => item.kind === 'schemaTest');
  const roots = await Promise.all(schema.sources.map(source));
  const resources = await Promise.all(group.resources.map(source));
  const instances = group.tests.filter(item => item.kind === 'instanceTest');
  frames.push(String(roots.length), String(resources.length), String(instances.length));
  for (const item of [...roots, ...resources]) frames.push(encode(item.systemId), encode(Buffer.from(item.bytes).toString('utf8')));
  for (const item of instances) {
    const instance = await source(item.sources[0]);
    frames.push(encode(instance.systemId), encode(Buffer.from(instance.bytes).toString('utf8')));
  }
  records.push({ group: group.group, test: schema.name, phase: 'schema', authoritativeExpected: schema.expected[0].validity === 'valid' });
  for (const instance of instances) records.push({ group: group.group, test: instance.name, phase: 'instance', authoritativeExpected: instance.expected[0].validity === 'valid' });
}
const run = spawnSync('java', [fileURLToPath(new URL('test/java/XsdExternalReference.java', root))], { input: frames.join('\n') + '\n', encoding: 'utf8', timeout: 60000, maxBuffer: 4000000 });
if (run.error || run.status !== 0) throw new Error('Raw Java external reference failed: ' + (run.error?.message ?? run.stderr));
const lines = run.stdout.trim().split(/\r?\n/);
if (lines.length !== records.length) throw new Error('Unexpected raw Java external reference response count.');
const observations = records.map((record, index) => {
  const raw = lines[index];
  if (!new RegExp('^' + record.phase + ':(valid|invalid)$').test(raw)) throw new Error('Unexpected reference response: ' + raw);
  return { ...record, actual: raw.endsWith(':valid'), raw };
});
const differences = observations.filter(item => item.actual !== item.authoritativeExpected).map(item => ({
  ...item,
  knownJDKDeviation: item.group === 'idZ012' && item.test === 'idZ012.i' && item.authoritativeExpected === false && item.actual === true,
}));
const report = {
  runtime: (runtime.stderr || runtime.stdout).trim(),
  upstreamRevision: manifest.revision,
  scope: 'Unmodified public JAXP reference observations, separate from the XMLWeave Java adapter; not full XSD conformance.',
  observations, differences,
};
await mkdir(new URL('.artifacts/', root), { recursive: true });
await writeFile(new URL('.artifacts/java-external-conformance.json', root), JSON.stringify(report, null, 2) + '\n');
console.log(`Java external observations: ${observations.length - differences.length}/${observations.length} match authoritative expectations; ${differences.length} visible difference(s).`);
for (const item of differences) console.log(`${item.test}: expected=${item.authoritativeExpected} actual=${item.actual} knownJDKDeviation=${item.knownJDKDeviation}`);
if (differences.some(item => !item.knownJDKDeviation)) process.exitCode = 1;
