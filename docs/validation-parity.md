# XMLWeave validation parity: requirements and executable roadmap

Assessment date: 2026-10-16. Baseline source: `ec5ddf2`, before this implementation phase. Current acceptance evidence is recorded in [validation status](validation-status.md). Repository: `atefth/xmlweave`. This is a requirements and feasibility report, not a claim that the proposed features already exist. The target is a useful JavaScript/TypeScript equivalent of the portable `javax.xml.validation` XSD 1.0 contract, with documented JavaScript adaptations and the existing Node/browser packaging guarantees. Advanced gaps below remain delivery obligations until implemented or explicitly removed by the owner. A spike finishing is not its dependent feature finishing.

## 1. Recommended scope and meaning of completion

Build a complete validation subsystem around explicit sources, reusable compiled grammars, independent validation sessions, resource resolution, diagnostics, validated outputs, incremental events, and type information. Preserve the present convenience API. Preserve secure defaults: no implicit filesystem/network access and no DTDs. Native Java class names, class loaders, system properties, exceptions, or threads need not be copied literally; the behavioral mapping must be recorded.

The baseline is XSD 1.0. Current Java SE 27 documentation still requires only XSD 1.0; other schema languages are provider extensions, and DTD semantics are not defined by this validation API. XSD 1.1 assertions, alternatives, open content, override, and XPath 2.0 assertion evaluation are therefore separate optional scope, not missing baseline parity. [Java SchemaFactory](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/SchemaFactory.html)

“No gaps” must mean every row of the agreed portable contract has implemented behavior, an explicitly documented JavaScript equivalent, or an owner-approved exclusion, with acceptance evidence on each supported runtime. It cannot honestly mean every vendor-specific Java feature or proof that no standards bug exists. Keep browser parity open if an advanced capability is delivered only through Java on Node. Do not rename a limitation as a feature, and do not close implementation stories when only a decision record exists.

Recommended first executable increment: original-source diagnostics and provenance; robust options/error behavior; independent sessions and capability reporting; positive/negative XSD fixtures with Java differential testing; safe source adapters; and a working isolated schema-composition provider. In parallel, perform the advanced engine spike early because genuine event validation and type metadata determine the architecture of later outputs. Deliver the remaining epics below after that gate; they are not silently deferred.

## 2. Source and runtime evidence

Inspected local sources: `src/schema.ts`, `src/index.ts`, `src/stream.ts`, `test/schema.test.mjs`, `test/engine-spike.test.mjs`, `docs/schema.md`, `docs/decisions.md`, `docs/future-scope.md`, package exports, and installed `libxml2-wasm@0.7.2` declarations/runtime. The current companion has one string compilation entry and one string validation method. It preflights through slimdom, rejects all composition/hints/XInclude/DTDs, serializes the preflight DOM, then compiles or validates a second DOM in WASM. It never returns output XML or type annotations.

The parent’s exploratory `.artifacts/xsd-audit.mjs` reports 16/16 paired valid/invalid probes passing: sequence/order, occurrences, choice, all, required attributes, enumeration, pattern/length, numeric facets, list, union, complex extension, simple content, key/keyref, nillable, fixed attribute, and substitution group. These are useful observed examples, not complete construct coverage; promote them into tracked regression fixtures. The original tracked schema suite is chiefly one `positiveInteger` schema, denial/security behavior, cancellation checkpoints, and 100 ownership/disposal cycles.

Additional parent-run evidence: `.artifacts/reference-audit.mjs` and `.artifacts/ReferenceProbe.java` ran the same 16 positive/negative pairs against a securely configured Java 17 factory; all 16 pairs passed on both providers. `.artifacts/composition-probe.mjs` demonstrated a native include resolved through the public in-memory provider in a separate process: a root with an absolute URL included `parts.xsd`, and both valid/invalid enumeration instances produced expected results. This proves a narrow composition mechanism, not full graph correctness or browser isolation. These results are reported from the parent's executable probes rather than independently rerun by this reviewer.

`java.exe` and `javac.exe` are available locally from Eclipse Adoptium JDK 17.0.13. `emcc` was not found. Java 17 is suitable for a pinned reference harness for this longstanding API, but does not establish all current JDK 27 implementation behavior. Record runtime/vendor/version in differential results; consider a current LTS JDK CI lane too. A Java runtime cannot be assumed on consumers’ machines.

## 3. Portable Java contract and present gap matrix

Java’s `Schema` is an immutable grammar suitable for sharing, from which separate validators and SAX handlers are created. XMLWeave’s compiled object owns a reusable native grammar, but has no separate public sessions or cross-worker sharing contract. [Java Schema](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/Schema.html)

