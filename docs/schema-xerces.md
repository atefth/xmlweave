# Native Xerces validation and type information

The optional `xmlweave/schema-xerces` companion runs our SAX2/PSVI bridge against the pinned Xerces-C++ WebAssembly build. It works in Node and browser WASM runtimes. The core parser does not import it. Prefer `xmlweave/schema-xerces-isolated` when validating untrusted input: the isolated wrapper owns a worker and provides hard deadlines and termination. The raw companion described here has cooperative cancellation checkpoints and a single active episode per compiled grammar; it does not provide CPU-bound interruption on the main thread.

```js
import { compileXercesSchema } from 'xmlweave/schema-xerces';

const schema = await compileXercesSchema(
  { kind: 'text', text: xsd, systemId: 'https://schemas.example/main.xsd' },
  {
    typeQueries: [
      { namespaceURI: 'http://www.w3.org/2001/XMLSchema', name: 'decimal', method: 1 }
    ]
  }
);
try {
  for await (const event of schema.validateStream(xmlChunks)) {
    if (event.kind === 'endElement') {
      console.log(event.psvi.type, event.psvi.memberType);
    }
    if (event.kind === 'result') console.log(event.result.valid);
  }
} finally {
  schema.dispose();
}
```

`validate(source)` accepts the shared text, byte, DOM and chunk source adapters and returns a validation result. It normalizes those adapters before validating; use `validateStream` for decoded string input that must remain incremental. Schema source sets are buffered at compilation. Their identifiers form an explicit in-memory catalogue. Relative resource identifiers resolve against the requesting schema's base URI using URL resolution; unresolved identifiers fail closed. There is no basename fallback and no implicit filesystem or network fetch. Use hierarchical absolute identifiers for relative includes. Source-set order is preserved, with the entry schema first.

The native input stream awaits chunks as Xerces requests bytes. Its raw-buffer low-water mark is zero, so a small available chunk can produce events and errors before the producer supplies EOF. Native output awaits the application's next iteration before continuing. There is one outstanding event acknowledgement, rather than an unbounded event queue. Empty-element schema-default text is held only until that element's final PSVI callback supplies its start metadata; the document is never buffered by the native streaming adapter. Input character/byte budgets use the shared source limits. Consumer early return requests upstream iterator closure and abandons the grammar. A producer that never resolves its own `next()` requires the isolated wrapper for hard termination.

Events remain provisional until the final result. In particular, key/keyref constraints can fail after relevant child elements have been delivered. `errorPolicy: 'result'` collects bounded diagnostics and returns an invalid result. `errorPolicy: 'throw'` interrupts native validation on the first non-warning diagnostic. A thrown JavaScript diagnostic callback also unwinds the native episode, preserving the original thrown value. Unlike a post-operation observer, this callback runs synchronously inside the native ErrorHandler boundary before it returns. Diagnostic pull events use a bounded queue rather than suspending Asyncify inside a C++ exception catch scope; structural output still awaits consumer acknowledgement. Warnings are mapped separately from errors and fatal errors; the regression suite does not claim exhaustive warning-condition coverage.

Start/end element events contain `psvi`, and attributes contain their own `psvi`, `specified` and `isId`. These snapshots come from actual Xerces PSVI callbacks and are deeply frozen before delivery. Full end metadata includes declared type, selected union member, normalized value, schema default, schema-specified flag and engine validity. Start metadata is partial for nonempty elements; selected union members and normalized simple content require the end snapshot. Attribute ID status follows the actual validated native type. Schema-supplied attributes and content are engine outputs, not values guessed by inspecting schema text.

Each type snapshot contains its name, namespace, anonymous flag, primitive/item primitive type, variety and `derivations` answers. Compile-time `typeQueries` use DOM/Java masks: restriction 1, extension 2, union 4, list 8; zero follows any combination of base, item and member relationships. Combined masks OR the corresponding answers. The bridge walks the public native XS type graph, including actual complex derivation methods, simple varieties, list item types and union members. It does not use Xerces' incomplete DOM TypeInfo convenience implementation. Query answers are snapshots; native type handles never escape.

Compile-time `features` accepts three independently applied booleans: `fullSchemaChecking`, `identityConstraints` and `multipleImports`, all defaulting to true. Each maps to the corresponding native Xerces feature. Unknown settings fail explicitly. The WASM asset can be relocated with compile-time `wasmUrl`. Every compiled grammar creates its own WASM module instance; no catalogue is shared with another grammar. DTDs are denied in schemas and instances, default entity resolution is disabled, and all supplied decoded text is explicitly encoded as UTF-8 before native parsing.

Diagnostics retain native severity, original identifier, line and column. A native error-domain hook distinguishes parsing diagnostics from validity diagnostics; compilation is its own phase. Shared adapters annotate whether coordinates refer to original input or generated DOM text. XML declarations cannot reinterpret an already-decoded JavaScript string as a different byte encoding.

Validated output requires the separate pipeline adapter. One known engine/API edge deserves care: a schema-defaulted QName can contain a prefix declared only in the schema, while the native PSVI callback provides no resolved QName namespace binding. The bridge explicitly checks schema-supplied atomic/list QName values against actual instance prefix mappings and reports an error for an unbound prefix, correcting the observed raw-engine differential with Java. This adaptation uses actual native type metadata and native namespace events, never datatype patterns or schema-name matching. Such output must not be treated as namespace-correct merely because its lexical text is available. The output adapter preserves actual instance prefix mappings and uses the native validity result. Bound QName defaults and qualified default attributes have positive roundtrip tests; unbound default prefixes return invalidity without an output artifact. Expanded-name namespace fixup never guesses a datatype value.

The [native rebuild guide](../native/README.md) pins the Xerces fork (reporting version 4.0.0) and Emscripten toolchain and retains the MIT integration and Apache-2.0 Xerces notices. Tested XSD 1.0 fixtures are evidence for the named behaviors; engine choice is not a proof of all schema conformance, and XSD 1.1 is not promised.

Native events include generatedLocator snapshots of the actual parser callback position. Delayed start events retain the position captured at the original SAX start callback. Buffered empty-element default text is marked generatedReason: schema-default. Diagnostics retain their independently reported error position; a callback position is not presented as a guessed original character offset.

## Anonymous identity and idle derivation queries

Every type snapshot includes `identity: {schemaIdentity, namespaceURI, name}`. Named types retain their QName. Anonymous types receive a stable generated name in a grammar-unique namespace; `anonymous`, `rawName` and `rawNamespaceURI` preserve the native distinction and upstream metadata. Identity is stable across episodes of that grammar, not a global identity shared by separately compiled grammars.

Retain a snapshot and query its actual component graph while the grammar is idle:

```js
const derived = await grammar.queryTypeDerivation(
  savedType.identity,
  { namespaceURI: 'http://www.w3.org/2001/XMLSchema', name: 'decimal' },
  1 // restriction; 0 permits any supported derivation combination
);
```

The result comes from retained native XS type components. A foreign/unknown identity rejects with `INVALID_ARGUMENT`; an active grammar rejects with `BUSY` and a disposed grammar with `DISPOSED`. No native pointers escape. Compile-time `typeQueries` remain useful for per-event answer snapshots without an extra request.
