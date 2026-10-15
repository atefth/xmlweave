# Parser release checklist

This repository contains a development MVP. The checklist does not authorize npm publication.

- [x] Owner selected MIT for XMLWeave; LICENSE and package metadata record the decision (issue #11).
- [ ] Inventory runtime and transitive licenses against the exact lockfile; retain slimdom's complete notice in `dist/slimdom.LICENSE` and bundled legal comments.
- [ ] Confirm passing CI on Node 22/24 and Windows/Linux, TypeScript 5.9.3/7.0.2 consumer fixtures, and Chromium/Firefox/WebKit browser fixtures.
- [ ] Run `npm ci`, `npm run check` and `npm pack --dry-run`; inspect exports, both declaration formats, version, README, notices and absence of development-only files/secrets.
- [ ] Review API changes, record a changelog/version and migration examples, and test a clean tarball install in an independent application.
- [ ] Obtain explicit authorization for registry publication, configure restricted CI environment credentials or trusted publishing, provenance and two-person review where available; never commit tokens.
- [ ] Remove the private safeguard only for the authorized release and publish the reviewed artifact. Smoke-test the registry-installed version before announcing it.

Patch releases cover fixes; pre-1.0 breaking API changes increment the minor version and require migration notes. Supported combinations come from passing consumer fixtures, not blanket TypeScript compatibility. Failed release gates block distribution until fixed or explicitly documented with a narrower supported matrix.
