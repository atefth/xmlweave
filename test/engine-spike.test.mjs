import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as slimdom from 'slimdom';
import { DOMParser } from '@xmldom/xmldom';

test('slimdom strictly rejects malformed documents and namespaces', () => {
  for (const xml of ['', '<r>', '<a/><b/>', '<p:r/>', '<r a="1" a="2"/>', '<r>&missing;</r>', '<r>&#0;</r>']) {
    assert.throws(() => slimdom.parseXmlDocument(xml), xml);
  }
});
test('slimdom supports namespace-aware mutation and semantic roundtrip', () => {
  const doc = slimdom.parseXmlDocument('<r xmlns="urn:r"><p:c xmlns:p="urn:c">a&amp;b</p:c></r>');
  const child = doc.createElementNS('urn:x', 'x:item');
  child.setAttributeNS('urn:a', 'a:key', '<&"');
  doc.documentElement.appendChild(child);
  const copy = slimdom.parseXmlDocument(slimdom.serializeToWellFormedString(doc));
  assert.equal(copy.documentElement.namespaceURI, 'urn:r');
  assert.equal(copy.documentElement.lastChild.namespaceURI, 'urn:x');
  assert.equal(copy.documentElement.lastChild.getAttributeNS('urn:a', 'key'), '<&"');
  assert.equal(copy.documentElement.firstChild.textContent, 'a&b');
});
test('slimdom silently drops external entities: a mandatory preflight is required', () => {
  const xml = '<!DOCTYPE r [<!ENTITY x SYSTEM "https://invalid.example/entity">]><r>before&x;after</r>';
  assert.equal(slimdom.parseXmlDocument(xml).documentElement.textContent, 'beforeafter');
});
test('xmldom 0.9.12 rejects mismatched tags but still recovers unknown entities', () => {
  const diagnostics = [];
  const parser = new DOMParser({ onError: (level, message) => diagnostics.push({ level, message }) });
  assert.throws(() => parser.parseFromString('<r><a></r>', 'application/xml'));
  const doc = parser.parseFromString('<r>&missing;</r>', 'application/xml');
  assert.ok(diagnostics.some(({ level }) => level === 'error'));
  assert.equal(doc.documentElement.textContent, '&missing;');
});

test('xmldom 0.9.12 accepts an XML-forbidden character reference without diagnostics', () => {
  const diagnostics = [];
  const doc = new DOMParser({ onError: (...args) => diagnostics.push(args) }).parseFromString('<r>&#0;</r>', 'application/xml');
  assert.equal(doc.documentElement.textContent, '\u0000');
  assert.deepEqual(diagnostics, []);
});
