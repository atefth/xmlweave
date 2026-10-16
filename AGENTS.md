# Contributor workflow

Use Ponytail in its default `full` mode for coding in this repository. Preserve
the user's complete requested behavior, validation, error handling and security.
Reuse existing helpers before introducing another layer or dependency.

Before creating a PR, run both `ponytail-review` on the final change and
`ponytail-audit` on the repository. Read their installed `SKILL.md` instructions;
do not substitute a formatter, linter or a claim that tests passed. The initial
whole-repository audit is recorded in `docs/reviews/`. Later reports must state
the revision and scope checked, reuse still-valid baseline evidence, and inspect
the affected data flows. Report concrete cases, not speculative style concerns.

Fix confirmed must-fix findings before creating or merging the PR. Put remaining
actionable findings on the project board with their impact and acceptance test.
Changes after a review require checking the affected findings and paths again.
Do not repeat unrelated test matrices when no code or evidence has changed.

Parallelize independent implementation and review work. Assign file ownership;
serialize native rebuilds, edits to the same files, and packaging operations that
replace `dist`. Build once, then run read-only tests and packed consumers against
that same verified build in parallel.

Keep issues, epics, milestones and board status synchronized. `In progress` means
work is underway; `In review` means a concrete change is under review; `Done`
requires its acceptance evidence and a merged change. Do not close an engine
spike as if it delivered every dependent capability.

Include Ponytail review/audit results and relevant tests in the PR description.
When merge is authorized, review, fix findings, pass required checks, merge, then
close the accepted issues and update the board. Do not add a redundant approval
step. Npm publication remains a separate action requiring explicit instruction.

See [development workflow](docs/development-workflow.md) for installation,
commands, evidence, and current plugin limitations.
