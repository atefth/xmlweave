import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error("Run this fixture through npm run test:validation-browser.");
const temporary = await mkdtemp(join(tmpdir(), "xmlweave validation browser "));
function npm(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `npm ${args.join(" ")} failed:\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return result.stdout;
}
let server;
try {
  if (process.env.XMLWEAVE_SKIP_BUILD !== "1") npm(["run", "build"]);
  const packed = JSON.parse(
    npm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporary,
    ]),
  );
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      join(temporary, packed[0].filename),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    temporary,
  );
  const corpusDirectory = join(root, "test/fixtures/w3c-nist");
  const corpusManifest = JSON.parse(
    await readFile(join(corpusDirectory, "manifest.json"), "utf8"),
  );
  const originalSource = async (source) => {
    const bytes = await readFile(
      join(corpusDirectory, "upstream", source.path),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      throw new Error(`Changed external corpus bytes: ${source.path}`);
    return {
      kind: "bytes",
      bytes: Array.from(bytes),
      systemId: `https://raw.githubusercontent.com/w3c/xsdtests/${corpusManifest.revision}/${source.path}`,
    };
  };
  const corpus = await Promise.all(
    corpusManifest.groups.map(async (group) => ({
      group: group.group,
      schema: await originalSource(
        group.tests.find((item) => item.kind === "schemaTest").source,
      ),
      instances: await Promise.all(
        group.tests
          .filter((item) => item.kind === "instanceTest")
          .map(async (item) => ({
            name: item.name,
            source: await originalSource(item.source),
            valid: item.expected.validity === "valid",
          })),
      ),
    })),
  );
  const bundle = join(temporary, "validation.mjs");
  await build({
    stdin: {
      contents:
        'export * from "xmlweave/schema-xerces-isolated"; export {parseXml} from "xmlweave"; export {compileSchema} from "xmlweave/schema"; export {createSchemaFactory} from "xmlweave/schema-factory"; export {xercesSchemaProvider,javaSchemaProvider,validationPolicyNames} from "xmlweave/schema-providers"; export {createHintValidator} from "xmlweave/schema-hints";',
      resolveDir: temporary,
    },
    outfile: bundle,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: [
      "./vendor-xerces-worker-node.js",
      "./vendor-xerces-runtime.js",
      "node:*",
    ],
  });
  const unexpectedRequests = [];
  server = createServer(async (request, response) => {
    try {
      const path = request.url;
      if (path !== "/no-isolation") {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      }
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (path === "/" || path === "/no-isolation") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          "<!doctype html><title>XMLWeave packed validation</title>",
        );
      } else if (path === "/validation.mjs") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(bundle));
      } else if (path === "/cpu-worker.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end("while(true){}");
      } else if (
        /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|cjs|wasm)$/.test(path ?? "")
      ) {
        response.setHeader(
          "Content-Type",
          path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        response.end(
          await readFile(
            join(
              temporary,
              "node_modules/xmlweave/dist",
              path.slice("/assets/".length),
            ),
          ),
        );
      } else if (
        /^\/(?:vendor-xerces-runtime|xerces-engine)\.(?:js|wasm)$/.test(
          path ?? "",
        )
      ) {
        response.setHeader(
          "Content-Type",
          path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        response.end(
          await readFile(
            join(temporary, "node_modules/xmlweave/dist", path.slice(1)),
          ),
        );
      } else if (path === "/favicon.ico") response.writeHead(204).end();
      else {
        unexpectedRequests.push(path);
        response.writeHead(404).end();
      }
    } catch (error) {
      unexpectedRequests.push(`${request.url}: ${error.message}`);
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engines = { chromium, firefox, webkit };
  for (const name of (
    process.env.XMLWEAVE_BROWSERS ?? "chromium,firefox,webkit"
  ).split(",")) {
    if (!engines[name]) throw new Error(`Unknown browser: ${name}`);
    const browser = await engines[name].launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          unexpectedRequests.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(
        async ({ corpus }) => {
          const {
            compileIsolatedXercesSchema,
            compileSchema,
            createSchemaFactory,
            xercesSchemaProvider,
            javaSchemaProvider,
            validationPolicyNames,
            createHintValidator,
            parseXml,
          } = await import("/validation.mjs");
          let assertions = 0;
          const assert = (value, message) => {
            if (!value) throw new Error(message);
            assertions++;
          };
          const X = "http://www.w3.org/2001/XMLSchema";
          const schema = (body) =>
            `<xs:schema xmlns:xs="${X}">${body}</xs:schema>`;
          const workerURL = new URL(
            "/assets/schema-xerces-worker.js",
            location.href,
          ).href;
          assert(
            crossOriginIsolated === true &&
              typeof SharedArrayBuffer === "function",
            "COOP/COEP enables exact handler shared memory",
          );
          const options = {
            workerURL,
            timeoutMs: 20000,
            typeQueries: [{ namespaceURI: X, name: "decimal", method: 0 }],
          };
          const graph = {
            kind: "text",
            systemId: "https://schemas.invalid/root.xsd",
            text: schema(
              '<xs:include schemaLocation="types.xsd"/><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="n" type="Code"/></xs:sequence><xs:attribute name="mode" type="xs:token" default=" hello   world "/><xs:attribute name="id" type="xs:ID"/></xs:complexType></xs:element>',
            ),
          };
          const resourceMap = {
            "https://schemas.invalid/types.xsd": schema(
              '<xs:simpleType name="Code"><xs:restriction base="xs:int"/></xs:simpleType>',
            ),
          };
          const grammar = await compileIsolatedXercesSchema(graph, {
            ...options,
            resourceMap,
          });
          try {
            const events = [];
            for await (const event of grammar.validateStream([
              '<root id="one"><n>',
              "4</n></root>",
            ]))
              events.push(event);
            assert(events.at(-1).result.valid, "valid native result");
            const root = events.find((event) => event.kind === "startElement");
            const number = events.find(
              (event) => event.kind === "endElement" && event.name === "n",
            );
            assert(
              root.attributes.find((attribute) => attribute.name === "mode")
                .value === "hello world",
              "native default and whitespace normalization",
            );
            assert(
              root.attributes.find((attribute) => attribute.name === "mode")
                .specified === false,
              "native default provenance",
            );
            assert(
              root.attributes.find((attribute) => attribute.name === "id")
                .isId === true,
              "native ID metadata",
            );
            assert(
              number.psvi.type.name === "Code",
              "actual named derived type",
            );
            assert(
              number.psvi.type.derivations[0] === true,
              "native derivation query",
            );
            assert(
              Object.isFrozen(number.psvi.type),
              "immutable retained metadata",
            );
            const bytes = await grammar.validate({
              kind: "bytes",
              bytes: new TextEncoder().encode("<root><n>bad</n></root>"),
              systemId: "urn:packed-bytes",
            });
            assert(bytes.valid === false, "invalid byte source");
            assert(
              bytes.diagnostics[0].sourceKind === "bytes",
              "byte provenance",
            );
            assert(
              bytes.diagnostics[0].systemId === "urn:packed-bytes",
              "original source identifier",
            );
            const doc = parseXml("<root><n>5</n></root>");
            assert(
              (await grammar.validate({ kind: "dom", node: doc })).valid,
              "DOM source from actual packed core",
            );
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
            let early = false;
            try {
              for await (const event of grammar.validateStream(chunks()))
                if (event.kind === "diagnostic" && !early) {
                  assert(!eof, "native error before EOF");
                  early = true;
                  release();
                }
            } finally {
              release();
            }
            assert(early, "incremental error delivered");
            assert(closed, "source closed after completion");
            assert(
              (await grammar.validate("<root><n>6</n></root>")).valid,
              "reuse after invalidity",
            );
            let allowHandler, enteredHandler;
            const handlerGate = new Promise(
                (resolve) => (allowHandler = resolve),
              ),
              handlerEntered = new Promise(
                (resolve) => (enteredHandler = resolve),
              );
            let handlerCalls = 0,
              handlerEvents = 0;
            const handled = (async () => {
              let result;
              for await (const event of grammar.validateStream(
                ["<root><n>x</n></root>"],
                {
                  maxDiagnostics: 1,
                  diagnosticHandler: async () => {
                    handlerCalls++;
                    if (handlerCalls === 1) {
                      enteredHandler();
                      await handlerGate;
                    }
                  },
                },
              )) {
                handlerEvents++;
                if (event.kind === "result") result = event.result;
              }
              return result;
            })();
            await handlerEntered;
            const paused = { handlerCalls, handlerEvents };
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert(
              handlerCalls === paused.handlerCalls &&
                handlerEvents === paused.handlerEvents,
              "exact asynchronous handler gates native progress",
            );
            allowHandler();
            assert(
              !(await handled).valid,
              "continued custom handler retains invalid final result",
            );
            assert(
              handlerCalls >= 1,
              "actual native diagnostic reaches host handler",
            );
          } finally {
            grammar.dispose();
          }
          const identity = schema(
            '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="item" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element><xs:element name="ref" minOccurs="0"><xs:complexType><xs:attribute name="to" type="xs:string"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:key name="ids"><xs:selector xpath="item"/><xs:field xpath="@id"/></xs:key><xs:keyref name="refs" refer="ids"><xs:selector xpath="ref"/><xs:field xpath="@to"/></xs:keyref></xs:element>',
          );
          const keys = await compileIsolatedXercesSchema(identity, options);
          try {
            assert(
              !(await keys.validate('<root><ref to="missing"/></root>')).valid,
              "late keyref error reflected in final validity",
            );
          } finally {
            keys.dispose();
          }
          const nativeFactory = createSchemaFactory(
            xercesSchemaProvider({
              wasmUrl: new URL("/assets/xerces-engine.wasm", location.href)
                .href,
            }),
            { features: { identityConstraints: false } },
          );
          assert(
            nativeFactory.getFeature("identityConstraints") === false,
            "real provider negotiates native feature",
          );
          const unchecked = await nativeFactory.compile(identity);
          try {
            assert(
              (await unchecked.validate('<root><ref to="missing"/></root>'))
                .valid,
              "negotiated identity feature actually changes native engine behavior",
            );
          } finally {
            unchecked.dispose();
          }
          let forbidden;
          try {
            createSchemaFactory(xercesSchemaProvider(), {
              features: { [validationPolicyNames.secureProcessing]: false },
            });
          } catch (error) {
            forbidden = error.code;
          }
          assert(
            forbidden === "UNSUPPORTED_CAPABILITY",
            "secure factory setting cannot be disabled",
          );
          let javaRejected;
          try {
            await createSchemaFactory(javaSchemaProvider()).compile(schema(""));
          } catch (error) {
            javaRejected = error.code;
          }
          assert(
            javaRejected === "UNSUPPORTED_CAPABILITY",
            "explicit Java provider rejects browser without loading Node dependencies",
          );
          const variants = (value) =>
            schema(
              `<xs:element name="r"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="${value}"/></xs:restriction></xs:simpleType></xs:element>`,
            );
          const hinted = await createHintValidator({
            workerURL,
            timeoutMs: 20000,
            maxCachedSchemas: 2,
            resourceMap: {
              "https://dynamic.invalid/a.xsd": variants("A"),
              "https://dynamic.invalid/b.xsd": variants("B"),
              "https://dynamic.invalid/root.xsd": `<xs:schema xmlns:xs="${X}" targetNamespace="urn:r"><xs:element name="r"><xs:complexType><xs:sequence><xs:any namespace="urn:t" processContents="strict"/></xs:sequence></xs:complexType></xs:element></xs:schema>`,
              "https://dynamic.invalid/types.xsd": `<xs:schema xmlns:xs="${X}" targetNamespace="urn:t"><xs:element name="item" type="xs:int"/></xs:schema>`,
            },
          });
          const hintedInput = (location, value) => ({
            kind: "text",
            systemId: "https://dynamic.invalid/instance.xml",
            text: `<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${location}">${value}</r>`,
          });
          try {
            assert(
              (await hinted.validate(hintedInput("a.xsd", "A"))).valid,
              "first instance hint selects first grammar",
            );
            assert(
              (await hinted.validate(hintedInput("b.xsd", "B"))).valid,
              "next document hint selects different grammar",
            );
            assert(
              !(await hinted.validate(hintedInput("b.xsd", "A"))).valid,
              "hint-selected grammar remains authoritative",
            );
            assert(
              (await hinted.validate(hintedInput("a.xsd", "A"))).valid,
              "cached hinted grammar reuses correctly",
            );
            assert(
              hinted.cacheSize === 2,
              "dynamic grammar cache remains bounded",
            );
            const nested = {
              kind: "text",
              systemId: "https://dynamic.invalid/instance.xml",
              text: '<r xmlns="urn:r" xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:r root.xsd"><t:item xsi:schemaLocation="urn:t types.xsd">7</t:item></r>',
            };
            assert(
              (await hinted.validate(nested)).valid,
              "document-wide nested hints compile all approved namespace grammars",
            );
            assert(
              !(
                await hinted.validate({
                  ...nested,
                  text: nested.text.replace(">7<", ">bad<"),
                })
              ).valid,
              "nested hinted namespace enforces its actual datatype",
            );
            assert(
              hinted.cacheSize === 2,
              "new namespace hint set evicts only idle grammar",
            );
          } finally {
            hinted.dispose();
          }

          const anonymousSchema = schema(
            '<xs:element name="r"><xs:simpleType><xs:restriction base="xs:int"><xs:minInclusive value="0"/></xs:restriction></xs:simpleType></xs:element>',
          );
          const anonymousGrammar = await compileIsolatedXercesSchema(
              anonymousSchema,
              options,
            ),
            foreignGrammar = await compileIsolatedXercesSchema(
              anonymousSchema,
              options,
            );
          try {
            let anonymousType;
            for await (const event of anonymousGrammar.validateStream([
              "<r>1</r>",
            ]))
              if (event.kind === "endElement") anonymousType = event.psvi.type;
            assert(
              anonymousType.anonymous &&
                typeof anonymousType.name === "string" &&
                anonymousType.name.length > 0,
              "anonymous type has stable generated QName",
            );
            const self = {
              namespaceURI: anonymousType.namespaceURI,
              name: anonymousType.name,
            };
            assert(
              await anonymousGrammar.queryTypeDerivation(
                anonymousType.identity,
                self,
                1,
              ),
              "retained anonymous self-restriction query",
            );
            assert(
              !(await anonymousGrammar.queryTypeDerivation(
                anonymousType.identity,
                self,
                2,
              )),
              "anonymous self-extension query is false",
            );
            assert(
              await anonymousGrammar.queryTypeDerivation(
                anonymousType.identity,
                { namespaceURI: X, name: "int" },
                1,
              ),
              "arbitrary runtime ancestor query uses retained native type graph",
            );
            let foreign;
            try {
              await foreignGrammar.queryTypeDerivation(
                anonymousType.identity,
                { namespaceURI: X, name: "int" },
                1,
              );
            } catch (error) {
              foreign = error.code;
            }
            assert(
              foreign === "INVALID_ARGUMENT",
              "another grammar cannot consume retained type identity",
            );
            assert(
              !foreignGrammar.disposed,
              "foreign identity rejection preserves owning worker",
            );
          } finally {
            anonymousGrammar.dispose();
            foreignGrammar.dispose();
          }
          let heartbeat = false;
          setTimeout(() => (heartbeat = true), 1);
          let timeout;
          try {
            await compileIsolatedXercesSchema(schema(""), {
              workerURL: new URL("/cpu-worker.js", location.href).href,
              timeoutMs: 80,
            });
          } catch (error) {
            timeout = error.code;
          }
          assert(timeout === "TIMEOUT", "hard CPU worker deadline");
          assert(heartbeat, "host responsive during worker CPU load");
          const defaults = await compileSchema(
            schema('<xs:element name="r" type="xs:base64Binary"/>'),
            {
              wasmUrl: new URL("/assets/xerces-engine.wasm", location.href)
                .href,
            },
          );
          try {
            assert(
              (await defaults.validate("<r>YQ==</r>")).valid,
              "default facade valid base64",
            );
            assert(
              !(await defaults.validate("<r>%%%</r>")).valid,
              "default facade rejects illegal base64",
            );
            const session = defaults.createValidator();
            try {
              session.reset();
              assert(
                (await session.validate("<r>Yg==</r>")).valid,
                "default facade independent resettable session",
              );
            } finally {
              session.dispose();
            }
          } finally {
            defaults.dispose();
          }
          for (const group of corpus) {
            const restore = (source) => ({
              ...source,
              bytes: new Uint8Array(source.bytes),
            });
            const external = await compileIsolatedXercesSchema(
              restore(group.schema),
              options,
            );
            try {
              for (const item of group.instances) {
                const outcome = await external.validate(restore(item.source));
                assert(
                  outcome.valid === item.valid,
                  `external ${group.group}/${item.name}: unchanged upstream expected ${item.valid}; ${outcome.diagnostics.map((d) => d.message).join("; ")}`,
                );
              }
            } finally {
              external.dispose();
            }
          }
          return { assertions };
        },
        { corpus },
      );
      const unavailable = await context.newPage();
      await unavailable.goto(origin + "/no-isolation");
      const negotiation = await unavailable.evaluate(async () => {
        const { compileIsolatedXercesSchema, createHintValidator } =
          await import("/validation.mjs");
        let consumed = false,
          code,
          hintFactoryConsumed = false,
          hintFactoryCode,
          hintValidationConsumed = false,
          hintValidationCode;
        try {
          await compileIsolatedXercesSchema(
            {
              kind: "chunks",
              chunks: (function* () {
                consumed = true;
                yield "<never/>";
              })(),
            },
            {
              workerURL: new URL(
                "/assets/schema-xerces-worker.js",
                location.href,
              ).href,
              diagnosticHandler() {},
            },
          );
        } catch (error) {
          code = error.code;
        }
        try {
          await createHintValidator({
            diagnosticHandler() {},
            resourceMap: {
              "https://never.invalid/schema.xsd": {
                kind: "chunks",
                chunks: (function* () {
                  hintFactoryConsumed = true;
                  yield "<never/>";
                })(),
              },
            },
          });
        } catch (error) {
          hintFactoryCode = error.code;
        }
        const hints = await createHintValidator();
        try {
          await hints.validate(
            {
              kind: "chunks",
              chunks: (function* () {
                hintValidationConsumed = true;
                yield "<never/>";
              })(),
            },
            { diagnosticHandler() {} },
          );
        } catch (error) {
          hintValidationCode = error.code;
        } finally {
          hints.dispose();
        }
        return {
          isolated: crossOriginIsolated,
          consumed,
          code,
          hintFactoryConsumed,
          hintFactoryCode,
          hintValidationConsumed,
          hintValidationCode,
        };
      });
      if (
        negotiation.isolated ||
        negotiation.consumed ||
        negotiation.code !== "UNSUPPORTED_CAPABILITY" ||
        negotiation.hintFactoryConsumed ||
        negotiation.hintFactoryCode !== "UNSUPPORTED_CAPABILITY" ||
        negotiation.hintValidationConsumed ||
        negotiation.hintValidationCode !== "UNSUPPORTED_CAPABILITY"
      )
        throw new Error(
          `Invalid unavailable-handler negotiation: ${JSON.stringify(negotiation)}`,
        );
      await unavailable.close();
      console.log(
        `${name}: ${result.assertions + 7} packed native worker validation assertions passed.`,
      );
    } finally {
      await browser.close();
    }
  }
  if (unexpectedRequests.length)
    throw new Error(
      `Unexpected resource requests: ${JSON.stringify(unexpectedRequests)}`,
    );
  console.log(
    "Packed Xerces worker assets, native PSVI, incremental validation and hard deadlines verified.",
  );
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
