import test from "node:test";
import assert from "node:assert/strict";
import { compileXercesSchema } from "../dist/schema-xerces.js";
import { compileIsolatedXercesSchema } from "../dist/schema-xerces-isolated.js";
import { compileJavaSchema } from "../dist/schema-java.js";

const X = "http://www.w3.org/2001/XMLSchema";
const xsd = (body) => `<xs:schema xmlns:xs="${X}">${body}</xs:schema>`;
const integer = xsd('<xs:element name="r" type="xs:int"/>');

for (const [name, compile] of [
  ["native", compileXercesSchema],
  ["Java", compileJavaSchema],
]) {
  test(`${name} rejects oversized schema batches before consuming producers`, async () => {
    let reads = 0;
    const source = {
      kind: "chunks",
      chunks: {
        async *[Symbol.asyncIterator]() {
          reads++;
          yield integer;
        },
      },
    };
    await assert.rejects(compile(Array.from({ length: 257 }, () => source)), {
      code: "RESOURCE_LIMIT",
    });
    assert.equal(reads, 0);
  });
}
const recursive = xsd(
  '<xs:element name="r"><xs:complexType><xs:sequence><xs:element ref="r" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>',
);

for (const [name, compile] of [
  ["native", compileXercesSchema],
  ["isolated", compileIsolatedXercesSchema],
  ["Java", compileJavaSchema],
]) {
  test(`${name} streaming enforces depth before retaining an oversized native stack`, async () => {
    const grammar = await compile(recursive);
    try {
      await assert.rejects(
        async () => {
          for await (const event of grammar.validateStream([
            "<r>".repeat(300) + "</r>".repeat(300),
          ]))
            void event;
        },
        { code: "RESOURCE_LIMIT" },
      );
    } finally {
      grammar.dispose();
    }
  });
}

for (const [name, compile] of [
  ["isolated", compileIsolatedXercesSchema],
  ["Java", compileJavaSchema],
]) {
  for (const mode of ["timeout", "abort", "dispose"]) {
    test(`${name} ${mode} settles while buffered source producer never resolves`, async () => {
      const grammar = await compile(integer);
      let closed = 0;
      const signal = { aborted: false };
      const chunks = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise(() => {});
            },
            return() {
              closed++;
              return new Promise(() => {});
            },
          };
        },
      };
      const pending = grammar.validate(
        { kind: "chunks", chunks },
        { timeoutMs: mode === "timeout" ? 20 : 1000, signal },
      );
      if (mode === "abort")
        setTimeout(() => {
          signal.aborted = true;
        }, 10);
      if (mode === "dispose") setTimeout(() => grammar.dispose(), 10);
      try {
        await Promise.race([
          assert.rejects(pending, {
            code: { timeout: "TIMEOUT", abort: "ABORTED", dispose: "DISPOSED" }[
              mode
            ],
          }),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Source cancellation stalled")),
              300,
            );
            timer.unref();
          }),
        ]);
        assert.equal(closed, 1);
      } finally {
        grammar.dispose();
      }
    });
  }
}

test("generated schema-set identities never overwrite explicit caller resources", async () => {
  const sources = [
    {
      kind: "text",
      systemId: "https://xmlweave.invalid/schema-set.xsd",
      text: integer,
    },
    {
      kind: "text",
      systemId: "https://xmlweave.invalid/set-0.xsd",
      text: xsd('<xs:element name="q" type="xs:string"/>'),
    },
    {
      kind: "text",
      systemId: "https://xmlweave.invalid/source-3.xsd",
      text: xsd('<xs:element name="s" type="xs:string"/>'),
    },
    xsd('<xs:element name="t" type="xs:string"/>'),
  ];
  const grammar = await compileIsolatedXercesSchema(sources);
  try {
    for (const xml of ["<r>7</r>", "<q/>", "<s/>", "<t/>"])
      assert.equal((await grammar.validate(xml)).valid, true, xml);
    assert.equal((await grammar.validate("<r>bad</r>")).valid, false);
  } finally {
    grammar.dispose();
  }
});

