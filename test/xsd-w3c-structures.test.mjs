import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseXml } from '../dist/index.js';
import { compileIsolatedXercesSchema } from '../dist/schema-xerces-isolated.js';
import { compileJavaSchema } from '../dist/schema-java.js';

const directory = new URL('./fixtures/w3c-structures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceId = source => `https://raw.githubusercontent.com/w3c/xsdtests/${manifest.revision}/${source.path}`;
async function original(source) {
  const bytes = await readFile(new URL('upstream/' + source.path, directory));
  assert.equal(bytes.length, source.bytes, source.path + ' byte count');
  assert.equal(digest(bytes), source.sha256, source.path + ' SHA256');
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), source.gitBlob, source.path + ' Git blob');
  return { kind: 'bytes', bytes, systemId: sourceId(source) };
}
const localName = node => node.localName;
const attributes = node => Object.fromEntries(Array.from(node.attributes, attribute => [attribute.name, attribute.value]));
test('pinned complete structural groups preserve full metadata, validity, source bytes and copyright', async () => {
  assert.equal(manifest.revision, '7bc3365c652a322f3d762021b3879eb92dae7e30');
  assert.equal(manifest.groups.length, 19);
  await original(manifest.copyright);
  for (const record of manifest.metadata) {
    const compressed = await readFile(new URL(record.storedAs, directory));
    assert.equal(digest(compressed), record.compressedSha256);
    const bytes = gunzipSync(compressed);
    assert.equal(bytes.length, record.bytes);
    assert.equal(digest(bytes), record.sha256);
    const document = parseXml(bytes.toString('utf8'));
    for (const group of manifest.groups.filter(g => g.metadataPath === record.path)) {
      const upstream = Array.from(document.documentElement.children).find(node => node.getAttribute('name') === group.group);
      assert.ok(upstream);
      const tests = Array.from(upstream.children).filter(node => ['schemaTest', 'instanceTest'].includes(localName(node)));
      assert.deepEqual(group.tests.map(item => ({ name: item.name, kind: item.kind, expected: item.expected, status: item.status, sources: item.sources.map(source => source.path) })), tests.map(node => ({
        name: node.getAttribute('name'), kind: node.localName,
        expected: Array.from(node.children).filter(child => child.localName === 'expected').map(attributes),
        status: attributes(Array.from(node.children).find(child => child.localName === 'current')),
        sources: Array.from(node.children).filter(child => ['schemaDocument', 'instanceDocument'].includes(child.localName)).map(child => new URL(child.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), 'https://upstream.invalid/' + record.path).pathname.slice(1)),
      })), group.group + ': complete original group with unchanged expectations');
      for (const source of group.resources) await original(source);
    }
  }
});

for (const [provider, compile] of [['native isolated', compileIsolatedXercesSchema], ['Java adapter', compileJavaSchema]]) {
  for (const group of manifest.groups) test(`external W3C structures ${provider}: ${group.group}`, { timeout: 30000 }, async () => {
    const resourceMap = Object.fromEntries(await Promise.all(group.resources.map(async record => [sourceId(record), await original(record)])));
    const schemas = group.tests.filter(item => item.kind === 'schemaTest');
    assert.equal(schemas.length, 1, 'Every selected group has one schema test');
    const schema = schemas[0];
    assert.equal(schema.expected.length, 1, 'No versioned/indeterminate expectation silently ignored');
    const roots = await Promise.all(schema.sources.map(original));
    const options = provider === "Java adapter" ? { timeoutMs: 20000 } : { resourceMap, timeoutMs: 20000 };
    const inputs = provider === "Java adapter" ? [...roots, ...Object.values(resourceMap).filter(source => !roots.some(root => root.systemId === source.systemId))] : roots;
    if (schema.expected[0].validity === 'invalid') {
      await assert.rejects(compile(inputs, options), { code: 'INVALID_SCHEMA' });
      return;
    }
    assert.equal(schema.expected[0].validity, 'valid');
    const grammar = await compile(inputs, options);
    try {
      for (const item of group.tests.filter(item => item.kind === 'instanceTest')) {
        assert.equal(item.expected.length, 1);
        assert.ok(['valid', 'invalid'].includes(item.expected[0].validity));
        assert.equal(item.sources.length, 1);
        const result = await grammar.validate(await original(item.sources[0]));
        assert.equal(result.valid, item.expected[0].validity === 'valid', `${item.name}: ${result.diagnostics.map(d => d.message).join('; ')}`);
      }
    } finally { grammar.dispose(); }
  });
}
