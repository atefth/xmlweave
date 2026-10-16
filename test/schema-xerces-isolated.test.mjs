import test from "node:test";
import assert from "node:assert/strict";
import { compileIsolatedXercesSchema } from "../dist/schema-xerces-isolated.js";
const X = "http://www.w3.org/2001/XMLSchema";
const schema = (body) => `<xs:schema xmlns:xs="${X}">${body}</xs:schema>`;
const integer = schema('<xs:element name="r" type="xs:int"/>');
function fixture(body) {
  return (
    "data:text/javascript," +
    encodeURIComponent(
      `import{parentPort as port}from'node:worker_threads';${body}`,
    )
  );
}
const pendingInput = fixture(
  `port.on('message',m=>{if(m.kind==='compile')port.postMessage({id:m.id,kind:'compiled'});else if(m.kind==='validate')port.postMessage({id:m.id,kind:'needChunk'});});`,
);
test("isolated Xerces worker hard deadline interrupts CPU and leaves host responsive", async () => {
  let heartbeat = false;
  const timer = setTimeout(() => (heartbeat = true), 5);
  try {
    await assert.rejects(
      compileIsolatedXercesSchema(integer, {
        workerURL: fixture("while(true){}"),
        timeoutMs: 60,
      }),
      { code: "TIMEOUT" },
    );
    assert.equal(heartbeat, true);
  } finally {
    clearTimeout(timer);
  }
});
test("isolated Xerces pending input abort rejects promptly and requests upstream closure", async () => {
  const grammar = await compileIsolatedXercesSchema(integer, {
    workerURL: pendingInput,
    timeoutMs: 1000,
  });
  let returned = false;
  const signal = { aborted: false };
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          signal.aborted = true;
          return new Promise(() => {});
        },
        return() {
          returned = true;
          return Promise.resolve({ done: true });
        },
      };
    },
  };
  try {
    await assert.rejects(
      (async () => {
        for await (const event of grammar.validateStream(input, { signal })) {
        }
      })(),
      { code: "ABORTED" },
    );
    assert.equal(returned, true);
    assert.equal(grammar.disposed, true);
    assert.equal(grammar.busy, false);
  } finally {
    grammar.dispose();
  }
});
test("isolated Xerces source failure and observer exception preserve identity and terminate", async () => {
  const failure = new Error("source failed");
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL: pendingInput,
    timeoutMs: 1000,
  });
  let closed = false;
  const source = {
    [Symbol.iterator]() {
      return {
        next() {
          throw failure;
        },
        return() {
          closed = true;
          return { done: true };
        },
      };
    },
  };
  await assert.rejects(
    (async () => {
      for await (const event of g.validateStream(source)) {
      }
    })(),
    (error) => error === failure,
  );
  assert.equal(closed, true);
  assert.equal(g.disposed, true);
  const observerFixture = fixture(
    `port.on('message',m=>{if(m.kind==='compile')port.postMessage({id:m.id,kind:'compiled'});if(m.kind==='validate')port.postMessage({id:m.id,kind:'event',event:{kind:'diagnostic',diagnostic:{message:'test',severity:'error'}}});});`,
  );
  const other = await compileIsolatedXercesSchema(integer, {
    workerURL: observerFixture,
    timeoutMs: 1000,
  });
  const sentinel = new Error("observer failed");
  await assert.rejects(
    other.validate("<r>x</r>", {
      onDiagnostic() {
        throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );
  assert.equal(other.disposed, true);
});
test("isolated Xerces one-event acknowledgements bound read-ahead and early return closes source", async () => {
  const workerURL = fixture(
    `let id;port.on('message',m=>{if(m.kind==='compile')port.postMessage({id:m.id,kind:'compiled'});if(m.kind==='validate'){id=m.id;port.postMessage({id,kind:'needChunk'});}if(m.kind==='chunk')port.postMessage({id,kind:'event',event:{kind:'startDocument'}});if(m.kind==='ack')port.postMessage({id,kind:'needChunk'});});`,
  );
  const grammar = await compileIsolatedXercesSchema(integer, {
    workerURL,
    timeoutMs: 1000,
  });
  let reads = 0,
    closed = false;
  const chunks = {
    [Symbol.iterator]() {
      return {
        next() {
          reads++;
          return { done: false, value: "<r>" };
        },
        return() {
          closed = true;
          return { done: true };
        },
      };
    },
  };
  for await (const event of grammar.validateStream(chunks)) {
    assert.equal(event.kind, "startDocument");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reads, 1);
    break;
  }
  assert.equal(closed, true);
  assert.equal(grammar.disposed, true);
});
test("isolated Xerces invalid iterators fail without poisoning a healthy handle", async () => {
  const grammar = await compileIsolatedXercesSchema(integer, {
    workerURL: pendingInput,
    timeoutMs: 1000,
  });
  try {
    await assert.rejects(
      (async () => {
        for await (const event of grammar.validateStream({})) {
        }
      })(),
      { code: "INVALID_ARGUMENT" },
    );
    assert.equal(grammar.busy, false);
    assert.equal(grammar.disposed, false);
  } finally {
    grammar.dispose();
  }
});
test(
  "isolated native Xerces validates graph resources and preserves actual immutable PSVI",
  { timeout: 30000 },
  async () => {
    const root = {
      kind: "text",
      systemId: "https://isolated.invalid/root.xsd",
      text: schema(
        '<xs:include schemaLocation="types.xsd"/><xs:element name="r" type="Code"/>',
      ),
    };
    const resources = (value) => ({
      "https://isolated.invalid/types.xsd": schema(
        `<xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:enumeration value="${value}"/></xs:restriction></xs:simpleType>`,
      ),
    });
    const [a, b] = await Promise.all(
      ["A", "B"].map((value) =>
        compileIsolatedXercesSchema(root, {
          resourceMap: resources(value),
          timeoutMs: 10000,
        }),
      ),
    );
    try {
      assert.deepEqual(
        await Promise.all([
          a.validate("<r>A</r>"),
          b.validate("<r>A</r>"),
        ]).then((results) => results.map((result) => result.valid)),
        [true, false],
      );
      const events = [];
      for await (const event of a.validateStream(["<r>A</r>"]))
        events.push(event);
      const end = events.find((event) => event.kind === "endElement");
      assert.equal(end.psvi.type.name, "Code");
      assert.equal(Object.isFrozen(end.psvi), true);
      assert.equal(events.at(-1).result.valid, true);
    } finally {
      a.dispose();
      b.dispose();
    }
  },
);
test(
  "isolated native Xerces reports early invalid children and late identity errors",
  { timeout: 30000 },
  async () => {
    const xsd = schema(
      '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>',
    );
    const grammar = await compileIsolatedXercesSchema(xsd, {
      timeoutMs: 10000,
    });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let eof = false,
      closed = false;
    async function* chunks() {
      try {
        yield "<root><bad/>";
        await gate;
        eof = true;
        yield "</root>";
      } finally {
        closed = true;
      }
    }
    try {
      let early = false;
      for await (const event of grammar.validateStream(chunks())) {
        if (event.kind === "diagnostic" && !early) {
          assert.equal(eof, false);
          early = true;
          release();
        }
      }
      assert.equal(early, true);
      assert.equal(closed, true);
    } finally {
      release();
      grammar.dispose();
    }
    const identity = schema(
      '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="item" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element><xs:element name="ref" minOccurs="0"><xs:complexType><xs:attribute name="to" type="xs:string"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:key name="ids"><xs:selector xpath="item"/><xs:field xpath="@id"/></xs:key><xs:keyref name="refs" refer="ids"><xs:selector xpath="ref"/><xs:field xpath="@to"/></xs:keyref></xs:element>',
    );
    const keyed = await compileIsolatedXercesSchema(identity, {
      timeoutMs: 10000,
    });
    try {
      const result = await keyed.validate('<root><ref to="missing"/></root>');
      assert.equal(result.valid, false);
      assert.ok(result.diagnostics.length);
    } finally {
      keyed.dispose();
    }
  },
);