test("canonical resource-map identifiers resolve without implicit transport", async () => {
  const root = {
    kind: "text",
    systemId: "https://schemas.invalid/root.xsd",
    text: xsd(
      '<xs:include schemaLocation="types.xsd"/><xs:element name="r" type="T"/>',
    ),
  };
  const grammar = await compileIsolatedXercesSchema(root, {
    resourceMap: {
      "https://schemas.invalid:443/types.xsd": xsd(
        '<xs:simpleType name="T"><xs:restriction base="xs:int"/></xs:simpleType>',
      ),
    },
  });
  try {
    assert.equal((await grammar.validate("<r>7</r>")).valid, true);
  } finally {
    grammar.dispose();
  }
});

test(
  "native streaming counts sibling nodes as well as depth",
  { timeout: 30_000 },
  async () => {
    const grammar = await compileXercesSchema(
      xsd(
        '<xs:element name="r"><xs:complexType><xs:sequence><xs:any processContents="skip" minOccurs="0" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>',
      ),
    );
    try {
      assert.equal(
        (await grammar.validate("<r>" + "<x/>".repeat(1000) + "</r>")).valid,
        true,
      );
      await assert.rejects(
        grammar.validate("<r>" + "<x/>".repeat(100_000) + "</r>"),
        { code: "RESOURCE_LIMIT" },
      );
    } finally {
      grammar.dispose();
    }
  },
);

for (const [name, compile] of [
  ["isolated", compileIsolatedXercesSchema],
  ["Java", compileJavaSchema],
]) {
  test(`${name} malformed and rejecting buffered iterators preserve stable errors and close ownership`, async () => {
    const grammar = await compile(integer);
    try {
      await assert.rejects(grammar.validate({ kind: "chunks", chunks: null }), {
        code: "INVALID_ARGUMENT",
      });
      const sentinel = new Error("producer failure");
      let closed = 0;
      const chunks = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(sentinel);
            },
            return() {
              closed++;
              return { done: true };
            },
          };
        },
      };
      await assert.rejects(
        grammar.validate({ kind: "chunks", chunks }),
        (error) => error === sentinel,
      );
      assert.equal(closed, 1);
      assert.equal((await grammar.validate("<r>7</r>")).valid, true);
    } finally {
      grammar.dispose();
    }
  });
}

test("synthetic graph wrappers count toward the configured document budget", async () => {
  await assert.rejects(
    compileIsolatedXercesSchema([integer, xsd('<xs:element name="q"/>')], {
      maxDocuments: 2,
    }),
    { code: "RESOURCE_LIMIT" },
  );
});

