import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileSchema } from "../dist/schema.js";
const catalogue = JSON.parse(
  await readFile(
    new URL("./fixtures/xsd-original.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of catalogue.fixtures)
  test(`XSD original fixture: ${fixture.feature}`, async () => {
    if (!fixture.schemaValid) {
      await assert.rejects(compileSchema(fixture.schema), {
        code: "INVALID_SCHEMA",
      });
      return;
    }
    const schema = await compileSchema(fixture.schema);
    try {
      for (const sample of fixture.instances)
        assert.equal(
          (await schema.validate(sample.xml)).valid,
          sample.valid,
          `${fixture.id}/${sample.id}`,
        );
    } finally {
      schema.dispose();
    }
  });