test(
  "isolated native Xerces derivations, provenance, throwing invalidity and disposal stay coherent",
  { timeout: 30000 },
  async () => {
    const grammar = await compileIsolatedXercesSchema(integer, {
      timeoutMs: 10000,
      typeQueries: [{ namespaceURI: X, name: "decimal", method: 0 }],
    });
    try {
      const events = [];
      for await (const event of grammar.validateStream(["<r>1</r>"]))
        events.push(event);
      assert.equal(
        events.find((event) => event.kind === "endElement").psvi.type
          .derivations[0],
        true,
      );
      const bytes = await grammar.validate({
        kind: "bytes",
        bytes: new TextEncoder().encode("<r>x</r>"),
        systemId: "urn:bytes",
      });
      assert.equal(bytes.valid, false);
      assert.equal(bytes.diagnostics[0].sourceKind, "bytes");
      assert.equal(bytes.diagnostics[0].provenance, "original");
      const seen = [];
      await assert.rejects(
        grammar.validate("<r>x</r>", {
          errorPolicy: "throw",
          onDiagnostic: (diagnostic) => seen.push(diagnostic),
        }),
        (error) => error.code === "INVALID_XML",
      );
      assert.ok(seen.length);
      assert.equal(grammar.disposed, false);
      assert.equal((await grammar.validate("<r>2</r>")).valid, true);
    } finally {
      grammar.dispose();
    }
    assert.equal(grammar.busy, false);
    await assert.rejects(grammar.validate("<r>2</r>"), { code: "DISPOSED" });
  },
);

