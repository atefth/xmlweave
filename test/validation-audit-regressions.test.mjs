import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema, SchemaError } from '../dist/schema.js';
import { parseXml } from '../dist/index.js';
import { compileXercesSchema } from '../dist/schema-xerces.js';
import { createHintValidator } from '../dist/schema-hints.js';
import { validateSource } from '../dist/schema-pipeline.js';

const xsd = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:int"/></xs:schema>';
const instance = '<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:audit:xsd">2</r>';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function pendingSource() {
  const entered = gate();
  let closed = false;
  return {
    entered: entered.promise,
    get closed() { return closed; },
    source: { kind: 'chunks', chunks: { [Symbol.asyncIterator]() {
      return {
        next() { entered.resolve(); return new Promise(() => {}); },
        return() { closed = true; return { done: true }; },
      };
    } } },
  };
}
function handle() {
  return { disposed: false, dispose() { this.disposed = true; },
    async validate() { return { valid: true, diagnostics: [] }; } };
}

test('default compilation and sessions abort pending producers and close them', { timeout: 3000 }, async () => {
  const source = pendingSource(), compileSignal = { aborted: false };
  const compilation = compileSchema(source.source, { signal: compileSignal });
  const compileRejected = assert.rejects(compilation, { code: 'ABORTED' });
  await source.entered;
  compileSignal.aborted = true;
  await compileRejected;
  assert.equal(source.closed, true);

  const grammar = await compileSchema(xsd), session = grammar.createValidator();
  try {
    const input = pendingSource(), signal = { aborted: false };
    const validation = session.validate(input.source, { signal });
    const rejected = assert.rejects(validation, { code: 'ABORTED' });
    await input.entered;
    signal.aborted = true;
    await rejected;
    assert.equal(input.closed, true);
    assert.equal(session.busy, false);
    assert.equal((await session.validate('<r>2</r>')).valid, true);
  } finally { session.dispose(); grammar.dispose(); }
});

for (const phase of ['resolver', 'compiler']) {
  test(`one hint caller abort does not cancel shared ${phase}`, { timeout: 3000 }, async () => {
    const entered = gate(), release = gate();
    let calls = 0;
    const validator = await createHintValidator({
      ...(phase === 'compiler' ? { resourceMap: { 'urn:audit:xsd': xsd } } : {}),
      resolver: async () => {
        calls++; entered.resolve(); await release.promise; return xsd;
      },
      compiler: async () => {
        if (phase === 'compiler') { calls++; entered.resolve(); await release.promise; }
        return handle();
      },
    });
    try {
      const signal = { aborted: false };
      const first = validator.validate(instance, { signal });
      const rejected = assert.rejects(first, { code: 'ABORTED' });
      await entered.promise;
      const second = validator.validate(instance);
      await delay(10);
      signal.aborted = true;
      await rejected;
      release.resolve();
      assert.equal((await second).valid, true);
      assert.equal(calls, 1);
    } finally { release.resolve(); validator.dispose(); }
  });
}

test('queued hint caller replaces a handle cancelled by an earlier episode', { timeout: 3000 }, async () => {
  const entered = gate();
  let compiles = 0;
  const validator = await createHintValidator({
    resourceMap: { 'urn:audit:xsd': xsd },
    compiler: async () => {
      compiles++;
      const compiled = handle();
      if (compiles === 1) compiled.validate = async (_source, options) => {
        entered.resolve();
        while (!options.signal.aborted) await delay(2);
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      };
      return compiled;
    },
  });
  try {
    const signal = { aborted: false };
    const first = validator.validate(instance, { signal });
    const rejected = assert.rejects(first, { code: 'ABORTED' });
    await entered.promise;
    const second = validator.validate(instance);
    await delay(10);
    signal.aborted = true;
    await rejected;
    assert.equal((await second).valid, true);
    assert.equal(compiles, 2);
  } finally { validator.dispose(); }
});

test('pipeline validates options before reading and retains fallback source identity', async () => {
  const provider = await compileXercesSchema(xsd);
  try {
    let reads = 0;
    await assert.rejects(validateSource(provider, { family: 'stream', source: {
      kind: 'chunks', chunks: { *[Symbol.iterator]() { reads++; yield '<r>2</r>'; } },
    } }, 'none', { namespacePrefixes: 'invalid' }), { code: 'INVALID_ARGUMENT' });
    assert.equal(reads, 0);
    const result = await validateSource(provider, { family: 'stream', source: '<r>bad</r>' }, 'none', { systemId: 'urn:audit:instance' });
    assert.equal(result.result.valid, false);
    assert.ok(result.result.diagnostics.length);
    assert.ok(result.result.diagnostics.every(d => d.systemId === 'urn:audit:instance'));
    const explicit = await validateSource(provider, { family: 'stream', source: { kind: 'text', text: '<r>bad</r>', systemId: 'urn:audit:explicit' } }, 'none', { systemId: 'urn:audit:fallback' });
    assert.ok(explicit.result.diagnostics.every(d => d.systemId === 'urn:audit:explicit'));
    await assert.rejects(validateSource(provider, { family: 'dom', node: parseXml('<r>bad</r>'), systemId: 'urn:audit:dom' }, 'none', { errorPolicy: 'throw' }), error => {
      assert.equal(error.code, 'INVALID_XML');
      assert.ok(error.diagnostics.length);
      assert.ok(error.diagnostics.every(d => d.sourceKind === 'dom' && d.provenance === 'generated' && d.systemId === 'urn:audit:dom'));
      return true;
    });
    const sentinel = new SchemaError('INVALID_XML', 'Caller diagnostic exception');
    const callbackProvider = await compileXercesSchema(xsd);
    try {
      await assert.rejects(validateSource(callbackProvider, { family: 'dom', node: parseXml('<r>bad</r>') }, 'none', { onDiagnostic() { throw sentinel; } }), error => error === sentinel);
    } finally { callbackProvider.dispose(); }
  } finally { provider.dispose(); }
});
