# Parser MVP decisions

## Scope and API contract

The MVP is a synchronous whole-document string API: `parseXml`, `createDocument`, `serializeXml` and `mutateXml`. Documents use the selected engine's namespace-aware DOM methods. `mutateXml` wraps a callback and normalizes its failures; direct DOM methods retain native engine exceptions. `XmlError` has stable codes, operation and original cause, with location when known. Semantic roundtrip preserves expanded names, attribute values and ordered content, not source bytes or prefix spelling.

Core types require ES libraries only, without DOM globals or Node types. XML input is an already decoded JavaScript string; declaration encoding does not decode bytes. Initial targets to verify are Node 22/24 (a target is supported only once its fixture has run successfully), modern Chromium/Firefox/WebKit bundled with esbuild, JavaScript ESM and CJS, and TypeScript Node16, NodeNext and bundler resolution. Passing fixtures define compatibility; arbitrary TypeScript projects are not promised.

## Engine evaluation

`test/engine-spike.test.mjs` compares slimdom 4.3.5 with @xmldom/xmldom 0.9.12. slimdom rejects the malformed documents in the corpus and supports DOM creation/mutation plus well-formed serialization. xmldom 0.9.12 rejects mismatched tags, duplicate attributes and unbound prefixes, but recovers unknown entities with an error diagnostic and accepts an XML-forbidden numeric character reference without diagnostics. The measured corpus favors slimdom's strict parser for this facade; this is not a claim about every xmldom configuration. slimdom is selected **only behind mandatory preflight DTD rejection and bounded input/depth checks**, with regression tests against its observed external entity content loss. Unsupported DTDs must fail before the engine sees them. The choice does not claim full DOM or full XML conformance.

Default limits: 1,000,000 UTF-16 code units per input/output string, 256 element depth, 100,000 nodes for parsing and serialization. Callers may lower these limits; raising beyond defaults is rejected. Whole-document parsing still consumes memory proportional to input, and these synchronous guards are not a CPU timeout or sandbox. No resolvers, external I/O or DTD opt-out are offered.

## Packaging

Use one CommonJS implementation and a thin ESM re-export wrapper, so mixed import/require in one Node process shares constructors and document identity. Publish separate `.d.cts` / `.d.ts` entry declarations associated with explicit `require` / `import` exports. Test the actual packed artifact in isolated consumers, including ES-only TS libraries. Browser bundles use esbuild's CJS interop. Internal paths are not public exports.

## Licensing and distribution gate

slimdom 4.3.5 and the evaluation-only xmldom 0.9.12 declare MIT. TypeScript and Playwright declare Apache-2.0; esbuild declares MIT. Runtime distribution depends on slimdom rather than embedding its source, and its installed package retains its license. Browser bundling must retain legal notices. See `THIRD_PARTY_NOTICES.md` and the lockfile for the tested inventory. Optional FontoXPath, WASM/schema and transformation candidates require separate license review before adoption.

The owner has not chosen an XMLWeave license. No project license is selected by this work. `private: true` and `license: UNLICENSED` prevent accidental registry publication. This is a usable source MVP, not an npm release; public redistribution permission must be settled with the owner before distribution. The license-decision issue remains open until that choice is recorded.

## Research

- https://github.com/bwrrp/slimdom.js (partial DOM, parse/serialize behavior and limitations)
- https://github.com/xmldom/xmldom (alternative parser and error reporting)
- https://nodejs.org/en/learn/modules/publishing-a-package
- https://www.typescriptlang.org/docs/handbook/modules/reference.html
