import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamXml, XmlStreamError } from '../dist/stream.js';

const collect = async (source, options) => { const result = []; for await (const event of streamXml(source, options)) result.push(event); return result; };
const code = expected => error => error instanceof XmlStreamError && error.code === expected;

test('streaming preserves namespace and entity semantics at every UTF-16 boundary', async () => {
  const xml = '<?xml version="1.0"?><p:r xmlns:p="urn:root" xmlns:a="urn:attr" a:id="A&amp;B">😀&#x1F600;&lt;<![CDATA[x<y]]><!--tail--><?probe data?><p:c/></p:r>';
  for (let split = 0; split <= xml.length; split++) {
    const events = await collect([xml.slice(0, split), xml.slice(split)]);
    const start = events.find(event => event.type === 'startElement');
    assert.equal(start.namespaceURI, 'urn:root');
    assert.equal(start.localName, 'r');
    assert.equal(start.attributes.find(attribute => attribute.localName === 'id').value, 'A&B');
    assert.equal(start.attributes.find(attribute => attribute.localName === 'id').namespaceURI, 'urn:attr');
    assert.equal(start.namespaces.p, 'urn:root');
    assert.equal(events.filter(event => event.type === 'text').map(event => event.value).join(''), '😀😀<');
    assert.equal(events.find(event => event.type === 'cdata').value, 'x<y');
    assert.equal(events.find(event => event.type === 'comment').value, 'tail');
    assert.equal(events.find(event => event.type === 'processingInstruction').target, 'probe');
    assert.deepEqual(events.filter(event => event.type === 'endElement').map(event => event.localName), ['c', 'r']);
  }
  assert.equal((await collect([...xml])).filter(event => event.type === 'startElement').length, 2);
});

test('streaming rejects malformed XML, namespace errors and all DTDs', async () => {
  for (const input of ['', '<r>', '<r/><s/>', '<p:r/>', '<r a="1" a="2"/>', '<r xmlns:p="u" xmlns:q="u" p:a="1" q:a="2"/>', '<r>&unknown;</r>', '<r>&#0;</r>', '<r>\0</r>', '<?xml version="1.1"?><r/>']) {
    await assert.rejects(collect([...input]), code('MALFORMED_XML'), input);
  }
  for (const input of ['<!DOCTYPE r><r/>', '<!DOCTYPE r SYSTEM "https://invalid.example/external"><r/>', '<!DOCTYPE r [<!ENTITY x "expand">]><r>&x;</r>']) {
    await assert.rejects(collect([...input]), code('DTD_FORBIDDEN'));
  }
  const data = await collect(['<!-- <!DOCTYPE fake> --><r><![CDATA[<!DOCTYPE fake>]]></r>']);
  assert.equal(data.find(event => event.type === 'cdata').value, '<!DOCTYPE fake>');
});

test('streaming bounds source chunks, outstanding tokens, total input, depth and event queue', async () => {
  await assert.rejects(collect(['<root/>'], { maxChunkLength: 6 }), code('RESOURCE_LIMIT'));
  await assert.rejects(collect(['<r>', 'a'.repeat(20), '</r>'], { maxTokenLength: 10 }), code('RESOURCE_LIMIT'));
  await assert.rejects(collect(['<r a="', 'a'.repeat(20), '"/>'], { maxTokenLength: 10 }), code('RESOURCE_LIMIT'));
  await assert.rejects(collect(['<r/>'], { maxInputLength: 3 }), code('RESOURCE_LIMIT'));
  await assert.rejects(collect(['<r><c/></r>'], { maxDepth: 1 }), code('RESOURCE_LIMIT'));
  await assert.rejects(collect(['<r/>'], { maxBufferedEvents: 1 }), code('RESOURCE_LIMIT'));
  for (const options of [{ maxDepth: 0 }, { maxTokenLength: NaN }, null]) await assert.rejects(collect(['<r/>'], options), code('INVALID_ARGUMENT'));
  await assert.rejects(collect([new Uint8Array([60])]), code('INVALID_ARGUMENT'));
});

test('streaming delivers events before EOF and stops source pulls under backpressure', async () => {
  let pulls = 0;
  let cleaned = false;
  async function* source() {
    try { pulls++; yield '<root>'; pulls++; yield '<child/>'; pulls++; yield '</root>'; }
    finally { cleaned = true; }
  }
  const iterator = streamXml(source());
  assert.equal((await iterator.next()).value.type, 'startElement');
  assert.equal(pulls, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pulls, 1);
  await iterator.return();
  assert.equal(cleaned, true);
  assert.equal(pulls, 1);
});

test('streaming cleans input sources after parse errors and reports source failures', async () => {
  let cleaned = false;
  async function* source() { try { yield '<r>'; yield '</wrong>'; } finally { cleaned = true; } }
  await assert.rejects(collect(source()), code('MALFORMED_XML'));
  assert.equal(cleaned, true);
  const failure = new Error('source failed');
  await assert.rejects(collect({ async *[Symbol.asyncIterator]() { throw failure; } }), error => error.code === 'SOURCE_ERROR' && error.cause === failure);
});

test('streaming abort rejects pending source reads and requests cleanup without hanging', async () => {
  const controller = new AbortController();
  let cleaned = false;
  const source = { [Symbol.asyncIterator]() { return {
    next: () => new Promise(() => {}), return: () => { cleaned = true; return new Promise(() => {}); },
  }; } };
  const pending = collect(source, { signal: controller.signal });
  controller.abort('cancelled');
  await assert.rejects(pending, error => error.code === 'ABORTED' && error.cause === 'cancelled');
  assert.equal(cleaned, true);
  const before = new AbortController(); before.abort();
  await assert.rejects(collect(['<r/>'], { signal: before.signal }), code('ABORTED'));
  const paused = new AbortController();
  const iterator = streamXml(['<r/>'], { signal: paused.signal });
  assert.equal((await iterator.next()).value.type, 'startElement');
  paused.abort();
  await assert.rejects(iterator.next(), code('ABORTED'));
});

test('streaming consumes an original large repeated-record fixture without retaining its events', async context => {
  const item = '<i a="x">😀 &amp; value</i>';
  const chunk = item.repeat(100);
  let pulls = 0;
  function* source() { yield '<r>'; for (let index = 0; index < 1000; index++) { pulls++; yield chunk; } yield '</r>'; }
  const started = performance.now();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  let count = 0;
  for await (const event of streamXml(source())) {
    count++;
    if (count % 10_000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
    if (event.type === 'text') assert.equal(event.value, '😀 & value');
  }
  assert.equal(count, 300_002);
  assert.equal(pulls, 1000);
  context.diagnostic(`Original 100000-record fixture: ${Buffer.byteLength(item) * 100000} UTF-8 bytes, ${(performance.now() - started).toFixed(1)} ms, sampled RSS baseline ${(baseline / 2 ** 20).toFixed(1)} MiB, peak ${(peak / 2 ** 20).toFixed(1)} MiB. RSS is observational, not an asserted portable bound.`);
});
