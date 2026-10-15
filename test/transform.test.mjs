import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStylesheet, transformXml, TransformError } from '../dist/transform.js';
import { parseXml } from '../dist/index.js';

const stylesheet = (body, output = '') => `<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">${output}${body}</xsl:stylesheet>`;
const catalog = stylesheet(`<xsl:param name="label"/><xsl:param name="increment"/><xsl:template match="/"><result><title><xsl:value-of select="$label"/></title><xsl:for-each select="/catalog/item"><entry id="{@id}"><xsl:value-of select="number(.) + $increment"/></entry></xsl:for-each></result></xsl:template>`);
const failure = code => error => error instanceof TransformError && error.code === code;

test('XSLT transforms scalar parameters, for-each and attribute value templates', async () => {
  const prepared = await compileStylesheet(catalog);
  const result = parseXml(await prepared.transform('<catalog><item id="one">3</item><item id="two">7</item></catalog>', { parameters: { label: '<safe> & true', increment: 2 } }));
  assert.equal(result.documentElement.firstChild.textContent, '<safe> & true');
  assert.equal(result.documentElement.childNodes[1].getAttribute('id'), 'one');
  assert.equal(result.documentElement.childNodes[1].textContent, '5');
  assert.equal(result.documentElement.lastChild.textContent, '9');
  const again = parseXml(await prepared.transform('<catalog/>', { parameters: { label: 'fresh', increment: 4 } }));
  assert.equal(again.documentElement.textContent, 'fresh');
  assert.equal(prepared.disposed, false);
  prepared.dispose(); prepared.dispose();
  assert.equal(prepared.disposed, true);
  await assert.rejects(prepared.transform('<r/>'), failure('DISPOSED'));
});
test('namespaces, templates, conditionals, escaped text and text output', async () => {
  const style = stylesheet(`<xsl:template match="/"><out xmlns="urn:out"><xsl:apply-templates select="/r/item"/></out></xsl:template><xsl:template match="item"><value><xsl:choose><xsl:when test="@yes = '1'"><xsl:value-of select="."/></xsl:when><xsl:otherwise><xsl:text>none</xsl:text></xsl:otherwise></xsl:choose></value></xsl:template>`);
  const doc = parseXml(await transformXml('<r><item yes="1">A&amp;B</item><item/></r>', style));
  assert.equal(doc.documentElement.namespaceURI, 'urn:out');
  assert.equal(doc.documentElement.firstChild.textContent, 'A&B');
  assert.equal(doc.documentElement.lastChild.textContent, 'none');
  const text = stylesheet('<xsl:template match="/"><xsl:value-of select="/r"/></xsl:template>', '<xsl:output method="text"/>');
  assert.equal(await transformXml('<r>hello &amp; goodbye</r>', text), 'hello & goodbye');
});

test('scoped namespace prefixes are normalized and ambiguous bindings never lose data silently', async () => {
  const local = stylesheet('<xsl:template xmlns:p="urn:p" match="/"><out><xsl:value-of select="/p:r/p:c"/></out></xsl:template>');
  assert.equal(parseXml(await transformXml('<p:r xmlns:p="urn:p"><p:c>found</p:c></p:r>', local)).documentElement.textContent, 'found');
  const rebound = stylesheet('<xsl:template xmlns:p="urn:p" match="/"><out xmlns:p="urn:other"><xsl:value-of select="/p:r"/></out></xsl:template>');
  await assert.rejects(compileStylesheet(rebound), failure('UNSUPPORTED_FEATURE'));
  await assert.rejects(compileStylesheet(stylesheet('<xsl:template match="/"><out><xsl:value-of select="/missing:r"/></out></xsl:template>')), failure('INVALID_STYLESHEET'));
  await assert.rejects(compileStylesheet(stylesheet('<xsl:output method="xml"/><xsl:output method="text"/>')), failure('UNSUPPORTED_FEATURE'));
});
test('external stylesheets, document functions, extensions and DTDs fail before execution', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  try {
    for (const instruction of ['include', 'import', 'result-document']) await assert.rejects(compileStylesheet(stylesheet(`<xsl:${instruction} href="https://example.invalid/evil"/>`)), failure('EXTERNAL_RESOURCE_FORBIDDEN'));
    for (const expression of ["document('file:///etc/passwd')", "document ( 'https://example.invalid' )", "doc('x')"]) await assert.rejects(compileStylesheet(stylesheet(`<xsl:template match="/"><xsl:value-of select="${expression}"/></xsl:template>`)), failure('EXTERNAL_RESOURCE_FORBIDDEN'));
    await assert.rejects(compileStylesheet(stylesheet('<xsl:template match="/"><out value="{document(\'evil\')}"/></xsl:template>')), failure('EXTERNAL_RESOURCE_FORBIDDEN'));
    await assert.rejects(compileStylesheet(stylesheet('<xsl:template match="/"><xsl:value-of xmlns:e="urn:extension" select="e:exec()"/></xsl:template>')), failure('UNSUPPORTED_FEATURE'));
    await assert.rejects(compileStylesheet('<!DOCTYPE x><x/>'), failure('INVALID_STYLESHEET'));
    const compiled = await compileStylesheet(catalog);
    try { await assert.rejects(compiled.transform('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///x">]><r>&x;</r>'), failure('INVALID_XML')); }
    finally { compiled.dispose(); }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('errors, subset limits, output validation and cooperative cancellation are explicit', async () => {
  await assert.rejects(compileStylesheet(stylesheet('<xsl:template match="/"/>').replace('version="1.0"', 'version="3.0"')), failure('UNSUPPORTED_FEATURE'));
  await assert.rejects(compileStylesheet(stylesheet('<xsl:output method="xml" doctype-system="x"/>')), failure('UNSUPPORTED_FEATURE'));
  await assert.rejects(compileStylesheet(stylesheet('<xsl:template match="/"><xsl:value-of select="/r" disable-output-escaping="yes"/></xsl:template>')), failure('UNSUPPORTED_FEATURE'));
  const identity = stylesheet('<xsl:template match="/"><out><xsl:value-of select="/r"/></out></xsl:template>');
  await assert.rejects(transformXml('<r>123456</r>', identity, { maxOutputLength: 4 }), failure('RESOURCE_LIMIT'));
  await assert.rejects(transformXml('<r/>', identity, { maxOutputLength: 0 }), failure('INVALID_ARGUMENT'));
  await assert.rejects(transformXml('<r/>', identity, { parameters: { x: Infinity } }), failure('INVALID_ARGUMENT'));
  await assert.rejects(transformXml('<r/>', identity, { signal: { aborted: true } }), failure('ABORTED'));
  await assert.rejects(transformXml('<r>', identity), failure('INVALID_XML'));
  await assert.rejects(transformXml('<r/>', stylesheet('<xsl:template match="/"><a/><b/></xsl:template>')), failure('TRANSFORM_FAILED'));
  // Literal strings and escaped AVT braces do not accidentally request document loading.
  assert.ok(await transformXml('<r/>', stylesheet(`<xsl:template match="/"><out literal="{{document('literal')}}"><xsl:value-of select="&quot;document('literal')&quot;"/></out></xsl:template>`)));
});
