# Java validation provider (optional, Node only)

`xmlweave/schema-java` uses an explicitly selected OpenJDK-derived Java 17+ JDK, its built-in Xerces `SchemaFactory`, immutable `Schema`, `ValidatorHandler` and `TypeInfoProvider`. It does not emulate type annotations. No Java dependency is loaded by the core or browser companions. Java source-file launch requires a JDK; a runtime-only JRE is insufficient. Nothing is installed or downloaded automatically. The launcher supplies `--add-exports=java.xml/com.sun.org.apache.xerces.internal.xs=ALL-UNNAMED` to access the actual built-in XS type graph. This is a deliberately fixed JDK/Xerces binding, not support for arbitrary installed JAXP providers; other JDK implementations require independent verification.

```js
import { compileJavaSchema } from 'xmlweave/schema-java';
const schema = await compileJavaSchema(
  { kind: 'text', text: xsd, systemId: 'https://schemas.example/root.xsd' },
  { timeoutMs: 15000 }
);
try {
  const result = await schema.validate(xml);
  const { xml: augmentedXml, document } = await schema.validateOutput(xml);
  for await (const event of schema.validateStream(xmlChunks)) {
    // Events are provisional until the final result, including late keyref errors.
    if (event.kind === 'startElement') console.log(event.type, event.attributes);
  }
} finally { schema.dispose(); }
```

Supply multiple sources as an array with unique system identifiers to create an explicit in-memory catalogue. Relative include/import/redefine references resolve against each source identifier. Unresolved references fail closed, with no filesystem or network fallback. Identifiers do not fetch resources. All supplied schemas are parsed with the core's DTD-denying policy before Java compilation. The instance SAX parser also rejects DOCTYPE; external DTD/schema access is disabled, secure processing enabled, and the resolver serves supplied sources only.

`validateStream` consumes decoded string chunks directly into a bounded pipe and SAX parser. It does not accumulate the full input. Events can arrive before input EOF. Node stdout pause/resume, bounded OS pipes, and write-drain handling propagate application backpressure, with bounded read-ahead rather than one-event lockstep. Chunk framing is limited to 16 MiB, the default total character limit is 1,000,000 and byte limit is 4,000,000, and the Java secure-processing limits remain active. String chunks preserve surrogate pairs split at chunk boundaries. Consumer early return disposes the process and requests upstream iterator closure. A producer blocked forever inside its own `next()` cannot be forcibly resumed by JavaScript; supply cooperative producers.

Element start/end snapshots and attribute snapshots come from Java's TypeInfoProvider during its legal callback window, then are deeply frozen. Attribute metadata includes `isId` and `specified` (false for schema-defaulted attributes). End-element type information is the correct place to inspect selected union member types. To query actual derivation, pass compile-time `typeQueries: [{namespaceURI, name, method}]`; each type snapshot's `derivations` array holds answers from the actual JDK/Xerces XS component graph in query order. This avoids known deficiencies of the JDK's DOM `TypeInfo.isDerivedFrom` convenience method; no schema-name matching approximates the graph. Method is the DOM derivation bitmask (restriction 1, extension 2, union 4, list 8; zero accepts any derivation).

`validateOutput` builds a new document from validated SAX output, including schema-supplied attributes/content and engine-normalized values. It returns no XML/document when invalid. It preserves processing instructions and whitespace delivered by the handler, but is not a lexical roundtrip (comments, CDATA boundaries, original prefixes/quoting and declaration spelling are not promised). Text and DOM outputs are generated, not original-source locations.

`createValidator` provides independent lazy process-backed sessions suitable for concurrent calls. Each session recompiles the immutable source catalogue in its own isolated Java process; compiled native grammars are not transferred across processes. Sessions reject concurrent use, preserve creation defaults, and `reset()` restores the stateless episode configuration. Overrides are per call. Disposing the parent disposes child sessions. Cancelling, timing out, or abandoning an episode terminates its process; dispose and create a fresh session after such interruption.

Diagnostics are emitted from Java ErrorHandler with actual severity, phase, original system identifier and location. Java then blocks for an explicit host acknowledgement. Input is also request-driven, so XML chunks cannot be confused with diagnostic acknowledgements. The host callback runs before acknowledgement; a thrown callback or `errorPolicy: 'throw'` terminates the process before Java continues from that diagnostic. The default accepts recoverable errors and returns a schema-invalid result. Malformed input is a fatal invalid result. The default deadline is 30 seconds and can be overridden. Deadline and cancellation terminate native work; optional Java absence is `ENGINE_UNAVAILABLE`. `javaExecutable` selects an executable directly without a shell; XML and schema text never appear in command arguments.

This provider is Node only and does not establish advanced browser parity. It supplies validated push-derived pull output, not a public arbitrary SAX-event input adapter. Java provider/vendor extensions and XSD 1.1 are not promised. Its tested baseline is the local Java 17 provider; standards conformance requires the shared fixture catalogue, not merely engine selection.

## Configuration and source provenance

Unknown compile, validator-creation and validation options fail with `INVALID_ARGUMENT` before consuming input or changing episode state. `javaExecutable` and `typeQueries` are compile-only settings. Character, byte and diagnostic budgets are inherited by sessions and calls; an explicitly set inherited budget can be lowered, never raised. Validation overrides do not persist after the call or `reset()`. Factory diagnostic observers are not inherited by child sessions. Disposing an active Java session cancels its process; it differs deliberately from the same-realm companion's busy-disposal rejection.

Decoded byte and DOM sources preserve their `sourceKind` and original/generated provenance in validation diagnostics. Direct string-chunk validation reports chunk/original provenance. Validated output escapes text, including the XML-forbidden raw `]]>` sequence, before constructing its new DOM.

Namespace-only imports resolve against a uniquely matching target namespace in the supplied schema catalogue. Multiple supplied documents in that namespace are explicitly ambiguous for this lookup and fail compilation; provide an explicit include entry schema and `schemaLocation` to select component assembly. This is not a claim that arbitrary same-namespace source arrays are completely assembled by every JDK provider. Explicit include/import/redefine edges continue to use canonical source identifiers with no transport fallback.

Event snapshots carry generatedLocator with actual parser callback position; schema-inserted character content is marked generatedReason: schema-default. JavaTypeInfo.qNameValue follows actual XS graph derivation. Element end specified is false when the validator emitted text without original source characters. Collected QName defaults retain actual instance prefix mappings and follow Java validity. Bound values roundtrip, including a prefix bound differently from its schema-document binding; unbound defaults remain invalid with no output artifact. Qualified default attributes receive scoped prefix mappings from their actual expanded names.

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
