# Ponytail final publication review

What this change does: Corrects late review findings before the first npm
publication. It observes shared rejections before cancellation admission,
removes unnecessary Java text retention, preserves diagnostic source fallbacks
and retains clean-rebuild evidence when acceptance fails.

Scope: final change against `c0055f0`, its connected callers, tests, package
contents and release workflow. Assumed load follows the documented bounded XML,
resource and queue limits. Earlier release review is retained as a dated snapshot.

## Findings corrected

1. Aborted/disposed calls could leave an already-created shared promise without
   a rejection observer. Two strict-Node child cases reproduced process crashes.
   The wait helper now attaches an observer before the admission guard while
   awaiting the original promise, preserving successful values and error identity.
2. Java default-reference checking retained text even for non-ID types. Buffer
   capture now follows actual start-type metadata and possible ID union members;
   the final selected type still decides whether a value is an ID. A deterministic
   real-JAXP callback probe verifies a large ordinary text leaf is not captured.
3. Provider diagnostics without their own ID lost the plain-source fallback.
   Metadata now preserves provider, normalized-source and caller fallback priority
   in returned, callback and thrown diagnostics.
4. Failed acceptance could skip comparison artifact upload. Non-cancelled runs
   now retain that evidence after failure.

The suggested broader native workflow trigger is not a missing current test:
ordinary CI already runs packed-browser validation on every PR. Native rebuilds
intentionally target native/compiler/build/release inputs and manual dispatch.
No hypothetical required skipped check was treated as a concrete defect.

Independent focused acceptance covers strict rejection behavior, cancellation,
source IDs, actual Java type capture and default references. The complete local
Node suite passes 338 tests. Both unchanged reference expectations and the
expanded packed-browser suite remain release gates.

Verdict: Ship after final remote CI/review and replacement-tarball verification.

Not checked: Registry publication and installation are still pending. The old
tarball was withdrawn after the late findings; its publish command is obsolete.
The change does not claim constant total JVM memory or universal XSD conformance.
