import test from "node:test";
import assert from "node:assert/strict";
import { createSchemaFactory } from "../dist/schema-factory.js";
import {
  xercesSchemaProvider,
  javaSchemaProvider,
  validationPolicyNames as policy,
} from "../dist/schema-providers.js";
const X = "http://www.w3.org/2001/XMLSchema";
const xsd = `<xs:schema xmlns:xs="${X}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="key"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element><xs:element name="ref"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:key name="k"><xs:selector xpath="key"/><xs:field xpath="@id"/></xs:key><xs:keyref name="kr" refer="k"><xs:selector xpath="ref"/><xs:field xpath="@id"/></xs:keyref></xs:element></xs:schema>`;
test("real native factory configuration reaches the schema engine", async () => {
  for (const enabled of [true, false]) {
    const factory = createSchemaFactory(xercesSchemaProvider(), {
      features: { identityConstraints: enabled },
    });
    assert.equal(factory.getFeature("identityConstraints"), enabled);
    assert.equal(factory.getFeature(policy.secureProcessing), true);
    assert.equal(factory.getProperty(policy.externalDTD), "");
    assert.equal(factory.getProperty(policy.externalSchema), "");
    assert.equal(factory.supportsSchemaLanguage(X), true);
    const grammar = await factory.compile(xsd);
    try {
      assert.equal(
        (await grammar.validate('<root><key id="1"/><ref id="2"/></root>'))
          .valid,
        !enabled,
      );
    } finally {
      grammar.dispose();
    }
  }
});
test("shipped providers expose fixed safety policies and reject unsafe or unknown negotiation", () => {
  for (const provider of [
    xercesSchemaProvider(),
    javaSchemaProvider({ javaExecutable: "unused-until-explicit-compile" }),
  ]) {
    const factory = createSchemaFactory(provider);
    assert.equal(factory.getFeature(policy.secureProcessing), true);
    assert.equal(factory.getProperty(policy.externalSchema), "");
    assert.throws(
      () =>
        createSchemaFactory(provider, {
          features: { [policy.secureProcessing]: false },
        }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    assert.throws(
      () =>
        createSchemaFactory(provider, {
          properties: { [policy.externalDTD]: "file,http" },
        }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    assert.throws(
      () => createSchemaFactory(provider, { features: { unknown: true } }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
  }
});
