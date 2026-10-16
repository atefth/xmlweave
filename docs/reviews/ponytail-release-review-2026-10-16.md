# Ponytail release review

What this change does: Prepares XMLWeave 0.1.0 for its first authorized public
release. It fixes reproduced cancellation, diagnostic and schema-metadata bugs,
repairs a JDK default-reference defect in the optional Java adapter, and completes
the follow-up coverage and newcomer documentation.

Scope: release branch against merged baseline `d167d4b`; connected sources,
providers, tests, package exports, README, licenses and release/CI instructions.
The assumed workload is the documented bounded XML/graph/queue contract.

## Findings corrected before PR creation

1. Schema version labels and annotation payloads were interpreted as active
   language switches/directives. Semantic traversal now respects annotation
   boundaries while XML/DTD/security guards still inspect the whole input.
2. Default-source abort could leave pending normalization busy. The existing
   cancellation helper now closes the iterator and releases the session.
3. Hint work captured one caller's cancellation. Shared work now has factory
   ownership; removable caller waits release admission without growing orphan
   queues. Pending-resource reservations enforce catalogue limits too.
4. Pipeline admission and thrown diagnostics lost source information. Options
   are checked before producer reads; returned, callback and thrown diagnostics
   retain original source identity, while user callback exceptions keep identity.
5. JDK/Xerces omits some schema-default ID references from its document check.
   The adapter uses actual selected engine types and actual IDs to validate
   default references at EOF through the existing diagnostic protocol. This
   preserves forward references and does not invent datatype parsing.

The original 43 fixture groups are unchanged. The expanded catalogue contains
63 groups/183 Java reference expectations. Nineteen complete additional external
groups retain all 32 upstream expectations; native and repaired Java adapters
both pass. A separate unmodified JAXP observation retains its disagreement.

Independent checks include all 11 Java repair regressions, all seven hint
cancellation/reservation regressions, annotation/version checks and both README
validation examples. The 100-cycle mixed lifecycle regression checks actual
worker-port cleanup, interrupted iterators and provider coexistence. Memory
observations explicitly distinguish JS heap/RSS and observed WASM capacity.

No remaining confirmed must-fix finding in the reviewed release paths.

Verdict: Ship after required CI, clean rebuild review and exact-tarball checks.

Not checked: Remote Java 21/25, clean rebuild artifacts and registry verification
are separate required release gates, recorded in the release PR. Universal XSD
conformance, indefinite stress and upstream engine internals are not certified.
