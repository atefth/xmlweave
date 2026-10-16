import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/schema-graph.ts", import.meta.url)),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { prepareSchemaGraph } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const schema = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>';
test("catalogue budgets reject all fixed source sizes before copying any bytes", async () => {
  let copies = 0;
  class ObservedBytes extends Uint8Array {
    slice(...args) {
      copies++;
      return super.slice(...args);
    }
  }
  const bytes = new ObservedBytes(256 * 1024);
  const resourceMap = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `https://a/${i}.xsd`,
      { kind: "bytes", bytes },
    ]),
  );
  await assert.rejects(
    prepareSchemaGraph(schema, {
      resourceMap,
      maxDocuments: 1,
      maxGraphBytes: 1024,
    }),
    (error) => error.code === "RESOURCE_LIMIT",
  );
  assert.equal(copies, 0);
  await assert.rejects(
    prepareSchemaGraph(schema, {
      resourceMap: { "https://a/a.xsd": { kind: "bytes", bytes } },
      maxGraphBytes: 1024,
    }),
    (error) => error.code === "RESOURCE_LIMIT",
  );
  assert.equal(copies, 0);
  await assert.rejects(
    prepareSchemaGraph(schema, {
      resourceMap: {
        "https://a/a.xsd": { kind: "bytes", bytes: new ObservedBytes(8) },
        "https://a/b.xsd": { kind: "text", text: "x".repeat(2000) },
      },
      maxGraphBytes: 1024,
    }),
    (error) => error.code === "RESOURCE_LIMIT",
  );
  assert.equal(copies, 0);
});
test("catalogue snapshots normal byte resources and preserves source exceptions", async () => {
  let copies = 0;
  class ObservedBytes extends Uint8Array {
    slice(...args) {
      copies++;
      return super.slice(...args);
    }
  }
  const bytes = new ObservedBytes(new TextEncoder().encode(schema));
  const root =
    '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="https://a/a.xsd"/></xs:schema>';
  const graphPromise = prepareSchemaGraph(root, {
    resourceMap: { "https://a/a.xsd": { kind: "bytes", bytes } },
    maxGraphBytes: 1024,
  });
  bytes.fill(0);
  const graph = await graphPromise;
  assert.equal(copies, 1);
  assert.equal(graph.resources["https://a/a.xsd"], schema);
  const failure = { source: true };
  await assert.rejects(
    prepareSchemaGraph(schema, {
      resourceMap: {
        "https://a/b.xsd": {
          kind: "text",
          get text() {
            throw failure;
          },
        },
      },
    }),
    (error) => error === failure,
  );
});
