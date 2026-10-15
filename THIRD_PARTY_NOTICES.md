# Third-party inventory

Runtime: slimdom 4.3.5 — MIT — https://github.com/bwrrp/slimdom.js. Its complete license is included in the bundled implementation and `dist/slimdom.LICENSE`, as well as the dependency package. Preserve the copyright and permission notice when redistributing its code, including browser bundles.

Development/evaluation: @xmldom/xmldom 0.9.12 (MIT), esbuild 0.28.2 (MIT), TypeScript 7.0.2 (Apache-2.0), Playwright 1.64.1 (Apache-2.0). Transitive and platform-specific packages are pinned in package-lock.json; their original license files remain in their packages. Browser binaries are test tools and are not shipped in XMLWeave's tarball.

Optional XPath entry: FontoXPath 3.34.0 (MIT), prsc 4.0.0 (MIT), xspattern 3.1.0 (MIT). The separate XPath bundle retains complete license grants in its legal banner and `dist/fontoxpath.LICENSE`, `dist/prsc.LICENSE`, `dist/xspattern.LICENSE`.

Optional streaming entry: saxes 6.0.0 (ISC) and xmlchars 2.2.0 (MIT). The separate streaming bundle retains full notices in its legal banner and `dist/saxes.LICENSE` / `dist/xmlchars.LICENSE`. saxes' npm artifact omits its license file; `licenses/saxes.LICENSE` is an unchanged copy from the exact upstream v6.0.0 source tag: https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE.

External optional peers, not embedded in XMLWeave's distributed artifact: libxml2-wasm 0.7.2 (MIT wrapper plus bundled libxml2 notices in `LICENSE.libxml2`) and xslt-processor 5.1.2 (LGPL-3.0). Applications install these peers explicitly and retain their upstream licenses. See `docs/schema.md` and `docs/transformations.md` for exact packaging boundaries and source links. Browser test bundles are temporary verification fixtures, not distributed XMLWeave runtimes.

XMLWeave's own source is licensed under MIT in `LICENSE`; dependency notices retain their original terms and copyright holders.
