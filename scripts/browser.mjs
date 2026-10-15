import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'xmlweave-browser-'));
function npm(args, cwd = root) {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', windows ? args.map(arg => `"${arg}"`) : args, {
    cwd, encoding: 'utf8', shell: windows,
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
  npm(['install', join(temporary, packed[0].filename), '--ignore-scripts', '--no-audit', '--no-fund'], temporary);
  const bundle = join(temporary, 'browser.js');
  await build({
    stdin: { contents: 'export * from "xmlweave";', resolveDir: temporary },
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
      const result = await page.evaluate(() => {
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