Java `Validator` is mutable, non-reentrant, and resettable. Source/result families are Stream, SAX, DOM, and StAX: each accepts no result or a matching-family result; cross-family combinations are rejected. Validation can report errors through a handler and return normally when the handler accepts recoverable errors. The default handler throws on errors. XMLWeave instead returns an invalid result and throws for operational failure; preserve that useful distinction and document an optional throwing adapter. [Java Validator](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/Validator.html), [OpenJDK contract source](https://raw.githubusercontent.com/openjdk/jdk/jdk-25-ga/src/java.xml/share/classes/javax/xml/validation/Validator.java)

| Requirement | Current evidence | Required target / feasible route |
| --- | --- | --- |
| Compile an explicit grammar | One self-contained XSD string | Retain convenience form; add source metadata and schema-set compilation. |
| Multiple schema sources | Absent | Engine-based composition with specified duplicate/namespace behavior; no textual flattening. |
| Reusable grammar and sessions | One object; native valid context created per call | Immutable compiled configuration and independent sessions; preserve convenience `validate`. |
| Reset and reuse after failure | Reuse tested, no resettable configuration | Reset sessions to creation defaults; clear diagnostics/episode state; reject reentrant mutation. |
| String / reader / byte input | Decoded string only | Explicit text, bytes, and iterable adapters with encoding/ownership rules. Buffered and incremental APIs must be distinguished. |
| DOM document / subtree input | Absent | XMLWeave DOM document and element adapters; inherited namespaces and subtree identity semantics tested. |
| SAX event input and output | Separate parser events only | Genuine schema handler with document/prefix lifecycle, locator, valid event order, final result. Engine change required. |
| StAX-style pull input/output | Parser is async pull; no schema validation | Pull validation adapter with backpressure and termination; events remain provisional until completion. |
| Stream / DOM result | No output | Validated output contract; optional schema defaults/normalization must come from engine evidence. |
| Resource resolver | None; directives denied | Explicit map and resolver request containing source/base/namespace/kind; deny unresolved requests without fallback. |
| include/import/redefine | All rejected | Preserve XSD graph semantics in native compiler; cyclic graphs and chameleon inclusion tested. |
| Schema hints | All rejected | Explicit grammar mode ignores or rejects according to explicit policy; separate opt-in hint-driven mode uses safe resolver. |
| Diagnostics | Message/severity/optional line,column,path | Preserve original source ID/location and phase; expose warnings; bounded ordered diagnostics and documented callbacks. |
| Error callback interruption | None | Post-operation observer is feasible now; immediate engine interruption requires callback/engine work. |
| Secure processing | DTD denial, fixed core size/depth/nodes | Per-operation lowered limits, schema graph/diagnostic budgets, isolation and real deadline path. |
| Feature/provider negotiation | One optional fixed engine | Capability snapshot and explicit provider selection; unsupported settings must fail, never be ignored. |
| TypeInfoProvider equivalent | Absent | Actual validated element/attribute types, IDs and supplied/defaulted distinction; engine/provider change. |
| XSD construct conformance | 16 exploratory pairs | Versioned fixture catalogue, independent reference outcomes, defect tracking, tested limitations. |
| Cancellation | Before/after initialization only | Preserve checkpoint semantics; add worker/process termination for hard deadlines. |
| Resource disposal | Explicit idempotent disposal; tracked cycles | Episode ownership, worker/provider shutdown, child sessions, queued/inflight requests defined and tested. |
| Browser/Node packaging | ESM/CJS, ES-only declarations, native browser ESM peer tested | Repeat actual packed-consumer and three-browser verification for each new provider and adapter. |

`SchemaFactory` supports resolver/error configuration, schema sources and source sets, and a special hint-driven mode. Factory resolver/error handlers do not automatically become validator handlers. Feature/property inheritance differs from callback inheritance. XMLWeave should prefer immutable configuration snapshots and explicit per-session overrides. A provider registry can replace Java’s class-loader discovery without imitating its global configuration machinery. [Java SchemaFactory](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/SchemaFactory.html)

## 4. Important behavioral details

### Sources, provenance, encoding, and output

Use discriminated structural source objects, for example text plus `systemId`, bytes plus encoding policy, DOM document/element, and event source. Keep declarations free of ambient DOM/Node types. A URL is an identifier unless an application explicitly resolves it; do not make `systemId` trigger fetch or file access. Java’s LS input can carry data and identifiers/base URI separately; this distinction matters for imported schemas and useful diagnostics. [Java LSInput](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/org/w3c/dom/ls/LSInput.html)

Current serialize-before-WASM loses original lexical layout, may alter namespace declarations, and makes engine line/column coordinates refer to a generated representation. `ErrorDetail.file` exists upstream but XMLWeave drops it. A safer improvement is to inspect a preflight DOM yet feed the unchanged original string to the engine, with explicit UTF-8 handling because input is already decoded. Prove encoding declaration behavior before that change: declaration `encoding="ISO-8859-1"` must not reinterpret a JavaScript Unicode string as raw Latin-1 bytes. Preserve CRLF and non-ASCII test evidence; absent engine columns must remain absent. DOM-derived input should identify coordinates as generated or supply node paths, not invent source positions.

Byte support must have an explicit encoding scope. A UTF-8-only adapter with fatal decoding and BOM/declaration checks is a useful first slice, but must remain marked partial versus Java byte-source support. Full XML byte-source parity includes XML encoding detection and supported encodings; do not hide incorrect decoding behind `TextDecoder` defaults. The engine’s `fromBuffer` is a capability candidate, not permission to bypass XMLWeave’s DTD/security preflight.

For DOM subtrees, serialization alone can lose ancestor namespace bindings needed by QName-valued content (`xsi:type`, values typed as QName) or inherited `xml:base`. Define standalone-root validation and materialize only required context. Java does not guarantee a copied DOM result; XMLWeave should choose a predictable default of returning a new document and require an explicit mutation option if ever supported. Transforming or serializing valid input is not schema augmentation.

### Diagnostics and policies

Retain `{ valid: false, diagnostics }` for schema-invalid but well-formed XML. Preserve separate operational errors for malformed XML, schema compilation, denied resource, unsupported capability, cancellation, disposed handle, and internal engine failure. Add invalid-argument, resource-limit, and timeout distinctions instead of calling every invalid option an invalid XML document. Existing `diagnostics()` also loses `XmlError.line/column`, because it looks only for engine `details`; address both sources.

Java’s `ErrorHandler` distinguishes warning, error, and fatal error. Successful engine parsing has a public warnings collection that XMLWeave currently ignores. However, `XsdValidator.fromDoc/validate` discard collected diagnostics when native status indicates success. Complete compile/validation warning visibility therefore needs upstream API work or an extended provider. Delivering accumulated diagnostics to a JS callback after native completion cannot honestly promise fail-fast CPU termination. Callback exceptions must preserve identity/cause and release all native resources. [SAX ErrorHandler](https://docs.oracle.com/en/java/javase/25/docs/api/java.xml/org/xml/sax/ErrorHandler.html)

Native engine error domain/code are not exposed by the package’s `ErrorDetail`; use XMLWeave’s stable categories now and add native fields only when a provider actually supplies them. Never parse English engine messages to invent stable error codes.

### Resource resolution and schema composition

Java’s resolver receives resource type, namespace, public ID, system ID, and base URI; a null return permits normal resolution. XMLWeave should intentionally use deny-on-unresolved semantics instead. Application resolver code may do I/O by explicit choice, but XMLWeave must never silently fall back. [LSResourceResolver](https://docs.oracle.com/en/java/javase/25/docs/api/java.xml/org/w3c/dom/ls/LSResourceResolver.html)

Resolve and bound a graph before native compilation when callbacks are asynchronous. Every schema document, including resolver results, needs XML-aware DTD/XInclude/XSD-version policy checks and per-document/aggregate limits. Preserve canonical absolute identities and base resolution; record original requested identifiers for diagnostics. Cache resource bytes by canonical identity, but do not cache chameleon schema components solely by URI: the same no-namespace schema can contribute to different target namespaces. Permit legitimate graph cycles with deduplication and engine validation; reject exhausted graph budgets rather than all cycles by default.

Missing `schemaLocation` on an import is legal and cannot be intercepted by the package’s filename-only input callback. A namespace catalogue/explicit schema set needs a deliberate strategy and tests. A generated import entry schema can be appropriate for multiple roots, but same-namespace source sets, duplicate declarations, no-namespace roots, `redefine`, and source order need engine-specific evidence. XSD component assembly has namespace and derivation rules that cannot be reproduced by concatenating children or renaming prefixes. [XSD 1.0 structures](https://www.w3.org/TR/xmlschema-1/#layer2)

Treat any denied or unresolved requested resource as a policy failure even if libxml2 continues with a warning and returns a grammar. A resolver miss must not accidentally produce an apparently successful partial schema. Avoid throwing through a native callback if upstream cleanup is not exception-safe: record callback failure, return the defined failure status, and raise a structured error after native unwinding. Tests must cover every path.

Security configuration is not just `NONET`: custom input providers can read resources independently of that parser flag. Java’s external-access properties also have resolver-specific behavior, so port the intended no-I/O policy instead of assuming identical names imply identical security. [JAXP security guide](https://docs.oracle.com/en/java/javase/25/security/java-api-xml-processing-jaxp-security-guide.html)

### Lifecycle, concurrency, reset, and cancellation

Current native validation allocates a fresh native validation context for every call, validates a document/subtree, frees the context, and retains the compiled schema. That already avoids carrying validation state between ordinary calls. The JavaScript facade’s async method has no internal await during validation, so calls currently execute synchronously in one realm; `Promise.all` is not parallel CPU validation. [Pinned engine validator implementation](https://raw.githubusercontent.com/jameslan/libxml2-wasm/v0.7.2/src/validates.mts)

A new session API should keep grammar ownership separate from mutable callbacks/policies. Define what happens when a grammar is disposed with sessions alive: preferably invalidate new operations immediately and retain native memory only until an in-flight isolated operation finishes/terminates. Reset restores creation-time policy; it is not a native reset method requirement when contexts are freshly allocated. Reject same-session reentrancy and disposal/reset during callbacks with stable state errors; independent sessions may queue safely on a shared provider.

Compiled WASM pointers are not transferable to other JS workers. A pool needs per-worker compiled copies or opaque handles in the owning worker. Shared immutable schema *configuration* is not cross-worker shared native memory. Hard cancellation requires terminating an owning worker/process and invalidating its handles; a timer on the same blocked thread cannot do this. Distinguish cooperative abort, timeout, crash, and forced disposal. Do not promise a hard WASM memory quota from JavaScript-side input limits.

### Streaming and type information

Java’s handler validates SAX events as they arrive, forwards possibly augmented events, resets on `startDocument`, and supplies prefix-mapping semantics. A schema validator may need to retain identity-constraint state until an element/document closes. XMLWeave must not promise constant memory for arbitrary key/unique/keyref schemas; it should promise no full-document buffering, bounded transport queues, and measured/schema-dependent validation state. [Java ValidatorHandler](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/ValidatorHandler.html)

The current `streamXml` has no document-start/end or prefix-mapping event kinds and event objects carry no locator. Build a validation event protocol or adapter that supplies these requirements explicitly. Text fragmentation must not affect validity or type determination. Early events are provisional: a late keyref or malformed suffix invalidates the document. Backpressure, early consumer exit, source failure, and abort must release parser, native handler, iterators, and resolvers.

Portable type information is smaller than complete PSVI, but still substantial: element/attribute type metadata, ID determination, and whether attributes were supplied or defaulted. For unions, the element type available at the start can differ from the selected member type at the end. Metadata must describe the actual validated instance, including `xsi:type`, substitutions, anonymous/derived types and error recovery. Schema declaration lookup by element name cannot substitute for this. [Java TypeInfoProvider](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/javax/xml/validation/TypeInfoProvider.html)

`TypeInfo` includes type name, namespace, and derivation queries. JavaScript can offer immutable metadata snapshots plus a derivation query against the compiled grammar rather than ephemeral callback-only methods, provided the semantic mapping is documented. Full provider-specific PSVI properties such as schema component objects, validation-attempted state, and normalized actual values are separate additions. [DOM TypeInfo](https://docs.oracle.com/en/java/javase/27/docs/api/java.xml/org/w3c/dom/TypeInfo.html)

## 5. Engine feasibility and decision gates

| Approach | What it can actually deliver | Constraints / gate |
| --- | --- | --- |
| Existing public libxml2-wasm surface | Whole-document and element validation; source URL; byte parsing; structured diagnostics on failure; optional global in-memory input provider | No exported incremental schema handler, per-context schema resolver, validation-options setter, or typed result interface. |
| Existing package inside dedicated worker realm | Safe ownership of global resolver callbacks; composition graph; isolation; hard termination; useful whole-document provider | Requires actual browser and Node worker packaging. Does not create streaming/type-info APIs. |
| Private copied package module graph | Independent WASM singleton if every internal module resolves privately | Fragile module/bundler packaging, extra runtime copies and attribution; not preferred over workers. A query on only the top-level import is insufficient isolation. |
| Extended/rebuilt libxml2 WASM | Native schema SAX pipeline, per-context loader, selected validation options, fuller errors | Toolchain/build/reproducibility/license maintenance; type metadata needs separate proof, not assumed from native fields. |
| Optional Java subprocess provider | Real JAXP validation, SAX handler, resolver, augmentation/type-info; standards-reference oracle | Node-only; installed JVM or runtime distribution; IPC, startup, lifetime, cancellation and encoding work. Browser gaps remain. |
| Alternative browser-compatible XSD provider | Could cover remaining contract if proven | Requires current capability, license, runtime, size and conformance spike; not a package-name guess. |

The pinned engine uses one module-level WASM instance and global input callbacks. Its cleanup removes **all** registered providers; it cannot restore another consumer’s registrations. Never implement scoped resolution with `register; compile; cleanup` in the shared default instance. A dedicated worker owns its whole engine realm and may safely manage that registry. The package compiles without threads and without XML catalogs; a JS catalogue should be an explicit resolver feature. [Pinned engine bridge](https://raw.githubusercontent.com/jameslan/libxml2-wasm/v0.7.2/src/libxml2.mts), [Pinned package build configuration](https://raw.githubusercontent.com/jameslan/libxml2-wasm/v0.7.2/package.json)

Native libxml2 documents `xmlSchemaSAXPlug`, `xmlSchemaValidateStream`, and per-context `xmlSchemaSetResourceLoader` (since 2.14), but these are absent from the installed wrapper exports. They are evidence for a rebuild spike, not present XMLWeave capability. [Native schema APIs](https://gnome.pages.gitlab.gnome.org/libxml2/html/xmlschemas_8h.html)

Native `XML_SCHEMA_VAL_VC_I_CREATE` supports creation of default/fixed attribute or element text nodes; the package does not expose setting it. That makes augmentation plausible through an extension, not available today. A `psvi` field in native DOM structs does not establish a complete populated/stable TypeInfoProvider API. Native schema implementation contains unfinished PSVI exposure notes, and no such public typed callback is surfaced by the package. Plan a real metadata spike or a provider change. [Native option definition](https://raw.githubusercontent.com/GNOME/libxml2/v2.14.6/include/libxml/xmlschemas.h), [Native validation implementation](https://raw.githubusercontent.com/GNOME/libxml2/v2.14.6/xmlschemas.c)

Gate A (composition): resolve include/import/redefine in an isolated engine, preserve source identity, deny missing resources, and leave a separately registered host provider intact. Cover two concurrent schemas with identical resource names and different contents. If isolation cannot be proven, do not ship composition on the shared provider.

Gate B (advanced): execute an early-error streaming fixture before EOF, a large repeated-element input with no identity constraints showing no document-sized retention, and a late keyref failure. Return actual union-member and xsi:type metadata, defaulted attribute flags, and augmented output. If native streaming works but type metadata fails, those are separate capability results; select another provider or implement the missing bridge. The engine/provider implementation stories stay open.

Gate C (Java option): first use Java as a development oracle. A production bridge is feasible if explicitly branded Node-only and optional. Use a length-delimited protocol, no shell interpolation, bounded messages/queues, source/resource bytes on pipes, pinned provider identity, and process termination. A single document-at-a-time process is simpler initially; persistent grammar handles need reset/ownership tests. Do not place arbitrary user paths in Java command arguments or let Java resolve unapproved resource identifiers. Browser support remains an independent requirement.

## 6. Epics and implementation-ready stories

Priorities: P0 establishes correctness/architecture gates; P1 is required parity delivery; P2 is optional extension. Dependencies name story IDs, which can be mapped directly to GitHub issues. Each story must include the existing packed-consumer/type/browser checks relevant to its public surface. All implementations preserve no npm publication without separate authorization.

### E1 — Contract, capabilities, and independent evidence (P0)

**V1.1 — Publish the parity contract and capability model.** Deliver the mapping matrix, provider identity/version, XSD language level, source/result families, resource policy, streaming/type-info/augmentation flags, and explicit unavailable-feature error. Acceptance: current provider reports false for unavailable features; invalid/unknown options fail; documented APIs contain no claim of full Java or XSD conformance. Dependencies: none.

**V1.2 — Establish XSD regression and Java differential harness.** Promote the 16 audit pairs; extend the construct catalogue in section 7; run equivalent schema/document fixtures against pinned XMLWeave and JDK providers. Acceptance: machine-readable provider/version/fixture/outcome results; schema compilation failure distinguished from instance-invalid; engine differences are tracked rather than changing expectations until both pass. Java absence produces an explicit skipped optional local oracle, while the designated CI oracle lane is required. Dependencies: V1.1.

**V1.3 — Integrate versioned conformance corpus and defect policy.** Select XSD 1.0 cases from a versioned upstream corpus with original metadata/license. Acceptance: exact suite revision and selected/unsupported/failing counts recorded; known failures have issues; changes cannot silently reduce selected coverage. No certification claim from a curated passing subset. Dependencies: V1.2.

### E2 — Sources, diagnostics, and predictable sessions (P0/P1)

**V2.1 — Preserve source identity and original coordinates.** Add text source/system ID; keep preflight but preserve input text into engine with correct decoded-string encoding behavior. Carry engine file and core locations into diagnostics with phase and source kind. Acceptance: multiline/CRLF/Unicode schema+instance fixtures point to the original source; imported-file diagnostics later reuse this contract; unknown coordinates stay absent. Dependencies: V1.1.

**V2.2 — Add strict diagnostic/error policies.** Add bounded diagnostics, warning visibility available from provider, optional throwing adapter and post-operation observer. Acceptance: invalid result versus operational exception is stable; callback throws preserve identity and release resources; truncation is explicit. Missing immediate callback/warning capabilities remain false until V6.1. Dependencies: V2.1.

**V2.3 — Introduce independent validation sessions.** Separate grammar/configuration from session options; support reset and convenience validation; define busy/disposed state and grammar-child ownership. Acceptance: alternating valid/invalid documents and two sessions cannot leak state; reset restores defaults; reentrant callback attempts fail predictably; Promise concurrency does not corrupt ownership; failed operations leave subsequent validation usable. Dependencies: V2.2.

**V2.4 — Support DOM documents and elements.** Serialize/bridge XMLWeave DOM safely, preserve inherited namespace context, and validate an element as a standalone validation root. Acceptance: document versus subtree results, QName-valued attributes/content, inherited namespace/xml:base, no input mutation, invalid-node types, and core limits tested. Dependencies: V2.1.

**V2.5 — Support byte and bounded iterable sources.** Define encoding detection/decoding, BOM, declaration mismatch, iterator ownership, and total-byte/text limits; expose buffered operation honestly until incremental provider exists. Acceptance: UTF-8, UTF-16 required XML cases, malformed sequences, non-ASCII and split code units/chunks; source failure/abort/early return closes iterator. Dependencies: V2.1, V3.1. If delivered UTF-8-only first, keep remaining encoding story open.

### E3 — Safe resource resolution and schema sets (P0 gate, P1 delivery)

**V3.1 — Implement bounded resolver graph and URI contract.** Support immutable resource map plus explicit async resolver, canonical IDs/base, namespace-only imports, resource count/depth/bytes/request budgets, provenance, and strict unresolved policy. Acceptance: nested relative paths, URI aliases, escaped/Unicode IDs, duplicate identities, cycles, chameleon namespaces, cancellation, mutation-after-compilation and no fallback tested. Dependencies: V1.1, V2.1.

**V3.2 — Prove and implement isolated composition provider.** Dedicated worker/native engine instance with controlled resource callbacks. Acceptance: Gate A passes in Node and three browsers, host global providers remain intact, failed callback/compile releases all owned handles, worker shutdown is deterministic, bundle/import-map setup is reproducible. Dependencies: V3.1.

**V3.3 — Deliver include/import/redefine and schema-set compilation.** Feed a real resource graph to engine, preserving per-document context. Acceptance: same/different/no target namespaces, namespace mismatch, locationless imports, legitimate cycles, redefine restriction/extension, duplicate components, two roots for same namespace, multi-namespace roots, invalid imported schema location and cache identity tests. Document native semantics where JAXP allows provider variation. Dependencies: V3.2, V1.2.

**V3.4 — Deliver controlled instance-hint validation.** Separate explicit-schema and opt-in dynamic modes with resolver-only hints and bounded caches. Acceptance: `schemaLocation` namespace/location pairs, malformed pairs, `noNamespaceSchemaLocation`, conflicting/missing hints, root namespace mismatch, repeated documents and no implicit network/file access. Default policy remains explicit and secure. Dependencies: V3.3.

### E4 — Engine extension and provider architecture (P0)

**V4.1 — Run advanced provider spike and record a binding decision.** Prove Gate B against extended libxml2 or another browser-capable engine and optional JDK adapter; measure build/toolchain/size/licensing implications. Acceptance: source code and executable evidence for streaming, augmentation, metadata, diagnostics, resolver isolation; each independently marked pass/fail/unavailable. Decision must select delivery route for every failed mandatory capability, not declare it out of scope. Dependencies: V1.1, V1.2.

**V4.2 — Build reproducible advanced engine integration.** Implement chosen exports/provider, pinned build inputs and attribution, public typed capability boundary, and packaged runtime assets. Acceptance: fresh build/installation on CI; no undocumented private import dependency; no automatic Java requirement in core/browser; upgrade and rollback fixture results. Dependencies: V4.1.

**V4.3 — Implement optional Node Java provider if selected.** Process protocol, source/resolver forwarding, compiled handles, diagnostics, version detection, crash/timeout handling and shutdown. Acceptance: missing Java is a stable optional-provider error; paths/content cannot change command structure; hard kill releases handles; true handler/type-info probes pass. Dependencies: V4.1, V2.3. This story is conditional architecture, not an excuse to close browser parity.

### E5 — Genuine incremental validation (P1)

**V5.1 — Define namespace-aware validation event protocol.** Document document lifecycle, names, prefix bindings, attribute collections, locator, character fragmentation, allowed calls and provisional output. Acceptance: invalid event sequence/namespace state is rejected; adapters cover existing `streamXml`; no required ambient DOM/Node globals. Dependencies: V1.1, V4.1.

**V5.2 — Implement native incremental validator and event forwarding.** Use real engine handler, not concatenation or per-subtree independent validation. Acceptance: fail on impossible child before EOF; report late keyref at correct completion; reset between documents; every chunk boundary produces equivalent validity; memory test excludes document-wide buffering while accounting separately for identity tables. Dependencies: V4.2, V5.1.

**V5.3 — Implement pull streams, backpressure, cancellation and teardown.** Async input/output adapters with bounded queues and final completion promise/result. Acceptance: slow consumer controls reading, early consumer return closes upstream, source rejection/abort/timeout releases native handler, partial output never reports whole-document validity, two sessions remain isolated. Dependencies: V5.2, V7.1.

### E6 — Augmented output and portable type information (P1)

**V6.1 — Expose native diagnostic callbacks and full warnings.** Compiler and validator callbacks distinguish warning/error/fatal and permit defined interruption. Acceptance: compile and validation warnings on successful operations, first-error/collect modes, callback exception identity, bounded collection and native cleanup tested. If native stop cannot be safe, select provider support and keep parity flag false until solved. Dependencies: V4.2, V2.2.

**V6.2 — Deliver validated text/DOM/event outputs.** Choose consistent copy semantics; implement schema defaults/fixed values/whitespace normalization and namespace declarations through engine. Acceptance: supplied values versus defaults, missing required attrs, default element content versus absent element, QName defaults, mixed content, comments/PIs according to declared preservation contract, invalid partial results and no unintended input mutation. Dependencies: V4.2, V2.4, V5.2.

**V6.3 — Deliver TypeInfoProvider-equivalent metadata.** Return immutable type identity, derivation access, ID status, supplied/defaulted attributes, and start/end element semantics. Acceptance: union selected member, xsi:type, anonymous types, restriction/extension/list/union, substitution groups, IDs derived from ID, defaults, wildcard skip/lax, invalid-instance unknown metadata. Retained snapshots must not access disposed native pointers. Dependencies: V4.2, V5.2, V6.2.

**V6.4 — Complete source/result compatibility adapters.** Publish text/byte, DOM, push-event and pull-event mappings with no-result mode and deliberate unsupported combination errors. Acceptance: one end-to-end test per supported pair plus rejected mismatches, source/output ownership and encoding tests. Dependencies: V2.5, V5.3, V6.2, V6.3.

### E7 — Limits, isolation, and operational reliability (P1)

**V7.1 — Implement worker/provider execution budgets.** Per-document/graph/diagnostic/queue limits; separately enforce deadline by worker/process termination; define affected handle state. Acceptance: timeout on deliberately expensive isolated fixture; main event loop remains responsive; other providers unaffected; already-aborted and initialization-aborted requests behave consistently; no worker or iterator leak. Dependencies: V3.2, V2.3.

**V7.2 — Verify lifecycle and provider coexistence.** Extend 100-cycle ownership checks to schema graphs, sessions, failures, observers, streaming, reset, timeout and disposal. Acceptance: no outstanding tracked handles; stable registry behavior with unrelated host engine consumers; memory samples distinguish JS heap/WASM high-water/RSS; native allocator growth is not falsely called a leak or proven absent by wrapper counters. Dependencies: E3, E5, E6, V7.1.

### E8 — Cross-runtime delivery and honest completion (P1)

**V8.1 — Verify actual packaged artifacts and migration docs.** ESM/CJS, ES-only TypeScript, optional peers, three browsers, Node support lanes, worker assets/import maps/CSP guidance, license inventory. Acceptance: examples run from packed package; core import never loads schema/JVM runtime; old convenience API retained or migration explicitly versioned. Dependencies: delivered provider/adapters.

**V8.2 — Close the parity ledger with independent review.** Every matrix row links implementation, tests and runtime coverage; all observed conformance differences link open issues or approved decisions. Acceptance: advanced streaming/type-info/browser gaps remain open until genuinely satisfied; no claim of universal XSD conformance; issue/epic closure follows acceptance evidence. Dependencies: all mandatory stories above.

Optional P2 stories, outside the Java baseline: XSD 1.1 provider; RELAX NG provider; full provider-specific PSVI; XML catalog document syntax beyond explicit map/resolver; implicit transport helpers with opt-in network policy. DTD support would require a separately approved change to the established parser safety contract and is not needed for `javax.xml.validation` API parity.

## 7. Fixture catalogue and verification strategy

The conformance catalogue should include positive, negative, and invalid-schema cases, not just successful examples:

- **Names/content:** target namespaces and form defaults; qualified/unqualified elements and attrs; sequence/choice/all; nested groups; min/max occurrences including zero/unbounded; mixed/simple/empty content; references; substitution groups; abstract declarations/types; block/final; complex and simple restriction/extension; UPA and illegal derivations.
- **Datatypes/facets:** integer ranges and arbitrary precision lexical cases; decimal versus float/double including INF/NaN; boolean; date/time/timezone/duration boundaries; whitespace preserve/replace/collapse; enumeration; exact/min/max length; inclusive/exclusive bounds; total/fraction digits; XML Schema regex differences from JS; list and union; base64/hex; QName/NOTATION; ID/IDREF/IDREFS and derived IDs. These are XSD datatype requirements, not permission to coerce values into JS Number/Date. [XSD 1.0 datatypes](https://www.w3.org/TR/xmlschema-2/)
- **Instance controls:** xsi:type derivation and forbidden values; xsi:nil versus nillability/content; defaults/fixed on elements and attributes; any/anyAttribute namespace constraints and strict/lax/skip; key/unique/keyref including duplicates, absent fields, typed-value equality, multi-field keys, forward references and end-of-scope failures.
- **Composition:** nested relative resources, namespace mismatch, no-namespace/chameleon schemas, circular includes/imports, namespace-only imports, duplicate schema identity, multiple roots, redefinition, malformed dependency, schema graph limits, resolver exception, absent dependency, observer provider preservation.
- **Source/reporting:** LF/CRLF, Unicode, bytes/BOM/declarations, text declarations, metadata system IDs, DOM document/subtree, QName bindings inherited from ancestors, original-versus-generated coordinates, warning-only operations, multiple independent errors, stable error categories and optional unavailable columns.
- **Pipeline:** chunk boundaries at every lexical boundary; text split inside simple content; delayed invalid child and late keyref; defaulted namespace declaration; union start/end type distinction; malformed suffix; no-result/result equivalence; backpressure; abort while waiting for input and hard timeout during CPU work.
- **Operational:** mutate supplied options/maps after compile; reset/reuse; reentrant callback; dispose before/during/after work; worker crash; Java unavailable; out-of-band resolver failure; callback throwing; repeated mixed ESM/CJS usage and independent providers.

Use W3C suites as external evidence with versioned metadata and appropriate licenses. The W3C XSD repository explicitly warns that its tests focus on validity outcomes and do not verify all PSVI or diagnostics requirements; therefore the pipeline/metadata suites above are still necessary. Avoid claiming certification from modified or selected tests; record the actual corpus license before vendoring. [W3C XML Schema test-suite entry point](https://www.w3.org/XML/2004/xml-schema-test-suite/), [W3C xsdtests scope](https://github.com/w3c/xsdtests), [W3C test-suite licenses](https://www.w3.org/copyright/test-suites-licenses/)

## 8. Decisions that can proceed now, and actual remaining uncertainty

Proceed without owner interruption on the portable XSD 1.0 baseline, explicit deny-by-default resource resolution, immutable source/option snapshots, safe workers, Java differential tests, preserving the convenience API, and honest capability flags. These follow the existing project contracts and the user’s expanded authorization.

The unresolved engineering decision is the browser-capable provider for genuine streaming plus actual type information. The present public package cannot provide them. That is a deliverable spike/implementation dependency, not currently an external blocker: investigate and build the adapter or replacement. Java provides a feasible Node route but cannot satisfy browser acceptance alone. Only if no acceptable browser-capable implementation can be built within agreed dependency/licensing/platform constraints should the owner be asked to choose between a larger engine project and a reduced platform contract. Do not ask that speculative question before the concrete spike evidence exists.

A practical parallel implementation split is (a) portable facade, diagnostic/source improvements and conformance fixtures, (b) worker-isolated schema graph composition, and (c) an explicit optional Node Java provider for real handlers, typed snapshots and augmentation. A provider-specific capability contract is strongly preferable to claiming pure-JavaScript parity that does not exist. It describes each delivery accurately; it does not by itself complete the user's broader cross-runtime objective. Keep browser advanced delivery issues open and dependency-linked while those three tracks progress. Installing core must never require Java; selecting the optional Java provider may require a documented Java runtime and should report absence directly.

The final completion message should distinguish implemented API parity, measured XSD fixture coverage, intentionally different safety/API semantics, and any still-open provider/platform gaps. “All planned work completed” is false while mandatory rows or advanced browser stories remain open.