test("graph compilation marks rewritten root coordinates generated and preserves original dependency identity", async () => {
  const { parseXml } = await import("../dist/index.js");
  const rootId = "https://provenance.invalid/root.xsd",
    dependencyId = "https://provenance.invalid/types.xsd";
  const original =
    '<?xml version="1.0"?>\n<xs:schema xmlns:xs="' +
    X +
    '" xmlns:t="urn:types">\n  <xs:import namespace="urn:types"/>\n  <xs:element name="r" type="xs:NoSuchType"/>\n</xs:schema>';
  const dependency = `<xs:schema xmlns:xs="${X}" targetNamespace="urn:types"><xs:simpleType name="Code"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`;
  for (const source of [
    { kind: "text", text: original, systemId: rootId },
    { kind: "dom", node: parseXml(original), systemId: rootId },
  ]) {
    const observed = [],
      handled = [];
    let failure;
    try {
      await compileIsolatedXercesSchema(source, {
        resourceMap: { [dependencyId]: dependency },
        namespaceCatalog: { "urn:types": dependencyId },
        onDiagnostic: (d) => observed.push(d),
        diagnosticHandler: (d) => handled.push(d),
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "INVALID_SCHEMA");
    const own = failure.diagnostics.find((d) => d.systemId === rootId);
    assert.ok(own, "Compilation error identifies rewritten root");
    assert.equal(own.provenance, "generated");
    assert.equal(own.sourceKind, source.kind);
    assert.ok(
      observed.some(
        (d) => d.systemId === rootId && d.provenance === "generated",
      ),
    );
    assert.ok(
      handled.some(
        (d) => d.systemId === rootId && d.provenance === "generated",
      ),
    );
  }
  const validRoot = {
    kind: "text",
    text: original
      .replace("xs:NoSuchType", "t:Code")
      .replace(
        '<xs:import namespace="urn:types"/>',
        `<xs:import namespace="urn:types" schemaLocation="${dependencyId}"/>`,
      ),
    systemId: rootId,
  };
  const invalidDependency = parseXml(
    dependency.replace('base="xs:int"', 'base="xs:NoSuchType"'),
  );
  let failure;
  try {
    await compileIsolatedXercesSchema(validRoot, {
      resourceMap: { [dependencyId]: { kind: "dom", node: invalidDependency } },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "INVALID_SCHEMA");
  const imported = failure.diagnostics.find((d) => d.systemId === dependencyId);
  assert.ok(
    imported,
    "Imported schema error retains exact dependency identity",
  );
  assert.equal(imported.sourceKind, "dom");
  assert.equal(imported.provenance, "generated");
});

test("deadline-wrapped malformed iterator objects and results use stable argument errors", async () => {
  const grammar = await compileIsolatedXercesSchema(integer);
  try {
    for (const chunks of [
      {
        [Symbol.asyncIterator]() {
          return {};
        },
      },
      {
        [Symbol.asyncIterator]() {
          return { next: async () => null };
        },
      },
    ])
      await assert.rejects(grammar.validate({ kind: "chunks", chunks }), {
        code: "INVALID_ARGUMENT",
      });
    assert.equal((await grammar.validate("<r>1</r>")).valid, true);
  } finally {
    grammar.dispose();
  }
});

test("real provider factory features alter native identity validation and retain safety ceilings", async () => {
  const { createSchemaFactory } = await import("../dist/schema-factory.js");
  const { xercesSchemaProvider, validationPolicyNames } = await import(
    "../dist/schema-providers.js"
  );
  const identity = xsd(
    '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="item" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element><xs:element name="ref" minOccurs="0"><xs:complexType><xs:attribute name="to" type="xs:string"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:key name="ids"><xs:selector xpath="item"/><xs:field xpath="@id"/></xs:key><xs:keyref name="refs" refer="ids"><xs:selector xpath="ref"/><xs:field xpath="@to"/></xs:keyref></xs:element>',
  );
  for (const identityConstraints of [true, false]) {
    const factory = createSchemaFactory(
      xercesSchemaProvider({ maxCharacters: 2000 }),
      { features: { identityConstraints } },
    );
    assert.equal(
      factory.getFeature("identityConstraints"),
      identityConstraints,
    );
    assert.equal(
      factory.getFeature(validationPolicyNames.secureProcessing),
      true,
    );
    await assert.rejects(
      async () => factory.compile(identity, { maxCharacters: 2001 }),
      { code: "INVALID_ARGUMENT" },
    );
    const g = await factory.compile(identity, { maxCharacters: undefined });
    try {
      assert.equal(
        (await g.validate('<root><ref to="missing"/></root>')).valid,
        !identityConstraints,
      );
    } finally {
      g.dispose();
    }
  }
});

test("schema-set dependency traversal preserves DOM provenance of an explicit later root", async () => {
  const { parseXml } = await import("../dist/index.js");
  const rootId = "https://provenance.invalid/set-root.xsd",
    dependencyId = "https://provenance.invalid/set-types.xsd";
  const root = {
    kind: "text",
    systemId: rootId,
    text: `<xs:schema xmlns:xs="${X}" xmlns:t="urn:set"><xs:import namespace="urn:set" schemaLocation="${dependencyId}"/><xs:element name="r" type="t:Code"/></xs:schema>`,
  };
  const dependency = {
    kind: "dom",
    systemId: dependencyId,
    node: parseXml(
      `<xs:schema xmlns:xs="${X}" targetNamespace="urn:set"><xs:simpleType name="Code"><xs:restriction base="xs:NoSuchType"/></xs:simpleType></xs:schema>`,
    ),
  };
  let failure;
  try {
    await compileIsolatedXercesSchema([root, dependency]);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "INVALID_SCHEMA");
  const diagnostic = failure.diagnostics.find(
    (d) => d.systemId === dependencyId,
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.sourceKind, "dom");
  assert.equal(diagnostic.provenance, "generated");
});
