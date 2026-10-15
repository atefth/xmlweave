import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this fixture through npm run test:schema-browser.');
const temporary = await mkdtemp(join(tmpdir(), 'xmlweave schema browser '));
function npm(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.error ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}
let server;
try {
  npm(['run', 'build']);
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]));
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', join(temporary, packed[0].filename), 'libxml2-wasm@0.7.2', '--ignore-scripts', '--no-audit', '--no-fund'], temporary);
  const bundle = join(temporary, 'schema.mjs');
  await build({
    stdin: { contents: 'export * from "xmlweave/schema";', resolveDir: temporary },
    outfile: bundle, bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    external: ['libxml2-wasm'],
  });
  const source = await readFile(bundle);
  const unexpectedRequests = [];
  server = createServer(async (request, response) => {
    const path = request.url;
    try {
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><script type="importmap">{"imports":{"libxml2-wasm":"/engine/index.mjs"}}</script>');
      } else if (path === '/schema.mjs') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(source);
      } else if (/^\/engine\/[a-zA-Z0-9.-]+\.mjs$/.test(path ?? '')) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(join(temporary, 'node_modules/libxml2-wasm/lib', path.slice('/engine/'.length))));
      } else if (path === '/favicon.ico') {
        response.writeHead(204).end();
      } else {
        unexpectedRequests.push(path);
        response.writeHead(404).end();
      }
    } catch (error) {
      unexpectedRequests.push(`${path}: ${error.message}`);
      response.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engines = { chromium, firefox, webkit };
  for (const name of (process.env.XMLWEAVE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
    if (!engines[name]) throw new Error(`Unknown browser: ${name}`);
    const browser = await engines[name].launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== origin) {
          unexpectedRequests.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      await page.goto(origin);
      let timeout;
      try {
        const result = await Promise.race([
          page.evaluate(async () => {
            const { compileSchema, SchemaError, loadSchemaEngine } = await import('/schema.mjs');
            let assertions = 0;
            const assert = (condition, message) => { if (!condition) throw new Error(message); assertions++; };
            const rejects = async (action, code) => {
              let error;
              try { await action(); } catch (caught) { error = caught; }
              assert(error instanceof SchemaError && error.code === code, `Expected SchemaError ${code}, got ${error}`);
            };
            await loadSchemaEngine();
            const ns = 'http://www.w3.org/2001/XMLSchema';
            const text = `<s:schema xmlns:s="${ns}"><s:element name="count" type="s:int"/></s:schema>`;
            const schema = await compileSchema(text);
            try {
              assert(!schema.disposed, 'new schema is live');
              assert((await schema.validate('<count>3</count>')).valid, 'valid instance');
              const invalid = await schema.validate('<count>bad</count>');
              assert(!invalid.valid, 'invalid instance');
              assert(invalid.diagnostics.length > 0 && invalid.diagnostics[0].message.length > 0, 'structured diagnostics');
              assert(invalid.diagnostics[0].severity === 'error', 'diagnostic severity');
              await rejects(() => schema.validate('<count>'), 'INVALID_XML');
              await rejects(() => schema.validate('<!DOCTYPE count SYSTEM "https://example.invalid/evil.dtd"><count>3</count>'), 'INVALID_XML');
              await rejects(() => schema.validate('<count xmlns:x="http://www.w3.org/2001/XMLSchema-instance" x:noNamespaceSchemaLocation="https://example.invalid/evil.xsd">3</count>'), 'EXTERNAL_RESOURCE_FORBIDDEN');
              await rejects(() => schema.validate('<count>3</count>', { signal: { aborted: true } }), 'ABORTED');
              assert((await schema.validate('<count>4</count>')).valid, 'reusable after failures');
            } finally { schema.dispose(); }
            schema.dispose();
            assert(schema.disposed, 'idempotent disposal');
            await rejects(() => schema.validate('<count>3</count>'), 'DISPOSED');
            for (const kind of ['include', 'import', 'redefine', 'override']) {
              await rejects(() => compileSchema(`<s:schema xmlns:s="${ns}"><s:${kind} schemaLocation="https://example.invalid/evil.xsd"/></s:schema>`), 'EXTERNAL_RESOURCE_FORBIDDEN');
            }
            await rejects(() => compileSchema(`<!DOCTYPE s:schema SYSTEM "file:///etc/passwd"><s:schema xmlns:s="${ns}"/>`), 'INVALID_SCHEMA');
            await rejects(() => compileSchema(text, { signal: { aborted: true } }), 'ABORTED');
            const comment = await compileSchema(text.replace('<s:element', '<!-- <s:import schemaLocation="evil"/> --><s:element'));
            comment.dispose();
            assert(comment.disposed, 'XML-aware preflight allows comments');
            return { assertions };
          }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${name}: schema browser test timed out after 30 seconds`)), 30_000); }),
        ]);
        if (unexpectedRequests.length) throw new Error(`Unexpected network requests: ${JSON.stringify(unexpectedRequests)}`);
        console.log(`${name}: ${result.assertions} packed-artifact schema browser assertions passed; no unintended network requests`);
      } finally { clearTimeout(timeout); }
    } finally { await browser.close(); }
  }
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