test(
  "exact isolated handler awaits async host decision before any further native progress",
  { timeout: 20000 },
  async () => {
    const g = await compileIsolatedXercesSchema(
      `<xs:schema xmlns:xs="${X}"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element></xs:schema>`,
      { timeoutMs: 10000 },
    );
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve)),
      first = new Promise((resolve) => (entered = resolve));
    let reads = 0,
      events = 0,
      calls = 0;
    const chunks = {
      [Symbol.iterator]() {
        return {
          next() {
            reads++;
            return reads === 1
              ? { value: "<root><n>x</n><n>y</n></root>", done: false }
              : { done: true };
          },
          return() {
            return { done: true };
          },
        };
      },
    };
    try {
      const run = (async () => {
        let result;
        for await (const event of g.validateStream(chunks, {
          maxDiagnostics: 1,
          diagnosticHandler: async () => {
            calls++;
            if (calls === 1) {
              entered();
              await gate;
            }
          },
        })) {
          events++;
          if (event.kind === "result") result = event.result;
        }
        return result;
      })();
      await first;
      const before = { reads, events, calls };
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        { reads, events, calls },
        before,
        "No next read/event/diagnostic before handler acknowledgement",
      );
      release();
      const result = await run;
      assert.equal(result.valid, false);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnosticsTruncated, true);
      assert.ok(calls >= 2, "Handler sees diagnostics beyond retained cap");
      assert.equal((await g.validate("<root><n>1</n></root>")).valid, true);
    } finally {
      release();
      g.dispose();
    }
  },
);
test(
  "exact isolated compilation/validation handler exceptions preserve all thrown values",
  { timeout: 30000 },
  async () => {
    const badSchema = schema('<xs:element name="r" type="xs:doesNotExist"/>');
    for (const sentinel of [
      undefined,
      null,
      false,
      0,
      "",
      Object.freeze({ custom: "sentinel" }),
    ]) {
      let caught = false;
      try {
        await compileIsolatedXercesSchema(badSchema, {
          timeoutMs: 10000,
          diagnosticHandler() {
            throw sentinel;
          },
        });
      } catch (cause) {
        caught = true;
        assert.equal(cause, sentinel);
      }
      assert.equal(caught, true);
    }
    const g = await compileIsolatedXercesSchema(integer, { timeoutMs: 10000 });
    const sentinel = { validation: "stop" };
    let caught = false;
    try {
      try {
        await g.validate("<r>x</r>", {
          diagnosticHandler: async () => {
            throw sentinel;
          },
        });
      } catch (cause) {
        caught = true;
        assert.equal(cause, sentinel);
      }
      assert.equal(caught, true);
      assert.equal(g.disposed, true);
    } finally {
      g.dispose();
    }
  },
);
test(
  "pending exact handler times out, and a late callback cannot revive its worker",
  { timeout: 20000 },
  async () => {
    const g = await compileIsolatedXercesSchema(integer, { timeoutMs: 10000 });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    try {
      await assert.rejects(
        g.validate("<r>x</r>", {
          timeoutMs: 60,
          diagnosticHandler: () => gate,
        }),
        { code: "TIMEOUT" },
      );
      assert.equal(g.disposed, true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await assert.rejects(g.validate("<r>1</r>"), { code: "DISPOSED" });
    } finally {
      release();
      g.dispose();
    }
  },
);
test("exact handler capability fails before reading input when shared memory is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "SharedArrayBuffer",
  );
  let consumed = false;
  Object.defineProperty(globalThis, "SharedArrayBuffer", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    await assert.rejects(
      compileIsolatedXercesSchema(
        {
          kind: "chunks",
          chunks: (function* () {
            consumed = true;
            yield integer;
          })(),
        },
        { diagnosticHandler() {} },
      ),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    assert.equal(consumed, false);
  } finally {
    Object.defineProperty(globalThis, "SharedArrayBuffer", descriptor);
  }
});
test("worker diagnostic boundary warning continuation and fatal termination are explicit transport evidence", async () => {
  const workerURL = fixture(
    `function diagnostic(m,d){if(!m.control)return true;const c=new Int32Array(m.control);Atomics.store(c,0,0);port.postMessage({id:m.id,kind:'handlerDiagnostic',sequence:1,diagnostic:d});while(Atomics.load(c,0)===0)Atomics.wait(c,0,0);return Atomics.load(c,0)===1;}port.on('message',m=>{if(m.kind==='compile'){diagnostic(m,{message:'synthetic compile warning',severity:'warning'});port.postMessage({id:m.id,kind:'compiled'});}if(m.kind==='validate'){if(!diagnostic(m,{message:'synthetic terminal fatal',severity:'fatal'})){port.postMessage({id:m.id,kind:'failure',error:{code:'INVALID_XML',message:'Fatal diagnostic',diagnostics:[]}});return;}port.postMessage({id:m.id,kind:'event',event:{kind:'result',result:{valid:true,diagnostics:[]}}});}if(m.kind==='ack')port.postMessage({id:m.id,kind:'complete'});});`,
  );
  let compileWarnings = 0;
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL,
    timeoutMs: 1000,
    diagnosticHandler: async (diagnostic) => {
      assert.equal(diagnostic.severity, "warning");
      compileWarnings++;
    },
  });
  let fatal = 0;
  try {
    assert.equal(compileWarnings, 1);
    await assert.rejects(
      g.validate("<r/>", {
        diagnosticHandler: async (diagnostic) => {
          assert.equal(diagnostic.severity, "fatal");
          fatal++;
        },
      }),
      { code: "INVALID_XML" },
    );
    assert.equal(fatal, 1);
    assert.equal(g.disposed, true);
  } finally {
    g.dispose();
  }
});
test("Node module-eval callers do not pass incompatible input-type flags to file workers", async () => {
  const { execFileSync } = await import("node:child_process");
  const url = new URL("../dist/schema-xerces-isolated.js", import.meta.url)
    .href;
  const code = `import{compileIsolatedXercesSchema}from ${JSON.stringify(url)};const g=await compileIsolatedXercesSchema(${JSON.stringify(integer)},{workerURL:${JSON.stringify(pendingInput)},timeoutMs:1000});g.dispose();console.log('worker-ready');`;
  assert.match(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 10000,
    }),
    /worker-ready/,
  );
});

