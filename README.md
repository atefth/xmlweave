# XMLWeave

A TypeScript-first XML toolkit for JavaScript and TypeScript, inspired by Java `javax.xml`.

**Status: usable parser MVP in source; no npm release.** Parse complete XML strings synchronously, create and mutate documents, and serialize well-formed XML with explicit errors and limits. The selected engine is slimdom 4.3.5 behind a mandatory DTD-rejection facade. See the [engine decisions](docs/decisions.md), [roadmap board](https://github.com/users/atefth/projects/3) and [issues](https://github.com/atefth/xmlweave/issues).

## Use from source

Use Node 22 or 24. Clone this repository, run `npm ci` and `npm run build`. `npm pack` creates an installable development tarball; install its absolute path in your consumer with `npm install /path/to/xmlweave-0.1.0-dev.0.tgz`. The package is private to prevent accidental registry publication; the project license is still an owner decision.

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

Core types require ES2022 libraries and no browser globals or `@types/node`. Runtime documents come from this package's `parseXml` or `createDocument`; an independent slimdom or browser DOM instance is not accepted by the facade. DOM node types are exported as TypeScript types, not runtime constructors.

## API and behavior

| API | Behavior |
| --- | --- |
| `parseXml(string, options?)` | Parse exactly one XML document. Malformed input throws. |
| `createDocument(namespaceURI?, qualifiedName?)` | Create an empty document or a namespace-aware root. Empty documents must gain a root before serialization. |
| `mutateXml(document, callback, options?)` | Run a synchronous DOM callback, verify the resulting document and return the same document. Failures do not roll back changes. Async callbacks are unsupported. |
| `serializeXml(document, options?)` | Validate and serialize a complete, well-formed XML document. |

Use namespace-aware DOM methods such as `createElementNS`, `setAttributeNS`, `getAttributeNS`, `importNode` and `adoptNode`. Standard ownership and hierarchy checks are enforced by slimdom. Text, comments, CDATA, processing instructions and document fragments are available through document factory methods. Direct DOM method errors remain engine exceptions; wrap edits in `mutateXml` to normalize callback errors.

Semantic roundtrips preserve expanded names, attribute values and ordered content. Prefix spelling, quote style, empty-element syntax and lexical entity spelling may change. The input is an already decoded JavaScript string; an XML encoding declaration does not decode bytes. This is a partial DOM implementation, not a full browser DOM or full XML conformance claim.

## Errors and resource policy

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

## Verification and compatibility

`npm test` runs the original regression corpus and engine comparison. `npm run test:consumers` installs the actual packed tarball into an isolated project and checks JavaScript ESM/CJS interchange and strict TypeScript declarations with no ambient DOM/Node types. `npm run test:browser` installs another packed copy, bundles with esbuild and runs real Chromium, Firefox and WebKit checks. Install browser test tools once with `npx playwright install chromium firefox webkit` (`--with-deps` on Linux). `npm run check` runs all of these, including the build.

The CI matrix verifies Node 22/24 on Linux/Windows, TypeScript 5.9.3/7.0.2 with Node16/NodeNext/bundler resolution, and Playwright 1.64.1 browser engines with esbuild 0.28.2. Compatibility applies to the passing fixture combinations; other bundlers, browsers, Node versions or arbitrary TypeScript configurations are unverified. Corpus cases are original regression fixtures authored in this repository; they are not the complete W3C conformance suite.

## Release and future scope

The [release checklist](docs/releasing.md) requires the full CI matrix, package inspection, compatibility documentation, dependency notices and an owner-approved license before registry publication. No package has been published. As a pre-1.0 development API, breaking changes require a documented changelog entry and a minor version increment; fixes use patch increments. Future API changes should include migration examples and consumer tests.

XPath, streaming, asynchronous schema validation and transformations remain optional future companions. XML signatures, SOAP and object mapping are future scope decisions, not MVP commitments.

The project license has not been selected. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses; they do not license XMLWeave's own source.
