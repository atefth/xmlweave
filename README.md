# 🧵 XMLWeave

[![CI](https://github.com/atefth/xmlweave/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/atefth/xmlweave/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-a7f3d0?style=flat-square)](LICENSE)
[![Source preview](https://img.shields.io/badge/source-0.1.0--dev.0-c4b5fd?style=flat-square)](CHANGELOG.md)
[![Roadmap](https://img.shields.io/badge/roadmap-on_the_loom-fbcfe8?style=flat-square)](https://github.com/users/atefth/projects/3)

**Small API. Structured chaos. XML, with better vibes.** ✨

A TypeScript-first XML toolkit for JavaScript and TypeScript, inspired by Java `javax.xml`.

**Status: source preview; no npm release.** A small synchronous XML core, plus optional XPath, streaming, XSD validation and XSLT companions. Each comes with explicit policies, tested boundaries and its own entry point. See the [engine decisions](docs/decisions.md), [roadmap board](https://github.com/users/atefth/projects/3) and [issues](https://github.com/atefth/xmlweave/issues).

## 🛠️ Get it spinning

Use Node 22 or 24. Clone this repository, run `npm ci` and `npm run build`. `npm pack` creates an installable development tarball; install its absolute path in your consumer with `npm install /path/to/xmlweave-0.1.0-dev.0.tgz`. The package is private to prevent accidental registry publication. XMLWeave is licensed under MIT.

```js
import { parseXml, mutateXml, serializeXml } from 'xmlweave';

const document = parseXml('<catalog xmlns="urn:books"><book id="1">XML</book></catalog>');
mutateXml(document, doc => {
  const book = doc.createElementNS('urn:books', 'book');
  book.setAttribute('id', '2');
  book.textContent = 'More XML & examples';
  doc.documentElement.appendChild(book);
});
const output = serializeXml(document);
```

CommonJS uses the same API and implementation:

```js
const { createDocument, serializeXml } = require('xmlweave');
const document = createDocument('urn:example', 'ex:root');
document.documentElement.setAttributeNS('urn:meta', 'm:id', '7');
document.documentElement.appendChild(document.createTextNode('hello <world>'));
const xml = serializeXml(document);
```

TypeScript receives declarations through the package exports:

```ts
import { parseXml, type Document } from 'xmlweave';
const document: Document = parseXml('<root/>');
const root = document.documentElement;
if (root) root.setAttribute('checked', 'yes');
```

Public types require ES2022 libraries and no browser globals or `@types/node`, including companion declarations. Core runtime documents come from this package's `parseXml` or `createDocument`; an independent slimdom or browser DOM instance is not accepted by the core facade. DOM node types are exported as TypeScript types, not runtime constructors.

## 🧰 Pick your threads

The core stays lean: importing `xmlweave` loads none of the companions. XPath and streaming bundle their engines in separate entry points. Schema and transformations load independently installed peers only when used.

| Import | What you get | Engine / boundary |
| --- | --- | --- |
| `xmlweave` | Synchronous XML DOM parse, create, mutate, serialize | slimdom 4.3.5; DTDs rejected |
| `xmlweave/xpath` | Typed query results, namespaces and scalar variables | FontoXPath 3.34.0; tested XPath 3.1 subset, read-only policy |
| `xmlweave/stream` | Pull-driven async XML events | saxes 6.0.0; bounded buffers, backpressure and cancellation |
| `xmlweave/schema` | Async, disposable XSD validation | libxml2-wasm 0.7.2 peer; self-contained XSD 1.0 |
| `xmlweave/transform` | Prepared stylesheets and async XML/text results | xslt-processor 5.1.2 peer; constrained XSLT 1.0 subset |

```js
import { evaluateXPathToNumber } from 'xmlweave/xpath';
import { streamXml } from 'xmlweave/stream';

const books = evaluateXPathToNumber('count(/b:catalog/b:book)', document, {
  namespaces: { b: 'urn:books' },
});
for await (const event of streamXml(['<root>', 'hello &amp; goodbye', '</root>'])) {
  if (event.type === 'text') console.log(event.value);
}
```

For schema validation, install `libxml2-wasm@0.7.2`; for transformations, install `xslt-processor@5.1.2`. Neither peer is installed merely to use the core. Both work through asynchronous APIs with ESM or CommonJS:

```js
import { compileSchema } from 'xmlweave/schema';
const schema = await compileSchema(`
  <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:element name="answer" type="xs:int"/>
  </xs:schema>`);
try {
  const result = await schema.validate('<answer>42</answer>');
  console.log(result.valid, result.diagnostics);
} finally { schema.dispose(); }
```

Browse the focused guides: [XPath](docs/xpath.md) · [streaming](docs/streaming.md) · [schema validation](docs/schema.md) · [transformations](docs/transformations.md). Browser schema validation uses a native ESM engine/import map; its guide includes the tested setup. The other companions are tested as esbuild browser bundles. The transformation peer is LGPL-3.0 and remains external to the distributed XMLWeave artifact; retain its own license when distributing it.

## 🪡 Four stitches, one document

| API | Behavior |
| --- | --- |
| `parseXml(string, options?)` | Parse exactly one XML document. Malformed input throws. |
| `createDocument(namespaceURI?, qualifiedName?)` | Create an empty document or a namespace-aware root. Empty documents must gain a root before serialization. |
| `mutateXml(document, callback, options?)` | Run a synchronous DOM callback, verify the resulting document and return the same document. Failures do not roll back changes. Async callbacks are unsupported. |
| `serializeXml(document, options?)` | Validate and serialize a complete, well-formed XML document. |

Use namespace-aware DOM methods such as `createElementNS`, `setAttributeNS`, `getAttributeNS`, `importNode` and `adoptNode`. Standard ownership and hierarchy checks are enforced by slimdom. Text, comments, CDATA, processing instructions and document fragments are available through document factory methods. Direct DOM method errors remain engine exceptions; wrap edits in `mutateXml` to normalize callback errors.

Semantic roundtrips preserve expanded names, attribute values and ordered content. Prefix spelling, quote style, empty-element syntax and lexical entity spelling may change. The input is an already decoded JavaScript string; an XML encoding declaration does not decode bytes. This is a partial DOM implementation, not a full browser DOM or full XML conformance claim.

## 🛡️ Guardrails included

`XmlError` extends `Error` and exposes `code`, `operation`, optional `cause` and optional `line`/`column`. DTD rejection supplies a location; malformed-input details remain in the engine cause when available, so callers should branch on code instead of engine message text.

| Code | Meaning |
| --- | --- |
| `MALFORMED_XML` | Parsing failed well-formedness or namespace checks. |
| `DTD_FORBIDDEN` | A real DTD declaration or a document type node was supplied. |
| `RESOURCE_LIMIT` | An input, document or output limit was exceeded. |
| `INVALID_ARGUMENT` | Wrong input/document/options, root name/namespace or callback. |
| `INVALID_DOCUMENT` | A mutated tree cannot be serialized as well-formed XML. |
| `MUTATION_FAILED` | The mutation callback threw; the cause is retained. |

DTDs, custom entities and external entities are always rejected before engine parsing. Predefined XML entities and numeric character references are supported. No file/network resolver is exposed. DTD-looking text inside comments, CDATA and processing instructions remains ordinary content.

Options may lower the defaults: `maxLength: 1_000_000` UTF-16 code units per source/result string, `maxDepth: 256` nested elements and `maxNodes: 100_000` DOM nodes including the document and attributes. Values must be positive safe integers no greater than the defaults. Length/depth are checked before parsing; node count is checked after parsing. Serialization checks the tree first and the escaped result length afterward. These whole-document synchronous operations consume memory proportional to input and do not provide a CPU timeout or sandbox. Mutation callbacks are application code; they are not restricted by these guards.

## 🧪 Receipts, not wishful thinking

`npm test` runs original regression fixtures, engine comparisons, companion security policies, a large generated stream and repeated WASM lifecycle checks. `npm run test:consumers` installs the actual packed tarball into an isolated project and checks all five entry points, missing/present optional peers, JavaScript ESM/CJS interchange and strict TypeScript declarations with no ambient DOM/Node types. `npm run test:browser` bundles packed core/XPath/streaming/transform code for real Chromium, Firefox and WebKit; `npm run test:schema-browser` verifies the native ESM/WASM setup in those same engines. Install browser test tools once with `npx playwright install chromium firefox webkit` (`--with-deps` on Linux). `npm run check` runs all of these, including the build.

The CI matrix verifies Node 22/24 on Linux/Windows, TypeScript 5.9.3/7.0.2 with Node16/NodeNext/bundler resolution, and Playwright 1.64.1 browser engines with esbuild 0.28.2. Compatibility applies to the passing fixture combinations; other bundlers, browsers, Node versions or arbitrary TypeScript configurations are unverified. Corpus cases are original regression fixtures authored in this repository; they are not the complete W3C conformance suite.

## 🗺️ On the loom

| Thread | Status |
| --- | --- |
| Parse · create · mutate · serialize | ✅ Available in source |
| ESM · CommonJS · TypeScript declarations | ✅ Tested packed artifacts |
| XPath · streaming · schema validation · transformations | ✅ Optional source companions with documented subsets |
| npm release | 📦 Not published |

The [release checklist](docs/releasing.md) requires the full CI matrix, package inspection, compatibility documentation, dependency notices and an owner-approved license before registry publication. No package has been published. As a pre-1.0 development API, breaking changes require a documented changelog entry and a minor version increment; fixes use patch increments. Future API changes should include migration examples and consumer tests.

The scoped roadmap is implemented. Signatures, SOAP, JAXB-style binding and general object mapping were evaluated and deferred with explicit prerequisites in the [scope decision record](docs/future-scope.md). No signature, protocol or binding support is claimed. XPath/XSLT operations and WASM validation provide no hard execution timeout; use trusted expressions/stylesheets/schemas or isolate compute-heavy work. Streaming's pinned engine is archived upstream; the [evaluation](docs/streaming.md) records why it passed correctness gates that the tested alternatives failed.

XMLWeave is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses and retained copyright notices.