test(
  "exact invalid-child handler stops before a producer can supply another chunk",
  { timeout: 20000 },
  async () => {
    const g = await compileIsolatedXercesSchema(
      schema(
        '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int"/></xs:sequence></xs:complexType></xs:element>',
      ),
      { timeoutMs: 10000 },
    );
    let reads = 0,
      closed = false;
    const sentinel = { stop: "before-next-input" };
    const chunks = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reads++;
            return reads === 1
              ? Promise.resolve({ value: "<root><bad/>", done: false })
              : new Promise(() => {});
          },
          return() {
            closed = true;
            return Promise.resolve({ done: true });
          },
        };
      },
    };
    try {
      let caught = false;
      try {
        for await (const event of g.validateStream(chunks, {
          diagnosticHandler() {
            throw sentinel;
          },
        })) {
        }
      } catch (cause) {
        caught = true;
        assert.equal(cause, sentinel);
      }
      assert.equal(caught, true);
      assert.equal(reads, 1);
      assert.equal(closed, true);
    } finally {
      g.dispose();
    }
  },
);
test(
  "abort and disposal terminate workers blocked in an exact asynchronous handler",
  { timeout: 20000 },
  async () => {
    for (const action of ["abort", "dispose"]) {
      const g = await compileIsolatedXercesSchema(integer, {
        timeoutMs: 10000,
      });
      const signal = { aborted: false };
      try {
        await assert.rejects(
          g.validate("<r>x</r>", {
            signal,
            diagnosticHandler() {
              if (action === "abort") signal.aborted = true;
              else g.dispose();
              return new Promise(() => {});
            },
          }),
          { code: action === "abort" ? "ABORTED" : "DISPOSED" },
        );
        assert.equal(g.disposed, true);
        assert.equal(g.busy, false);
      } finally {
        g.dispose();
      }
    }
  },
);

