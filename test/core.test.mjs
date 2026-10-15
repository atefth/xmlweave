import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, createDocument, serializeXml, mutateXml, XmlError } from '../dist/index.js';

function error(code, operation) {
  return (value) => {
    assert.ok(value instanceof XmlError);
    assert.equal(value.code, code);
    assert.equal(value.operation, operation);
    return true;
  };
}

test('parsing rejects malformed XML and namespace violations consistently', () => {
  for (const input of ['', '<r>', '<r/><s/>', '<p:r/>', '<r a="1" a="2"/>', '<r>&unknown;</r>', '<r>&#0;</r>', '<r>\u0000</r>', '<r xmlns:xml="urn:wrong"/>']) {
    assert.throws(() => parseXml(input), error('MALFORMED_XML', 'parse'), JSON.stringify(input));
  }
  assert.throws(() => parseXml(null), error('INVALID_ARGUMENT', 'parse'));
});

test('namespace-aware creation and mutation preserve semantic content on roundtrip', () => {
  const doc = createDocument('urn:root', 'r:root');
  const same = mutateXml(doc, (document) => {
    const item = document.createElementNS('urn:item', 'i:item');
    item.setAttributeNS('urn:attribute', 'a:key', '<&"');
    item.appendChild(document.createTextNode('😀 & < >'));
    document.documentElement.appendChild(item);
    document.documentElement.appendChild(document.createComment('tail'));
  });
  assert.equal(same, doc);
  const copy = parseXml(serializeXml(doc));
  assert.equal(copy.documentElement.namespaceURI, 'urn:root');
  assert.equal(copy.documentElement.firstChild.namespaceURI, 'urn:item');
  assert.equal(copy.documentElement.firstChild.getAttributeNS('urn:attribute', 'key'), '<&"');
  assert.equal(copy.documentElement.firstChild.textContent, '😀 & < >');
  assert.equal(copy.documentElement.lastChild.nodeType, 8);
});

test('predefined and numeric entities decode without DTD support', () => {
  assert.equal(parseXml('<r>&lt;&gt;&amp;&apos;&quot;&#65;&#x1F600;</r>').documentElement.textContent, '<>&\'"A😀');
});

test('all actual DTDs fail before entity processing', () => {
  for (const input of [
    '<!DOCTYPE r><r/>',
    '<!DOCTYPE r SYSTEM "file:///does-not-exist"><r/>',
    '<!DOCTYPE r [<!ENTITY x SYSTEM "https://invalid.example/entity">]><r>before&x;after</r>',
    '<!DOCTYPE r [<!ENTITY x "replacement">]><r>&x;</r>',
  ]) assert.throws(() => parseXml(input), error('DTD_FORBIDDEN', 'parse'));
});

test('DTD-looking text in comments, CDATA and processing instructions is data', () => {
  const input = '<!-- <!DOCTYPE fake> --><?probe <!DOCTYPE fake>?><r><![CDATA[<!DOCTYPE fake><x><y>]]></r>';
  assert.equal(parseXml(input).documentElement.textContent, '<!DOCTYPE fake><x><y>');
});

test('input length, nesting and total nodes are bounded', () => {
  assert.throws(() => parseXml('<r/>', { maxLength: 3 }), error('RESOURCE_LIMIT', 'parse'));
  assert.equal(parseXml('<r/>', { maxLength: 4 }).documentElement.localName, 'r');
  assert.throws(() => parseXml('<r><a><b/></a></r>', { maxDepth: 2 }), error('RESOURCE_LIMIT', 'parse'));
  assert.ok(parseXml('<r><a/></r>', { maxDepth: 2 }));
  assert.throws(() => parseXml('<r><a/><b/><c/></r>', { maxNodes: 3 }), error('RESOURCE_LIMIT', 'parse'));
  assert.throws(() => parseXml('<r>' + '<a>'.repeat(257) + '</a>'.repeat(257) + '</r>'), error('RESOURCE_LIMIT', 'parse'));
});

test('callers can only lower valid positive integer limits', () => {
  for (const options of [{ maxLength: 0 }, { maxLength: 1000001 }, { maxDepth: 257 }, { maxNodes: 100001 }, { maxDepth: 1.5 }, { maxNodes: NaN }]) {
    assert.throws(() => parseXml('<r/>', options), error('INVALID_ARGUMENT', 'parse'));
  }
});

test('serialization rejects invalid trees and observes output resource limits', () => {
  const doc = parseXml('<r/>');
  assert.throws(() => serializeXml(doc, { maxLength: 3 }), error('RESOURCE_LIMIT', 'serialize'));
  const nested = doc.createElement('child');
  nested.appendChild(doc.createElement('grandchild'));
  doc.documentElement.appendChild(nested);
  assert.throws(() => serializeXml(doc, { maxDepth: 2 }), error('RESOURCE_LIMIT', 'serialize'));
  assert.throws(() => serializeXml(doc, { maxNodes: 2 }), error('RESOURCE_LIMIT', 'serialize'));
  doc.documentElement.appendChild(doc.createTextNode('\u0000'));
  assert.throws(() => serializeXml(doc), error('INVALID_DOCUMENT', 'serialize'));
});

test('mutation normalizes callback failures and does not imply transaction rollback', () => {
  const doc = parseXml('<r/>');
  const cause = new Error('failed user edit');
  assert.throws(() => mutateXml(doc, (document) => {
    document.documentElement.setAttribute('edited', 'yes');
    throw cause;
  }), (value) => {
    error('MUTATION_FAILED', 'mutate')(value);
    assert.equal(value.cause, cause);
    return true;
  });
  assert.equal(doc.documentElement.getAttribute('edited'), 'yes');
});

test('creation validates namespace/root combinations and empty documents need a root', () => {
  assert.throws(() => createDocument('urn:root'), error('INVALID_ARGUMENT', 'create'));
  assert.throws(() => createDocument(null, 'p:root'), error('INVALID_ARGUMENT', 'create'));
  assert.throws(() => createDocument(null, ''), error('INVALID_ARGUMENT', 'create'));
  const empty = createDocument();
  assert.throws(() => serializeXml(empty), error('INVALID_DOCUMENT', 'serialize'));
  empty.appendChild(empty.createElement('root'));
  assert.equal(parseXml(serializeXml(empty)).documentElement.localName, 'root');
});

test('mutation rejects asynchronous callbacks and invalid final documents', () => {
  assert.throws(() => mutateXml(parseXml('<r/>'), () => Promise.resolve()), error('INVALID_ARGUMENT', 'mutate'));
  assert.throws(() => mutateXml(parseXml('<r/>'), (doc) => doc.removeChild(doc.documentElement)), error('INVALID_DOCUMENT', 'mutate'));
});

test('DOM-added doctypes are forbidden and node accounting includes attributes', () => {
  const doc = createDocument();
  doc.appendChild(doc.implementation.createDocumentType('r', '', ''));
  doc.appendChild(doc.createElement('r'));
  assert.throws(() => serializeXml(doc), error('DTD_FORBIDDEN', 'serialize'));
  assert.throws(() => parseXml('<r a="1" b="2"/>', { maxNodes: 3 }), error('RESOURCE_LIMIT', 'parse'));
  assert.ok(parseXml('<r a="1"/>', { maxNodes: 3 }));
});
