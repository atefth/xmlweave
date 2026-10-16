import test from "node:test";
import assert from "node:assert/strict";
import { compileSchema } from "../dist/schema.js";
import { compileIsolatedXercesSchema } from "../dist/schema-xerces-isolated.js";
import { createHintValidator } from "../dist/schema-hints.js";

const xs = "http://www.w3.org/2001/XMLSchema";
const xsi = "http://www.w3.org/2001/XMLSchema-instance";
const schema = (version, body = '<xs:element name="r" type="xs:int"/>') =>
  `<xs:schema xmlns:xs="${xs}" version="${version}">${body}</xs:schema>`;
const instance = (file, value = "4") => ({
  kind: "text",
  systemId: "https://example.test/instance.xml",
  text: `<r xmlns:xsi="${xsi}" xsi:noNamespaceSchemaLocation="${file}">${value}</r>`,
});

// XSD 1.0 section 3.15.2 defines version as author metadata, not a language switch.
for (const version of ["1.1", "release-2026"]) {
  test(`isolated schema graphs accept XSD 1.0 version metadata ${version}`, async () => {
    const grammar = await compileIsolatedXercesSchema(schema(version));
    try {
      assert.equal((await grammar.validate("<r>4</r>")).valid, true);
      assert.equal((await grammar.validate("<r>bad</r>")).valid, false);
    } finally {
      grammar.dispose();
    }
  });
}

test("dynamic hints accept author version metadata without enabling XSD 1.1 syntax", async () => {
  const unsupported = schema(
    "1.1",
    '<xs:element name="r"><xs:complexType><xs:assert test="true()"/></xs:complexType></xs:element>',
  );
  const validator = await createHintValidator({
    resourceMap: {
      "https://example.test/number.xsd": schema("1.1"),
      "https://example.test/release.xsd": schema("release-2026"),
      "https://example.test/assert.xsd": unsupported,
    },
  });
  try {
    for (const file of ["number.xsd", "release.xsd"]) {
      assert.equal((await validator.validate(instance(file))).valid, true);
      assert.equal((await validator.validate(instance(file, "bad"))).valid, false);
    }
    await assert.rejects(validator.validate(instance("assert.xsd")), {
      code: "UNSUPPORTED_CAPABILITY",
    });
    await assert.rejects(compileIsolatedXercesSchema(unsupported), {
      code: "UNSUPPORTED_CAPABILITY",
    });
    await assert.rejects(compileSchema(unsupported), {
      code: "INVALID_SCHEMA",
    });
  } finally {
    validator.dispose();
  }
});

for (const container of ["appinfo", "documentation"]) {
  test(`schema ${container} payload is metadata, not executable schema syntax`, async () => {
    const annotated = schema(
      "1.1",
      `<xs:annotation><xs:${container}><example><xs:assert test="true()"/><xs:include schemaLocation="unused.xsd"/></example></xs:${container}></xs:annotation><xs:element name="r" type="xs:int"/>`,
    );
    let resolutions = 0;
    const resolver = () => {
      resolutions++;
      throw new Error("Annotation metadata must not resolve dependencies.");
    };
    for (const compile of [
      () => compileSchema(annotated),
      () => compileIsolatedXercesSchema(annotated, { resolver }),
    ]) {
      const grammar = await compile();
      try {
        assert.equal((await grammar.validate("<r>4</r>")).valid, true);
        assert.equal((await grammar.validate("<r>bad</r>")).valid, false);
      } finally {
        grammar.dispose();
      }
    }
    const validator = await createHintValidator({
      resourceMap: { "https://example.test/annotated.xsd": annotated },
      resolver,
    });
    try {
      assert.equal((await validator.validate(instance("annotated.xsd"))).valid, true);
    } finally {
      validator.dispose();
    }
    assert.equal(resolutions, 0);
  });
}

test("annotation metadata still receives document-wide security preflight", async () => {
  const annotated = schema(
    "1.1",
    '<xs:annotation><xs:appinfo><xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="forbidden.xml"/></xs:appinfo></xs:annotation><xs:element name="r" type="xs:int"/>',
  );
  for (const compile of [compileSchema, compileIsolatedXercesSchema]) {
    await assert.rejects(compile(annotated), { code: "EXTERNAL_RESOURCE_FORBIDDEN" });
    await assert.rejects(compile(`<!DOCTYPE xs:schema>${schema("1.1")}`), {
      code: "INVALID_SCHEMA",
    });
  }
});
