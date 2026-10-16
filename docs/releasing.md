# Release workflow

The owner explicitly authorized the first public npm release on 2026-10-16.
Release preparation targets `xmlweave@0.1.0`; publication is complete only after
registry metadata and a clean registry-installed smoke test agree.

1. Finish confirmed requirement defects and record remaining improvements on the board.
2. Run both Ponytail review and audit. Resolve must-fix findings before creating the release PR.
3. Verify the final build, Node tests, Java reference expectations, packed consumers
   on both supported TypeScript versions and the three browser engines. Required CI
   checks must pass on the merged release revision.
4. Inspect `npm pack --dry-run --json`: public exports and both declaration formats,
   packaged WASM/worker/Java assets, native rebuild inputs, README, MIT license and
   complete bundled dependency notices. No credentials, local configuration or
   development artifacts belong in the tarball. Check the runtime dependency audit.
5. Set the release version in package and lockfile, remove the private safeguard
   for this authorized public release, and update the changelog and installation guide.
6. Pack the reviewed clean revision once. Record its integrity and file inventory;
   test that exact tarball in an independent application before publishing it.
7. The owner signs in using npm's browser login. Never commit or paste credentials.
   Publish the inspected tarball to the public registry with the intended version/tag.
   If npm requests interactive account verification, the owner completes it.
8. Query the registry's version, integrity and dist-tag, then install the registry
   package into a clean temporary application. Smoke-test ESM/CJS identity, core XML
   and native XSD validation without a Java installation or optional schema peer.
9. Record registry verification and tag the exact merged release revision. Only then
   describe the version as published in release notes.

The first release may be published interactively from the owner's verified machine.
No registry provenance attestation is claimed for a local publish. A future trusted
CI publisher can generate registry provenance after its npm trust configuration is
explicitly established; ordinary native source/runtime hashes are a different record.

Patch releases cover fixes. Before 1.0, breaking API changes increment the minor
version and include migration notes. Compatibility claims follow passing fixtures,
not every bundler, Java distribution or TypeScript configuration. The Java companion
is tested on Temurin 17; later OpenJDK-derived versions remain a separate coverage
improvement. No new dependency or implicit Java requirement is introduced by release.