test(
  "buffered original-byte budgets do not also constrain transcoded UTF8 transport",
  { timeout: 20000 },
  async () => {
    const g = await compileIsolatedXercesSchema(
      schema('<xs:element name="r" type="xs:string"/>'),
      { maxBytes: 30, timeoutMs: 10000 },
    );
    try {
      const bytes = Buffer.from("<r>" + "é".repeat(20) + "</r>", "latin1");
      assert.equal(bytes.length, 27);
      assert.equal(
        (await g.validate({ kind: "bytes", bytes, encoding: "ISO-8859-1" }))
          .valid,
        true,
      );
      await assert.rejects(
        g.validate({
          kind: "bytes",
          bytes: Buffer.from("<r>" + "é".repeat(24) + "</r>", "latin1"),
          encoding: "ISO-8859-1",
        }),
        { code: "RESOURCE_LIMIT" },
      );
    } finally {
      g.dispose();
    }
  },
);

test("one isolated deadline includes source normalization and worker execution", async () => {
  const workerURL = fixture(
    `port.on('message',m=>{if(m.kind==='compile')setTimeout(()=>port.postMessage({id:m.id,kind:'compiled'}),50);if(m.kind==='validate')setTimeout(()=>port.postMessage({id:m.id,kind:'event',event:{kind:'result',result:{valid:true,diagnostics:[]}}}),60);if(m.kind==='ack')port.postMessage({id:m.id,kind:'complete'});});`,
  );
  const delayed = (text) => ({
    kind: "chunks",
    chunks: (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield text;
    })(),
  });
  await assert.rejects(
    compileIsolatedXercesSchema(delayed(integer), {
      workerURL,
      timeoutMs: 100,
    }),
    { code: "TIMEOUT" },
  );
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL,
    timeoutMs: 1000,
  });
  try {
    await assert.rejects(g.validate(delayed("<r>1</r>"), { timeoutMs: 100 }), {
      code: "TIMEOUT",
    });
  } finally {
    g.dispose();
  }
});
test("undefined operation settings cannot erase inherited source budgets", async () => {
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL: pendingInput,
    maxCharacters: 200,
    timeoutMs: 1000,
  });
  try {
    await assert.rejects(
      g.validate("<r>" + "x".repeat(200) + "</r>", {
        maxCharacters: undefined,
      }),
      { code: "RESOURCE_LIMIT" },
    );
    assert.equal(g.disposed, false);
  } finally {
    g.dispose();
  }
});

