# Validation pipelines and explicit providers

`xmlweave/schema-pipeline` connects structural SAX-style push or StAX-style pull events to a selected native compiled validator. It imports neither the Java nor Xerces runtime. Pass an already compiled provider exposing `validate`, `validateStream`, `dispose`, and `disposed`.

```js
import { createValidationHandler } from 'xmlweave/schema-pipeline';
const handler = createValidationHandler(compiledSchema);
await handler.startDocument();
await handler.startElement({ name: 'count', localName: 'count', namespaceURI: '' });
await handler.characters('4');
await handler.endElement({ name: 'count', localName: 'count', namespaceURI: '' });
const result = await handler.endDocument();
```

The equivalent pull path is `validateEventStream(compiledSchema, inputEvents, options)`, returning native validated output events and a final `result` event. Output retains the selected provider's actual frozen `type` or `psvi` snapshots, defaults, attributes and diagnostics. It does not infer type information from schema names or validate independent subtrees. The document's native validation episode remains alive through the final identity-constraint checks.

## Event contract

Every input starts with `startDocument` and ends with `endDocument`. Element events carry `{name, localName, namespaceURI}`; start events additionally carry an attribute array of those fields plus `value`. Text uses `{kind:'text',text}`. Namespace scope uses `startPrefixMapping` immediately before its element and corresponding `endPrefixMapping` immediately after its end element. Nested bindings restore the outer scope. The `xml` binding is predefined. Default namespace undeclaration is permitted; illegal reserved bindings, undeclared prefixes, inconsistent names, duplicate expanded attributes and unbalanced lifecycles are rejected. Namespace declaration attributes must be expressed through prefix events. The `namespacePrefixes` option defaults to false, excluding XMLNS declaration attributes from outgoing start-element attribute lists. With true, introduced mappings also appear as `xmlns`/`xmlns:p` attributes in `http://www.w3.org/2000/xmlns/`, with local names `xmlns`/`p`. Prefix events are always forwarded. Added declaration attributes are marked `namespaceDeclaration:true` with null type/PSVI; they are namespace metadata, not guessed schema annotations. Processing instruction events carry `target` and `data`; DTD events are unsupported.

Handlers offer matching async methods: `startDocument`, `startPrefixMapping`, `startElement`, `characters`, `processingInstruction`, `endElement`, `endPrefixMapping`, and `endDocument`; `write(event)` is the general form. `endDocument` writes its lifecycle event, closes input, and waits for the final native result. `end()` only closes input: it does not invent a missing document-end event. The handler object represents one document and closes permanently after completion. Reuse the compiled grammar by creating a fresh handler for the next episode; do not call startDocument again on a completed handler. Await writes sequentially. Rejected input or abandoned output terminates the owned provider episode; create another provider/session after interruption.

Input events become incrementally escaped XML chunks. The engine performs genuine native incremental validation, and impossible-child errors can arrive before source EOF. This is an explicit JavaScript adaptation, not direct injection into Java's native ContentHandler or Xerces' internal callbacks. It introduces a generated lexical representation; native line/column positions refer to that representation. Optional per-event `{locator:{systemId?,line?,column?}}` values are copied to the `onLocator` side channel with event index and generated start line. Each forwarded event now has `location`, containing the untouched native `generated` locator and an explicit correlation status. A unique match carries the exact caller-supplied `source` locator, `eventIndex`, and `precision:'event'`. This associates a native reported position with an input event; it does not invent an original lexical character offset. A SAX text event contains decoded data, so the original spellings of entities/character references cannot be reconstructed from its value and point locator alone.

Correlation retains at most `maxLocatorSegments` event ranges (default 1,024, allowed 1–8,192), not a document-wide source map. Missing source locators, missing native coordinates, expired ranges and boundary ambiguities are respectively reported as `missing-locator`, `unmapped`, `expired`, and `ambiguous`; candidates preserve the supplied positions without choosing one arbitrarily. Native-injected content explicitly marked with a generated reason receives `status:'generated'`. Native diagnostics retain their original `line`/`column` and generated provenance; `diagnostic.location` carries event correlation separately. Late key-reference failures correlate with the native-reported closing-event position, not an invented earlier offending reference. A long retained diagnostic result reuses the correlation determined when the diagnostic was emitted.

Native event locators are actual parser callback positions, often after a start tag. Providers must preserve the original callback location when delaying PSVI start events. Supplied event locators may refer to different source identifiers; generated coordinates belong to the adapter's separate `systemId`. Precisely recovering arbitrary original lexical offsets would require additional caller-supplied lexical-span data; no such information is inferred.

## Bounds, ownership and backpressure

Push input defaults to 16 queued events, configurable from 1 to 256 using `maxQueuedEvents`. A full queue makes `write()` wait; excessive concurrent writers are rejected rather than accumulated without bounds. Total serialized input and metadata have explicit character budgets. Element depth is capped at 256. Native provider source/diagnostic budgets additionally apply. The handler copies input event snapshots, so caller mutation after an awaited write cannot alter the episode.

