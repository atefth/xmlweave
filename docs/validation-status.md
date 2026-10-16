# Java validation parity: implementation and acceptance

The [requirements assessment](validation-parity.md) is a dated baseline, not a description of the current implementation. Delivery and acceptance are tracked on the [project board](https://github.com/users/atefth/projects/3). Independent review and the final coherent local package checks are complete. Required PR CI and merge remain the closure gates; this page does not claim an npm release.

| Contract | Implementation and evidence | Acceptance state |
| --- | --- | --- |
| Default XSD 1.0 validator | Packaged native Xerces; no Java or libxml peer required. The 43 original feature groups match 123 Java reference expectations. | Accepted locally; PR CI required |
| Sources and sessions | Original text/bytes/chunks/DOM, strict decoding, source IDs/provenance, immutable limits, independent sessions and bounded shared-grammar scheduling | Regression tests pass |
| Schema composition | Explicit canonical catalogue/resolver, include/import/redefine, schema sets, private workers, collision-free generated identities and generated-source provenance | Graph provenance and budget regressions pass |
| Incremental validation | Native SAX/PSVI and optional Java ValidatorHandler; bounded input/output backpressure, errors before EOF and late keyref checks | Node and packaged browser evidence |
| Type metadata | Actual selected types, xsi:type, IDs, specified/defaulted attributes, union/list and graph derivation answers | Native/Java tests pass, including anonymous identities and idle queries |
| Matching augmented outputs | Stream/DOM/SAX/StAX adapters; copied output DOM, native defaults/normalization and namespace-prefixes switch | Bound-QName/default-attribute roundtrips and PI preservation pass |
| Diagnostic handlers | Synchronous native boundary; Java request/decision acknowledgement; isolated shared-memory decision handshake | Exact handler transport and packed browser capability gating pass |
| Locations | Original source positions or explicit generated provenance; bounded supplied-event-point correlation with native coordinates retained | Regression tests pass; no invented lexical offsets |
| Dynamic instance hints | Per-document approved root/descendant hints, inherited base resolution, immutable pinned catalogue and bounded LRU/native worker cache | Seven focused tests pass; packaged browser cases included |
| Hard budgets | Native worker deadlines/abort, source/resolver deadlines, depth 256, nodes 100,000 and bounded queues | Integrated regression tests pass |
| Conformance evidence | 13 complete pinned W3C/NIST groups: 65 unchanged instances, 40 valid and 25 invalid, across eight datatype families; original metadata/license/hashes retained | Node and all three browser engines passed selected corpus |
| Packaging | Explicit provider entry points, ESM/CJS identity, ES-only declarations on TypeScript 5.9.3/7.0.2, native assets/licenses and pinned rebuild inputs | Final packed consumers pass on both supported TypeScript versions |

The final coherent build passes **236 Node tests**, **345 packed validation-browser assertions** (115 each in Chromium, Firefox and WebKit), packed consumer checks on **TypeScript 5.9.3 and 7.0.2**, and **123 Java reference expectations**. These runs include the final anonymous-type queries, namespace/default-output repairs, exact diagnostic handlers, cancellation and Ponytail budget regressions. Native source and runtime hashes match the pinned rebuild provenance.

There are currently 13 executable public entry points plus the package metadata export; the README lists each companion explicitly.

The previous default engine incorrectly accepted invalid base64; the native default rejects it. See the [base64 defect](https://github.com/atefth/xmlweave/issues/68). QName defaults are compared against Java in the [differential investigation](https://github.com/atefth/xmlweave/issues/69); provider validity, namespace context and collected-output behavior are separate acceptance concerns. Fixtures are not changed to make providers agree.

Native warning callbacks reach the diagnostic boundary, including when retained diagnostics are capped. No naturally successful warning-only XSD fixture has been found under this secure configuration. Instrumented native/worker-boundary warning and fatal tests establish transport ordering, handler continuation/throw behavior and teardown; they are explicitly not observed conformance conditions. Real native error fixtures separately establish engine integration.

A push handler object processes one document. A reusable grammar creates a fresh handler for each episode: this is the deliberate JavaScript lifecycle mapping, not automatic reset of the handler object. Supplied event locators identify declared event points. Decoded event text cannot recover original entity spellings or arbitrary original per-character columns. Native generated coordinates remain available alongside event correlation, ambiguity, missing metadata and expired-window status.

Dynamic hint discovery buffers each bounded document to discover approved descendant hints before choosing its schema set. Explicitly compiled providers supply true incremental validation when the grammar is already known. Hint identifiers never imply network or filesystem access; explicit map/resolver approval remains mandatory.

Exact isolated diagnostic handlers require SharedArrayBuffer and Atomics in a worker. Node supports this directly; browsers require verified cross-origin isolation and matching COOP/COEP/resource headers. Ordinary observers have no such requirement. Missing prerequisites reject the requested exact capability explicitly; main-thread code never blocks with Atomics.wait.

The Java companion deliberately binds the tested OpenJDK-derived Java 17+ built-in Xerces implementation and its XS graph, with an explicit module export supplied by the launcher. It is not a claim to support arbitrary custom JAXP providers or all JDK distributions.

These are measured API/runtime and selected-corpus results, not universal XSD certification, XSD 1.1 support, an npm publication.
