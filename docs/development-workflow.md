# Development and PR workflow

Ponytail is part of this repository's Codex workflow. Its purpose is the smallest
complete correct change. It must not remove requested behavior, boundary
validation or safe failure handling to reduce line counts.

## Codex installation

Install the upstream plugin, rather than copying a third-party rules file over
this repository's instructions:

```text
codex plugin marketplace add DietrichGebert/ponytail
codex plugin add ponytail@ponytail
```

The configured environment installed Ponytail 5.3.1. The plugin contains the
Ponytail, review, audit, debt, gain and help skills. A new Codex session loads the
installed skills; the desktop app may need a restart to refresh its plugin
catalogue. Current work can read and apply the installed skill instructions
directly, without restarting an active coding session.

Codex treats plugin lifecycle hooks separately from plugin installation. Review
and trust their current definitions through Codex's hooks UI if automatic
session/subagent activation is desired. Installation alone does not prove hooks
are trusted or active. This repository's `AGENTS.md` supplies the review/audit
gates even when lifecycle hooks are inactive. Do not edit a trust database or
silently bypass the host's review mechanism.

Sources: [Ponytail installation](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md#codex),
[official OpenAI plugin and hook guidance](https://developers.openai.com/plugins/build/plugins).

## Before every PR

1. Implement the requested behavior and run the relevant tests. Keep independent
   file ownership when using parallel agents.
2. Run `$ponytail:ponytail-review` against the final change and
   `$ponytail:ponytail-audit` against the repository. Read the connected code and
   callers, not just the diff. The first audit covers the whole repository;
   subsequent reports identify the revision, revalidate affected flows, and may
   reference unchanged baseline evidence explicitly.
3. Fix confirmed must-fix findings. Add other actionable findings to the board
   with concrete impact and acceptance criteria. Preserve review results and
   explain which findings were fixed.
4. Create the PR with the problem, resulting behavior, validation and review/audit
   evidence. Move the related work to review. A skill report is not CI and a green
   CI run is not a skill review.
5. Check the actual final diff, address findings and required CI failures, then
   merge when authorized. Update issue, epic, milestone and board completion only
   after acceptance and merge.

Do not create a new test framework or executable that pretends to run an LLM
skill. Ponytail review and audit are agent workflows. They can run in parallel
with independent tests and with each other. Rebuilds that replace `dist` must
finish before the packed artifact is consumed.

## Evidence

The initial reports are retained in `docs/reviews/`. Each records assumptions,
findings, the smallest correction, the consequence of leaving it unresolved,
and any unchecked scope. This is measured review evidence, not a promise that no
future standards or implementation bug exists.
