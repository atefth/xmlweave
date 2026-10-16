import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSource } from '../dist/schema-pipeline.js';
import { SchemaError } from '../dist/schema.js';

function provider(systemId) {
  return {
    disposed: false,
    dispose() { this.disposed = true; },
    async validate() { throw new Error('Streaming provider expected'); },
    async *validateStream(chunks, options) {
      for await (const _chunk of chunks) { }
      const diagnostic = { phase: 'validate', severity: 'error', message: 'Invalid sample', ...(systemId === undefined ? {} : { systemId }) };
      options.onDiagnostic?.(diagnostic);
      await options.diagnosticHandler?.(diagnostic);
      if (options.errorPolicy === 'throw') throw new SchemaError('INVALID_XML', 'Invalid sample', [diagnostic]);
      yield { kind: 'diagnostic', diagnostic };
      yield { kind: 'result', result: { valid: false, diagnostics: [diagnostic] } };
    },
  };
}

for (const [description, source, engineId, expected] of [
  ['plain string falls back to pipeline identity', '<r/>', undefined, 'urn:pipeline'],
  ['source identity overrides pipeline fallback', { kind: 'text', text: '<r/>', systemId: 'urn:source' }, undefined, 'urn:source'],
  ['engine diagnostic identity is retained', '<r/>', 'urn:engine', 'urn:engine'],
]) {
  test(description + ' in results, observers and exact handlers', async () => {
    const observed = [], handled = [];
    const output = await validateSource(provider(engineId), { family: 'stream', source }, 'none', {
      systemId: 'urn:pipeline',
      onDiagnostic: diagnostic => observed.push(diagnostic),
      diagnosticHandler: diagnostic => { handled.push(diagnostic); },
    });
    assert.equal(output.result.diagnostics[0].systemId, expected);
    assert.equal(observed[0].systemId, expected);
    assert.equal(handled[0].systemId, expected);
  });
  test(description + ' in thrown diagnostics', async () => {
    await assert.rejects(validateSource(provider(engineId), { family: 'stream', source }, 'none', {
      systemId: 'urn:pipeline', errorPolicy: 'throw',
    }), error => {
      assert.equal(error.code, 'INVALID_XML');
      assert.equal(error.diagnostics[0].systemId, expected);
      return true;
    });
  });
}