test("instrumented worker warnings cover sync/async compile and validation decisions beyond retained caps", async () => {
  const workerURL = fixture(
    `let episode,step=0;function warnings(m,phase){const c=m.control?new Int32Array(m.control):undefined;const all=[];for(let sequence=1;sequence<=3;sequence++){const d={message:'instrumented warning '+sequence,severity:'warning',phase};all.push(d);if(c){Atomics.store(c,0,0);port.postMessage({id:m.id,kind:'handlerDiagnostic',sequence,diagnostic:d});while(Atomics.load(c,0)===0)Atomics.wait(c,0,0);}if(phase==='compile'&&sequence<=(m.options.maxDiagnostics??100))port.postMessage({id:m.id,kind:'compileDiagnostic',diagnostic:d});}return all;}port.on('message',m=>{if(m.kind==='compile'){warnings(m,'compile');port.postMessage({id:m.id,kind:'compiled'});}else if(m.kind==='validate'){episode=m;const all=warnings(m,'validate');episode.result={valid:true,diagnostics:all.slice(0,m.options.maxDiagnostics??100),diagnosticsTruncated:all.length>(m.options.maxDiagnostics??100)};step=0;port.postMessage({id:m.id,kind:'event',event:{kind:'diagnostic',diagnostic:all[0]}});}else if(m.kind==='ack'){if(step++===0)port.postMessage({id:m.id,kind:'event',event:{kind:'result',result:episode.result}});else port.postMessage({id:m.id,kind:'complete'});}});`,
  );
  for (const asynchronous of [false, true]) {
    let compiledWarnings = 0,
      validatedWarnings = 0,
      observed = 0;
    const compileHandler = (diagnostic) => {
      assert.equal(diagnostic.severity, "warning");
      compiledWarnings++;
      return asynchronous ? Promise.resolve() : undefined;
    };
    const g = await compileIsolatedXercesSchema(integer, {
      workerURL,
      timeoutMs: 1000,
      maxDiagnostics: 1,
      diagnosticHandler: compileHandler,
      onDiagnostic() {
        observed++;
      },
    });
    try {
      assert.equal(compiledWarnings, 3);
      assert.equal(observed, 1);
      const result = await g.validate("<r/>", {
        maxDiagnostics: 1,
        diagnosticHandler: (diagnostic) => {
          assert.equal(diagnostic.phase, "validate");
          validatedWarnings++;
          return asynchronous ? Promise.resolve() : undefined;
        },
      });
      assert.equal(result.valid, true);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnosticsTruncated, true);
      assert.equal(validatedWarnings, 3);
      assert.equal(compiledWarnings, 3, "Factory handler not inherited");
    } finally {
      g.dispose();
    }
    const sentinel = { warningStop: asynchronous };
    let calls = 0,
      caught = false;
    try {
      await compileIsolatedXercesSchema(integer, {
        workerURL,
        timeoutMs: 1000,
        maxDiagnostics: 1,
        diagnosticHandler: (diagnostic) => {
          calls++;
          if (calls === 2) {
            if (asynchronous) return Promise.reject(sentinel);
            throw sentinel;
          }
        },
      });
    } catch (error) {
      caught = true;
      assert.equal(error, sentinel);
    }
    assert.equal(caught, true);
    assert.equal(
      calls,
      2,
      "Conditional warning throw beyond cap stops compilation",
    );
    const other = await compileIsolatedXercesSchema(integer, {
      workerURL,
      timeoutMs: 1000,
      maxDiagnostics: 1,
    });
    calls = 0;
    caught = false;
    try {
      try {
        await other.validate("<r/>", {
          diagnosticHandler() {
            calls++;
            if (calls === 2) {
              if (asynchronous) return Promise.reject(sentinel);
              throw sentinel;
            }
          },
        });
      } catch (error) {
        caught = true;
        assert.equal(error, sentinel);
      }
      assert.equal(caught, true);
      assert.equal(calls, 2);
      assert.equal(other.disposed, true);
    } finally {
      other.dispose();
    }
  }
});

