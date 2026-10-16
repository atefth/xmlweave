# Post-delivery requirements analysis

Reviewed merged delivery PR78 (main d167d4b) and its connected source/test/documentation
flows. This is a fresh requirements assessment, not a universal conformance claim.
Three independent analyses cover standards, practical API behavior and operations.
Ponytail full mode separates reproduced bugs, incomplete promised evidence and
optional improvements.

## Confirmed corrections before first publication

| Priority | Finding | Acceptance |
| --- | --- | --- |
| P2 | Annotation data was treated as active schema rules/dependencies | Ignore semantic directives inside appinfo/documentation; keep actual rules and document security checked |
| P2 | Schema @version was treated as an XSD language switch in graph/hint paths | Accept arbitrary metadata tokens including1.1; keep actual unsupported XSD1.1 constructs rejected |
| P1 | Stalled default source normalization could remain busy after abort | Abort settles promptly, closes upstream iterator and permits healthy session reuse |
| P1 | Shared hint resolution/compilation inherited one caller's cancellation | Aborting one caller does not cancel a healthy unrelated caller; shared work and queued episodes remain bounded |
| P2 | Pipeline source IDs/options admission were inconsistent | Preserve caller-declared source ID; reject invalid options before producer reads |
| P1 evidence | The100-cycle lifecycle check did not cover the whole promised mixed lifecycle | Repeat graph/session/stream/failure/observer/timeout/disposal; verify cleanup/coexistence; distinguish heap/RSS/WASM capacity |
| P2 docs | Acceptance ledger and onboarding still described pre-merge/source-only status | Link accepted delivery, explain entry-point choices, browser assets, disposal and verified release status |

The XSD1.0 schema version attribute is user metadata with no validation semantics:
[W3C XML Schema Structures Â§3.15.2](https://www.w3.org/TR/xmlschema-1/#element-schema).

## Improvements tracked separately

- Clean pinned native rebuild in CI: current CI verifies recorded source/runtime
  consistency and tests shipped assets; that alone does not prove an independent
  clean compiler rebuild. Add clean build plus native/packed-browser acceptance.
- Java compatibility evidence: CI currently installs Temurin17. Add later LTS lanes
  or narrow the documented tested range; later internal XS graph APIs are unverified.
- Broader external corpus: currently65 unchanged W3C/NIST instances across eight
  datatype families. Add complete pinned composition, identity and invalid-schema
  groups with original bytes/metadata and visible mismatches.

[W3C describes its full test suite](https://www.w3.org/XML/2004/xml-schema-test-suite/)
as collections with associated conformance metadata. Selected coverage is useful,
but does not establish complete XSD conformance.

XSD1.1, arbitrary Java providers, SOAP, signatures and generated object binding
remain separate scope. Documented secure resolution, bounded hint buffering and
browser cross-origin isolation are deliberate adaptations, not newly discovered bugs.

No npm release, full upstream-engine audit, indefinite stress run or universal
standards certification is implied by this assessment. Fix verification and final
release evidence are recorded in the release PR and Ponytail gate reports.
