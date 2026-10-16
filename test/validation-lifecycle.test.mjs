import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { compileSchema } from "../dist/schema.js";
import { compileIsolatedXercesSchema } from "../dist/schema-xerces-isolated.js";

const ns = "http://www.w3.org/2001/XMLSchema";
const part = `<xs:schema xmlns:xs="${ns}"><xs:element name="r" type="xs:int"/></xs:schema>`;
const root = {
  kind: "text",
  text: `<xs:schema xmlns:xs="${ns}"><xs:include schemaLocation="part.xsd"/></xs:schema>`,
  systemId: "https://lifecycle.invalid/root.xsd",
};
const collect = async (iterable) => {
  let result;
  for await (const event of iterable)
    if (event.kind === "result") result = event.result;
  return result;
};
const ports = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === "MessagePort")
    .length;

test(
  "100 mixed graph/session/stream/failure/observer/timeout cycles release public handles and worker ports",
  { timeout: 240000 },
  async (context) => {
    const baseline = process.memoryUsage();
    const initialPorts = ports();
    const memories = [];
    const instantiate = WebAssembly.instantiate;
    // Weak references observe actual main-realm WASM capacity without retaining disposed engines.
    WebAssembly.instantiate = async function (...args) {
      const result = await Reflect.apply(instantiate, this, args);
      const instance = result.instance ?? result;
      for (const value of Object.values(instance.exports))
        if (value instanceof WebAssembly.Memory)
          memories.push(new WeakRef(value));
      return result;
    };
    let wasmPeak = 0,
      heapPeak = baseline.heapUsed,
      rssPeak = baseline.rss;
    const counts = {
      valid: 0,
      invalid: 0,
      sourceFailure: 0,
      observerFailure: 0,
      timeout: 0,
      iteratorsClosed: 0,
    };
    try {
      for (let cycle = 0; cycle < 100; cycle++) {
        const ordinary = await compileSchema(part);
        const a = ordinary.createValidator(),
          b = ordinary.createValidator();
        let isolated;
        try {
          const results = await Promise.all([
            a.validate("<r>1</r>"),
            b.validate("<r>bad</r>"),
          ]);
          assert.deepEqual(
            results.map((result) => result.valid),
            [true, false],
          );
          a.reset();
          b.reset();
          let observed = 0;
          if (cycle % 5 === 0) {
            await assert.rejects(
              compileIsolatedXercesSchema(root, {
                resourceMap: {
                  "https://lifecycle.invalid/part.xsd": part.replace(
                    "xs:int",
                    "xs:nonexistent",
                  ),
                },
                timeoutMs: 15000,
              }),
              { code: "INVALID_SCHEMA" },
            );
          }
          isolated = await compileIsolatedXercesSchema(root, {
            resourceMap: { "https://lifecycle.invalid/part.xsd": part },
            timeoutMs: 15000,
          });
          const mode = cycle % 5;
          let closed = false;
          const failure = { cycle };
          const source = {
            [Symbol.asyncIterator]() {
              let step = 0;
              return {
                async next() {
                  if (mode === 4) return new Promise(() => {});
                  if (mode === 2) throw failure;
                  return step++ === 0
                    ? {
                        value: mode === 0 ? "<r>2</r>" : "<r>bad</r>",
                        done: false,
                      }
                    : { done: true };
                },
                async return() {
                  closed = true;
                  return { done: true };
                },
              };
            },
          };
          if (mode === 0) {
            assert.equal(
              (await collect(isolated.validateStream(source))).valid,
              true,
            );
            counts.valid++;
          }
          if (mode === 1) {
            assert.equal(
              (
                await collect(
                  isolated.validateStream(source, {
                    onDiagnostic() {
                      observed++;
                    },
                  }),
                )
              ).valid,
              false,
            );
            assert.ok(observed > 0);
            assert.equal(isolated.disposed, false);
            counts.invalid++;
          }
          if (mode === 2) {
            await assert.rejects(
              collect(isolated.validateStream(source)),
              (error) => error === failure,
            );
            assert.equal(isolated.disposed, true);
            counts.sourceFailure++;
          }
          if (mode === 3) {
            await assert.rejects(
              collect(
                isolated.validateStream(source, {
                  onDiagnostic() {
                    throw failure;
                  },
                }),
              ),
              (error) => error === failure,
            );
            assert.equal(isolated.disposed, true);
            counts.observerFailure++;
          }
          if (mode === 4) {
            await assert.rejects(
              collect(isolated.validateStream(source, { timeoutMs: 100 })),
              { code: "TIMEOUT" },
            );
            assert.equal(isolated.disposed, true);
            counts.timeout++;
          }
          if (mode >= 2) {
            assert.equal(closed, true);
            counts.iteratorsClosed++;
          }
          assert.equal(isolated.busy, false);
          // Interrupting a worker must not disturb a different provider's live sessions.
          assert.equal((await a.validate("<r>3</r>")).valid, true);
        } finally {
          isolated?.dispose();
          isolated?.dispose();
          assert.equal(isolated?.disposed, true);
          a.dispose();
          ordinary.dispose();
          ordinary.dispose();
          assert.equal(a.disposed, true);
          assert.equal(b.disposed, true);
          assert.equal(ordinary.disposed, true);
        }
        const usage = process.memoryUsage();
        heapPeak = Math.max(heapPeak, usage.heapUsed);
        rssPeak = Math.max(rssPeak, usage.rss);
        wasmPeak = Math.max(
          wasmPeak,
          ...memories.map((ref) => ref.deref()?.buffer.byteLength ?? 0),
        );
      }
      // terminate() resolves asynchronously; bounded polling checks actual port shutdown.
      const deadline = Date.now() + 5000;
      while (ports() > initialPorts && Date.now() < deadline) await delay(20);
      assert.ok(
        ports() <= initialPorts,
        `worker MessagePorts remain: before ${initialPorts}, after ${ports()}`,
      );
      assert.deepEqual(counts, {
        valid: 20,
        invalid: 20,
        sourceFailure: 20,
        observerFailure: 20,
        timeout: 20,
        iteratorsClosed: 60,
      });
      assert.ok(
        memories.length >= 100,
        "observed actual default-provider WASM instances",
      );
      const end = process.memoryUsage();
      context.diagnostic(
        JSON.stringify({
          cycles: 100,
          counts,
          workerPorts: { before: initialPorts, after: ports() },
          jsHeap: {
            before: baseline.heapUsed,
            peak: heapPeak,
            after: end.heapUsed,
          },
          rss: { before: baseline.rss, peak: rssPeak, after: end.rss },
          mainRealmWasm: {
            instancesObserved: memories.length,
            largestObservedCapacity: wasmPeak,
          },
          interpretation:
            "WASM capacity is a high-water allocation, not live native bytes. Worker WASM memory is not visible in this realm. RSS includes workers and allocator retention; no portable memory/leak threshold is asserted.",
        }),
      );
    } finally {
      WebAssembly.instantiate = instantiate;
    }
  },
);