test("isolated type-query RPC enforces idle state, source identity and worker deadlines", async () => {
  const identity = {
    schemaIdentity: "fixture-schema",
    namespaceURI: "urn:fixture",
    name: "anonymous-1",
  };
  const workerURL = fixture(
    `port.on('message',m=>{if(m.kind==='compile')port.postMessage({id:m.id,kind:'compiled'});if(m.kind==='queryTypeDerivation'){if(m.method===8){while(true){}}if(m.typeIdentity.schemaIdentity!=='fixture-schema')port.postMessage({id:m.id,kind:'failure',error:{code:'INVALID_ARGUMENT',message:'Foreign grammar identity',diagnostics:[]}});else port.postMessage({id:m.id,kind:'typeDerivation',result:m.method===1});}});`,
  );
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL,
    timeoutMs: 1000,
  });
  try {
    assert.equal(await g.queryTypeDerivation(identity, identity, 1), true);
    assert.equal(await g.queryTypeDerivation(identity, identity, 2), false);
    await assert.rejects(
      g.queryTypeDerivation(
        { ...identity, schemaIdentity: "foreign" },
        identity,
        1,
      ),
      { code: "INVALID_ARGUMENT" },
    );
    assert.equal(g.disposed, false);
    await assert.rejects(g.queryTypeDerivation(identity, identity, 16), {
      code: "INVALID_ARGUMENT",
    });
    await assert.rejects(
      g.queryTypeDerivation(identity, identity, 1, {
        signal: { aborted: true },
      }),
      { code: "ABORTED" },
    );
    const pending = g.queryTypeDerivation(identity, identity, 8, {
      timeoutMs: 60,
    });
    assert.equal(g.busy, true);
    await assert.rejects(g.queryTypeDerivation(identity, identity, 1), {
      code: "BUSY",
    });
    await assert.rejects(pending, { code: "TIMEOUT" });
    assert.equal(g.disposed, true);
    assert.equal(g.busy, false);
  } finally {
    g.dispose();
  }
  await assert.rejects(g.queryTypeDerivation(identity, identity, 1), {
    code: "DISPOSED",
  });
});

test("isolated type-query cancellation terminates the idle-RPC worker", async () => {
  const workerURL = fixture(
    `port.on('message',m=>{if(m.kind==='compile')port.postMessage({id:m.id,kind:'compiled'});});`,
  );
  const identity = {
    schemaIdentity: "fixture",
    namespaceURI: "urn:fixture",
    name: "T",
  };
  const g = await compileIsolatedXercesSchema(integer, {
    workerURL,
    timeoutMs: 1000,
  });
  const signal = { aborted: false };
  try {
    const pending = g.queryTypeDerivation(identity, identity, 0, { signal });
    signal.aborted = true;
    await assert.rejects(pending, { code: "ABORTED" });
    assert.equal(g.disposed, true);
  } finally {
    g.dispose();
  }
});

