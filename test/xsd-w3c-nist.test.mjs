import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseXml } from "../dist/index.js";
import { compileIsolatedXercesSchema } from "../dist/schema-xerces-isolated.js";
const directory = new URL("./fixtures/w3c-nist/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", directory), "utf8"),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataCompressed = await readFile(
  new URL(manifest.metadata.storedAs, directory),
);
const metadata = gunzipSync(metadataCompressed);
const metadataText = metadata.toString("utf8");
function sourceId(source) {
  return `https://raw.githubusercontent.com/w3c/xsdtests/${manifest.revision}/${source.path}`;
}
async function original(source) {
  const bytes = await readFile(new URL("upstream/" + source.path, directory));
  assert.equal(
    bytes.byteLength,
    source.bytes,
    `${source.path}: original byte length`,
  );
  assert.equal(digest(bytes), source.sha256, `${source.path}: original SHA256`);
  assert.equal(
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
    source.gitBlob,
    `${source.path}: original Git blob`,
  );
  return { kind: "bytes", bytes, systemId: sourceId(source) };
}
function authoritativeTests(group) {
  const escaped = group.group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fragment = new RegExp(
    `<testGroup name="${escaped}">[\\s\\S]*?</testGroup>`,
  ).exec(metadataText)?.[0];
  assert.ok(fragment, `original metadata group ${group.group}`);
  const doc = parseXml(
    `<selection xmlns="http://www.w3.org/XML/2004/xml-schema-test-suite/" xmlns:xlink="http://www.w3.org/1999/xlink">${fragment}</selection>`,
  );
  return Array.from(doc.documentElement.firstElementChild.children)
    .filter((node) => ["schemaTest", "instanceTest"].includes(node.localName))
    .map((node) => ({
      name: node.getAttribute("name"),
      expected: Array.from(node.children)
        .find((child) => child.localName === "expected")
        .getAttribute("validity"),
    }));
}
test("pinned W3C/NIST copyright, original full metadata and complete selected expectations retain integrity", async () => {
  assert.equal(manifest.revision, "7bc3365c652a322f3d762021b3879eb92dae7e30");
  assert.equal(digest(metadataCompressed), manifest.metadata.compressedSha256);
  assert.equal(digest(metadata), manifest.metadata.sha256);
  assert.equal(metadata.byteLength, manifest.metadata.bytes);
  await original(manifest.copyright);
  assert.equal(new Set(manifest.groups.map((group) => group.datatype)).size, 8);
  assert.equal(manifest.groups.length, 13);
  for (const group of manifest.groups)
    assert.deepEqual(
      group.tests.map((item) => ({
        name: item.name,
        expected: item.expected.validity,
      })),
      authoritativeTests(group),
      `${group.group}: no instance filtering or changed validity`,
    );
});
for (const group of manifest.groups)
  test(
    `external W3C/NIST XSD1.0 group ${group.group}`,
    { timeout: 30000 },
    async () => {
      const schemas = group.tests.filter((item) => item.kind === "schemaTest");
      assert.equal(schemas.length, 1, "Selected groups each define one schema");
      const schema = schemas[0];
      const input = await original(schema.source);
      if (schema.expected.validity === "invalid") {
        await assert.rejects(
          compileIsolatedXercesSchema(input, { timeoutMs: 20000 }),
          { code: "INVALID_SCHEMA" },
        );
        return;
      }
      assert.equal(
        schema.expected.validity,
        "valid",
        "No unsupported metadata validity silently ignored",
      );
      const grammar = await compileIsolatedXercesSchema(input, {
        timeoutMs: 20000,
      });
      try {
        for (const item of group.tests.filter(
          (item) => item.kind === "instanceTest",
        )) {
          const instance = await original(item.source);
          const result = await grammar.validate(instance);
          assert.equal(
            result.valid,
            item.expected.validity === "valid",
            `${item.name}: unchanged upstream validity=${item.expected.validity}; ${result.diagnostics.map((d) => d.message).join("; ")}`,
          );
        }
      } finally {
        grammar.dispose();
      }
    },
  );
