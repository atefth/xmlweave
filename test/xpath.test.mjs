import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, createDocument, mutateXml, serializeXml } from '../dist/index.js';
import {
  evaluateXPath, evaluateXPathToNodes, evaluateXPathToFirstNode, evaluateXPathToString,
  evaluateXPathToNumber, evaluateXPathToBoolean, XPathError,
} from '../dist/xpath.js';

const fails = code => error => error instanceof XPathError && error.code === code;

test('XPath reads parsed, created and mutated XMLWeave documents without copying nodes', () => {
  const parsed = parseXml('<catalog><book id="1">XML</book><book id="2">Queries</book></catalog>');
  const books = evaluateXPath('/catalog/book', parsed);
  assert.equal(books.length, 2);
  assert.equal(books[0], parsed.documentElement.firstChild);
  assert.equal(evaluateXPathToFirstNode('./book[@id="2"]', parsed.documentElement), books[1]);
  assert.equal(evaluateXPathToFirstNode('//missing', parsed), null);
  assert.equal(evaluateXPathToString('string(/catalog/book[1])', parsed), 'XML');
  assert.equal(evaluateXPathToNumber('count(/catalog/book)', parsed), 2);
  assert.equal(evaluateXPathToBoolean('exists(/catalog/book)', parsed), true);
  assert.equal(evaluateXPath('count(/catalog/book)', parsed, { returnType: 'number' }), 2);
  const created = createDocument(null, 'root');
  mutateXml(created, document => {
    const child = document.createElement('value');
    child.textContent = '42';
    document.documentElement.appendChild(child);
  });
  assert.equal(evaluateXPathToNumber('number(/root/value)', created), 42);
  assert.equal(evaluateXPathToString('string(.)', created.documentElement.firstChild.firstChild), '42');
});

test('namespace context is explicit and independent of document prefixes', () => {
  const doc = parseXml('<r xmlns="urn:catalog" xmlns:a="urn:attr"><book a:id="7"/></r>');
  const options = { namespaces: { c: 'urn:catalog', meta: 'urn:attr' } };
  assert.equal(evaluateXPathToString('string(/c:r/c:book/@meta:id)', doc, options), '7');
  assert.equal(evaluateXPathToNodes('/r/book', doc).length, 0);
  assert.equal(evaluateXPathToNodes('/r/book', doc, { namespaces: { '': 'urn:catalog' } }).length, 1);
  assert.equal(evaluateXPathToNumber('count(/Q{urn:catalog}r/Q{urn:catalog}book)', doc), 1);
  assert.throws(() => evaluateXPathToNodes('/unknown:r', doc), fails('EVALUATION_FAILED'));
});

test('scalar variables preserve query boundaries and null means an empty sequence', () => {
  const doc = parseXml('<r><value>a&apos; or true() or &apos;b</value></r>');
  assert.equal(evaluateXPathToBoolean('/r/value = $needle', doc, { variables: { needle: "a' or true() or 'b" } }), true);
  assert.equal(evaluateXPathToNumber('$n + 2', doc, { variables: { n: 3 } }), 5);
  assert.equal(evaluateXPathToBoolean('$enabled', doc, { variables: { enabled: false } }), false);
  assert.equal(evaluateXPathToNumber('count($empty)', doc, { variables: { empty: null } }), 0);
  assert.throws(() => evaluateXPathToString('$missing', doc), fails('EVALUATION_FAILED'));
});

test('measured XPath 3.1 subset supports sequences, maps, arrays, functions and arrow syntax', () => {
  const doc = parseXml('<r/>');
  assert.equal(evaluateXPathToNumber('sum(for $x in (1, 2, 3) return $x * 2)', doc), 12);
  assert.equal(evaluateXPathToNumber('map { "answer": 42 }?answer', doc), 42);
  assert.equal(evaluateXPathToNumber('array:size([1, 2, 3])', doc), 3);
  assert.equal(evaluateXPathToString('("a", "b") => string-join("-")', doc), 'a-b');
  assert.equal(evaluateXPathToNumber('math:pi()', doc), Math.PI);
  assert.equal(evaluateXPathToNumber('(function($x) { $x + 1 })(4)', doc), 5);
});