By default output is consumed internally and only completion is returned. Set `{output:'events'}` to expose bounded output through `handler.events`; consume it concurrently with writes, since a slow or absent output consumer deliberately applies backpressure. Every native event remains provisional until the final result, including late key references. Early consumer return calls iterator closure and disposes the provider. Cooperative source iterators must release their own pending waits; JavaScript cannot forcibly interrupt an arbitrary unresolved `next()` implementation. Native provider-specific hard deadlines remain the provider's responsibility.

## Matching source/result families

`validateSource(provider, input, resultFamily, options)` validates matching source/output families and rejects mismatches:

| Input family | Input | Permitted result families |
| --- | --- | --- |
| `stream` | `source`: text, bytes or buffered chunks source | `none`, `text`, UTF-8 `bytes` |
| `dom` | `node`: XMLWeave Document or Element, optional systemId | `none`, copied `dom` |
| `sax` / `stax` | `events`: sync or async structural events | `none`, incremental `events` |

Collected results return `{result,text?}` / `{result,bytes?}` / `{result,document?}` and expose no output if schema-invalid. Event results return `{events,completion}`; consume events to drive completion. Text and DOM collection is deliberately buffered and bounded; it is separate from the incremental event path. DOM sources reuse the namespace/base-preserving source adapter and never mutate input trees.

Collected output uses actual native augmented attributes, text and leaf PSVI normalized values/defaults. It escapes XML metacharacters, including the forbidden literal `]]>` sequence. This is generated output, not lexical preservation: comments, CDATA boundaries and declaration spelling are not preserved. Processing instructions retain their event order, including prolog, interior and epilog events. A simple-content element containing a PI retains the native character events rather than replacing its whole content with the PSVI normalized string; normalized semantic value remains available separately in metadata. QName defaults follow the actual provider validity decision and instance namespace context. Unbound defaults produce an invalid result with no artifact; bound prefixes, including bindings differing from the schema document, are preserved and the collected result revalidates under the tested JAXP semantics. Qualified default attributes use their actual expanded names; a missing lexical prefix is repaired with an existing nonempty binding or a conflict-free generated prefix. No schema text is consulted to guess datatype values or attribute identity.

## Explicit factory negotiation

`xmlweave/schema-factory` provides `createSchemaFactory(provider, {features?,properties?})` and a local `createSchemaProviderRegistry(providers)`. A provider supplies `id`, `version`, immutable-snapshotted `capabilities`, optional feature/property definitions, and `compile(source, options, configuration)`. There is no process-global discovery, fallback, environment lookup or implicit Java requirement.

Feature definitions enumerate supported booleans, with the first value declaring the default. Property definitions support a default value, allowed values and numeric bounds. Factory construction rejects unknown or unsupported settings and passes the complete frozen configuration into the provider's compile function. Capability lists and options are copied; later caller mutation cannot change the factory snapshot. Getters expose configured features/properties; `supportsSchemaLanguage` consults only the explicit `capabilities.schemaLanguages` list. Unknown features/properties fail, rather than being silently ignored. A provider adapter is responsible for applying every declared setting to its engine; do not advertise features merely because another provider supports them.

For a fixed provider without configurable engine switches:

```js
const factory = createSchemaFactory({
  id: 'my-explicit-provider', version: '1',
  capabilities: { schemaLanguages: ['http://www.w3.org/2001/XMLSchema'], xsdVersion: '1.0' },
  compile: (source, options) => compileSelectedProvider(source, options)
});
const grammar = await factory.compile(xsd);
```

Factory negotiation is a portable contract boundary, not an assertion that all selected providers support streaming, complete warning callbacks, hard termination or browser execution. Read and test the selected provider's capabilities separately.

## Shipped provider factories

```js
import { createSchemaFactory } from 'xmlweave/schema-factory';
import { xercesSchemaProvider, validationPolicyNames } from 'xmlweave/schema-providers';
const factory = createSchemaFactory(xercesSchemaProvider(), {
  features: { identityConstraints: true }
});
console.log(factory.getFeature(validationPolicyNames.secureProcessing)); // true
const grammar = await factory.compile(xsd);
try { console.log(await grammar.validate(xml)); } finally { grammar.dispose(); }
```

The native factory maps `fullSchemaChecking`, `identityConstraints`, and
`multipleImports` to actual Xerces feature switches. Both shipped native and
explicit Java definitions expose Java's secure-processing URI as fixed true and
external-DTD/schema protocol properties as fixed empty strings. Relaxation fails
negotiation; approved in-memory catalogues remain the resource mechanism.
Selecting `javaSchemaProvider` is explicit; importing these definitions never
starts Java or initializes WebAssembly.

## Exact handlers through adapters

`diagnosticHandler` is forwarded to the selected provider, not downgraded to `onDiagnostic`. For event input it receives the same bounded `location` correlation as diagnostic events; original native positions remain in `location.generated`. For buffered byte/DOM inputs, adapters restore the original byte source or generated DOM provenance before invoking the handler. Exceptions retain identity.

The raw same-realm Xerces provider requires a synchronous handler; returning a thenable rejects with `UNSUPPORTED_CAPABILITY`. Java's request/decision protocol and the isolated native shared-memory protocol can await a handler promise before native work advances. Isolated browser handlers require the documented cross-origin-isolation headers. Capabilities belong to the chosen provider; a pipeline does not manufacture asynchronous native interruption.