test(
  "isolated native anonymous identities support retained self/ancestor queries only in their owning grammar",
  { timeout: 30000 },
  async () => {
    const anonymous = schema(
      '<xs:element name="r"><xs:simpleType><xs:restriction base="xs:int"><xs:minInclusive value="0"/></xs:restriction></xs:simpleType></xs:element>',
    );
    const [a, b] = await Promise.all([
      compileIsolatedXercesSchema(anonymous, { timeoutMs: 10000 }),
      compileIsolatedXercesSchema(anonymous, { timeoutMs: 10000 }),
    ]);
    async function snapshot(g) {
      let type;
      for await (const event of g.validateStream(["<r>1</r>"]))
        if (event.kind === "endElement") type = event.psvi.type;
      return type;
    }
    let retained;
    try {
      retained = await snapshot(a);
      const again = await snapshot(a),
        other = await snapshot(b);
      assert.equal(retained.anonymous, true);
      assert.equal(typeof retained.name, "string");
      assert.ok(retained.name.length);
      assert.equal(typeof retained.namespaceURI, "string");
      assert.deepEqual(again.identity, retained.identity);
      assert.notEqual(
        other.identity.schemaIdentity,
        retained.identity.schemaIdentity,
      );
      assert.equal(
        await a.queryTypeDerivation(
          retained.identity,
          { namespaceURI: retained.namespaceURI, name: retained.name },
          1,
        ),
        true,
      );
      assert.equal(
        await a.queryTypeDerivation(
          retained.identity,
          { namespaceURI: retained.namespaceURI, name: retained.name },
          2,
        ),
        false,
      );
      assert.equal(
        await a.queryTypeDerivation(
          retained.identity,
          { namespaceURI: X, name: "int" },
          1,
        ),
        true,
      );
      assert.equal(
        await a.queryTypeDerivation(
          retained.identity,
          { namespaceURI: X, name: "string" },
          0,
        ),
        false,
      );
      await assert.rejects(
        b.queryTypeDerivation(
          retained.identity,
          { namespaceURI: X, name: "int" },
          1,
        ),
        { code: "INVALID_ARGUMENT" },
      );
      assert.equal(b.disposed, false);
      assert.equal((await b.validate("<r>2</r>")).valid, true);
    } finally {
      a.dispose();
      b.dispose();
    }
    assert.ok(Object.isFrozen(retained));
    await assert.rejects(
      a.queryTypeDerivation(
        retained.identity,
        { namespaceURI: X, name: "int" },
        1,
      ),
      { code: "DISPOSED" },
    );
  },
);

test(
  "actual isolated pipeline handler awaits host decisions with mapped diagnostics and no producer progress",
  { timeout: 20000 },
  async () => {
    const { validateEventStream } = await import("../dist/schema-pipeline.js");
    const g = await compileIsolatedXercesSchema(
      schema(
        '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="xs:int"/></xs:sequence></xs:complexType></xs:element>',
      ),
      { timeoutMs: 10000 },
    );
    const name = (value) => ({
      name: value,
      localName: value,
      namespaceURI: "",
    });
    let unblockHandler, handlerEntered, unblockSource;
    const handlerGate = new Promise((resolve) => (unblockHandler = resolve)),
      entered = new Promise((resolve) => (handlerEntered = resolve)),
      sourceGate = new Promise((resolve) => (unblockSource = resolve));
    let produced = 0,
      output = 0,
      closed = false,
      seen;
    async function* events() {
      try {
        for (const event of [
          { kind: "startDocument" },
          {
            kind: "startElement",
            ...name("root"),
            attributes: [],
            locator: { systemId: "urn:original-events", line: 10, column: 1 },
          },
          {
            kind: "startElement",
            ...name("bad"),
            attributes: [],
            locator: { systemId: "urn:original-events", line: 11, column: 3 },
          },
          {
            kind: "endElement",
            ...name("bad"),
            locator: { systemId: "urn:original-events", line: 11, column: 9 },
          },
        ]) {
          produced++;
          yield event;
        }
        await sourceGate;
        produced++;
        yield { kind: "endElement", ...name("root") };
        yield { kind: "endDocument" };
      } finally {
        closed = true;
      }
    }
    try {
      const run = (async () => {
        let result;
        for await (const event of validateEventStream(g, events(), {
          systemId: "urn:generated-events",
          diagnosticHandler: async (diagnostic) => {
            if (!seen) {
              seen = diagnostic;
              handlerEntered();
              await handlerGate;
            }
          },
        })) {
          output++;
          if (event.kind === "result") result = event.result;
        }
        return result;
      })();
      await entered;
      assert.ok(
        seen.location?.generated,
        "Exact callback receives actual generated/source mapping context",
      );
      const before = { produced, output };
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual({ produced, output }, before);
      unblockSource();
      unblockHandler();
      assert.equal((await run).valid, false);
      assert.equal(closed, true);
    } finally {
      unblockSource();
      unblockHandler();
      g.dispose();
    }
  },
);