test('query errors retain causes and result type mismatches fail', () => {
  const doc = parseXml('<r/>');
  for (const expression of ['//*[', 'unimplemented-function()', 'insert node <x/> into /r', '<created/>']) {
    assert.throws(() => evaluateXPath(expression, doc), error => fails('EVALUATION_FAILED')(error) && error.cause instanceof Error);
  }
  assert.throws(() => evaluateXPath('42', doc), fails('EVALUATION_FAILED'));
  assert.throws(() => evaluateXPath('/r', doc, { returnType: 'map' }), fails('INVALID_ARGUMENT'));
});

test('AST policy blocks I/O, extension execution, named references and indirect lookup', () => {
  const doc = parseXml('<r/>');
  const before = serializeXml(doc);
  for (const expression of [
    'doc("https://invalid.example/xml")', 'fn:doc#1',
    'Q{http://www.w3.org/2005/xpath-functions}doc("file:///private")',
    'unparsed-text("file:///private")', 'environment-variable("SECRET")',
    'trace(1, "side effect")', 'parse-xml("<x/>")',
    'function-lookup(QName("urn:custom", "run"), 0)()',
    'Q{http://fontoxml.com/fontoxpath}evaluate("1 + 1")',
    'if (false()) then doc("file:///private") else /r',
    'let $f := QName("http://fontoxml.com/fontoxpath", "evaluate") => function-lookup(2) return $f("1 + 2", map {})',
    '"file:///private" => doc()',
    '"file:///private" => fn:doc()',
    '"file:///private" => Q{http://www.w3.org/2005/xpath-functions}doc()',
    'if (false()) then ("x" => trace("label")) else /r',
    'if (false()) then ("x" => fn:trace("label")) else /r',
    'if (false()) then ("x" => Q{http://www.w3.org/2005/xpath-functions}trace("label")) else /r',
    '"1 + 2" => Q{http://fontoxml.com/fontoxpath}evaluate(map {})',
    'let $f := function-lookup#2 return $f(QName("http://fontoxml.com/fontoxpath", "evaluate"), 2)',
    'let $f := fn:doc#1 return "file:///private" => $f()',
  ]) assert.throws(() => evaluateXPath(expression, doc), fails('UNSUPPORTED_FEATURE'), expression);
  assert.throws(() => evaluateXPath('custom:run()', doc, { namespaces: { custom: 'urn:custom' } }), fails('UNSUPPORTED_FEATURE'));
  assert.throws(() => evaluateXPath('"x" => custom:run()', doc, { namespaces: { custom: 'urn:custom' } }), fails('UNSUPPORTED_FEATURE'));
  assert.equal(serializeXml(doc), before);
  assert.equal(evaluateXPathToString('"doc( function-lookup trace"', doc), 'doc( function-lookup trace');
  assert.equal(evaluateXPathToNumber('(: doc("secret") (: nested :) :) count(/r)', doc), 1);
});

test('strict options and query-length bounds fail without running a query', () => {
  const doc = parseXml('<r/>');
  assert.throws(() => evaluateXPath('/r', doc, { maxQueryLength: 1 }), fails('RESOURCE_LIMIT'));
  assert.throws(() => evaluateXPath(' '.repeat(10000) + '/r', doc), fails('RESOURCE_LIMIT'));
  for (const maxQueryLength of [0, -1, 10001, 1.5, NaN, '10']) {
    assert.throws(() => evaluateXPath('/r', doc, { maxQueryLength }), fails('INVALID_ARGUMENT'));
  }
  for (const options of [null, [], { namespaces: [] }, { namespaces: { fn: 'urn:wrong' } }, { variables: { 'p:name': 1 } }, { variables: { n: Infinity } }, { variables: { node: doc } }]) {
    assert.throws(() => evaluateXPath('/r', doc, options), fails('INVALID_ARGUMENT'));
  }
  for (const context of [null, {}, 'text', 1]) assert.throws(() => evaluateXPath('/r', context), fails('INVALID_ARGUMENT'));
  assert.throws(() => evaluateXPath('', doc), fails('INVALID_ARGUMENT'));
  let getterRan = false;
  const options = Object.defineProperty({}, 'variables', { get() { getterRan = true; return {}; } });
  assert.throws(() => evaluateXPath('/r', doc, options), fails('INVALID_ARGUMENT'));
  assert.equal(getterRan, false);
});
