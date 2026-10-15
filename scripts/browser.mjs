import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'xmlweave browser '));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this fixture through npm run test:browser.');
function npm(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.error ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

try {
  npm(['run', 'build']);
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]));
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', join(temporary, packed[0].filename), 'xslt-processor@5.1.2', '--ignore-scripts', '--no-audit', '--no-fund'], temporary);
  const bundle = join(temporary, 'browser.js');
  await build({
    stdin: { contents: 'export * from "xmlweave"; export * from "xmlweave/xpath"; export * from "xmlweave/stream"; export * from "xmlweave/transform";', resolveDir: temporary },
    outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'XMLWeave',
    target: 'es2022',
  });
  const source = await readFile(bundle, 'utf8');
  const selected = (process.env.XMLWEAVE_BROWSERS ?? 'chromium,firefox,webkit').split(',');
  const browsers = { chromium, firefox, webkit };
  for (const name of selected) {
    if (!browsers[name]) throw new Error(`Unknown browser: ${name}`);
    const browser = await browsers[name].launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(async () => {
        const { parseXml, createDocument, mutateXml, serializeXml, XmlError } = globalThis.XMLWeave;
        let assertions = 0;
        const assert = (condition, message) => {
          if (!condition) throw new Error(message);
          assertions++;
        };
        const doc = parseXml('<p:root xmlns:p="urn:root" xmlns:a="urn:attr" a:id="7"><p:item>before &amp; after</p:item></p:root>');
        assert(doc.documentElement.namespaceURI === 'urn:root', 'parsed element namespace');
        assert(doc.documentElement.getAttributeNS('urn:attr', 'id') === '7', 'parsed attribute namespace');
        assert(doc.documentElement.firstChild.textContent === 'before & after', 'decoded entity');
        const returned = mutateXml(doc, document => {
          const child = document.createElementNS('urn:child', 'c:child');
          child.textContent = '<safe> & text';
          document.documentElement.appendChild(child);
        });
        assert(returned === doc, 'mutation returns original document');
        const restored = parseXml(serializeXml(doc));
        assert(restored.documentElement.lastChild.namespaceURI === 'urn:child', 'roundtrip generated namespace');
        assert(restored.documentElement.lastChild.textContent === '<safe> & text', 'roundtrip escaped text');
        assert(restored.documentElement.getAttributeNS('urn:attr', 'id') === '7', 'roundtrip attribute');
        const created = createDocument('urn:created', 'n:created');
        created.documentElement.appendChild(created.createTextNode('hello'));
        const createdAgain = parseXml(serializeXml(created));
        assert(createdAgain.documentElement.namespaceURI === 'urn:created', 'created document namespace');
        assert(createdAgain.documentElement.textContent === 'hello', 'created document content');
        for (const invalid of ['<root>', '<a/><b/>', '<root>&unknown;</root>', '<!DOCTYPE root><root/>', '<!DOCTYPE root SYSTEM "https://example.invalid/evil.dtd"><root/>', '<!DOCTYPE root [<!ENTITY x "expanded">]><root>&x;</root>']) {
          let caught;
          try { parseXml(invalid); } catch (error) { caught = error; }
          assert(caught instanceof XmlError, `XmlError for ${invalid}`);
        }
        const { evaluateXPathToNodes, evaluateXPathToNumber, evaluateXPathToString, XPathError, streamXml, XmlStreamError, compileStylesheet, TransformError } = globalThis.XMLWeave;
        const selected = evaluateXPathToNodes('//q:item', doc, { namespaces: { q: 'urn:root' } });
        assert(selected[0] === doc.documentElement.firstChild, 'XPath preserves core DOM identity');
        assert(evaluateXPathToNumber('count(//q:item) + $n', doc, { namespaces: { q: 'urn:root' }, variables: { n: 3 } }) === 4, 'XPath namespace/variables');
        assert(evaluateXPathToString('string(map {"key": 7}?key)', doc) === '7', 'XPath 3.1 map');
        let queryError;
        try { evaluateXPathToString('doc("https://example.invalid")', doc); } catch (error) { queryError = error; }
        assert(queryError instanceof XPathError && queryError.code === 'UNSUPPORTED_FEATURE', 'XPath external function denied');
        const events = [];
        for await (const event of streamXml(['<p:r xmlns:p="urn:s">', 'A&am', 'p;B<p:c/>', '</p:r>'])) events.push(event);
        assert(events[0].namespaceURI === 'urn:s', 'stream namespace');
        assert(events.filter(event => event.type === 'text').map(event => event.value).join('') === 'A&B', 'stream chunked entity');
        assert(events.filter(event => event.type === 'startElement').length === 2, 'stream events');
        let streamError;
        try { for await (const event of streamXml(['<!DOC', 'TYPE r><r/>'])) void event; } catch (error) { streamError = error; }
        assert(streamError instanceof XmlStreamError && streamError.code === 'DTD_FORBIDDEN', 'stream DTD rejected across chunks');
        const style = await compileStylesheet('<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"><xsl:param name="label"/><xsl:template match="/"><out><xsl:value-of select="$label"/><xsl:value-of select="/r"/></out></xsl:template></xsl:stylesheet>');
        const transformed = parseXml(await style.transform('<r>A&amp;B</r>', { parameters: { label: 'hello ' } }));
        assert(transformed.documentElement.textContent === 'hello A&B', 'transformation parameters and escaping');
        style.dispose();
        assert(style.disposed, 'stylesheet disposal');
        let external;
        try { await compileStylesheet('<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"><xsl:include href="https://example.invalid"/></xsl:stylesheet>'); } catch (error) { external = error; }
        assert(external instanceof TransformError && external.code === 'EXTERNAL_RESOURCE_FORBIDDEN', 'stylesheet loading denied');
        return { assertions };
      });
      console.log(`${name}: ${result.assertions} packed-artifact browser assertions passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
