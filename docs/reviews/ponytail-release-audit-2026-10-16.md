# Ponytail release audit

What this repo does: XMLWeave provides bounded XML processing and Java-style
XSD 1.0 validation across Node and browsers. This audit assumes the documented
input, graph, queue and execution limits.

Revalidated the release changes against `d167d4b`, reusing the unchanged
[whole-repository baseline](ponytail-audit-2026-10-16.md). Traced source admission,
hint resource/cache ownership, cancellation, worker disposal, Java diagnostics,
typed default references, output suppression, package inclusion and release steps.

## Corrected finding

1. Cancelled hint calls could retain admission while waiting on shared work;
   releasing them without resource reservations could then grow unresolved
   distinct resources. Cancellation-aware waits, removable queue entries and
   pending-resource admission now bound both lifetimes. Tests verify same-URI
   sharing, distinct-resource rejection, successful/failed reservation release,
   already-aborted calls and no overlap with active validation.

Independent verification: seven cancellation/reservation tests and eleven Java
default-reference tests pass. Java behavior retains actual selected types,
forward references, per-episode isolation, exact diagnostic decisions and no
invalid output artifact. The mixed lifecycle test covers 100 episodes and actual
worker-port cleanup without calling memory high-water retention a proven leak.

Package review confirms the public registry/version are explicit, native runtime
assets ship once, optional Java/legacy/XSLT boundaries remain explicit, and no
credentials or development artifacts appear in the inspected inventory.

No remaining confirmed must-fix finding in the reviewed release paths.

Verdict: Healthy; proceed through required remote and registry gates.

Not checked: Final remote CI, clean pinned rebuild comparison and npm registry
verification are release gates rather than conclusions of this read-only audit.
No universal standards or upstream-engine security certification is claimed.
