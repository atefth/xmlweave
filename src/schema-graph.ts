import { parseXml, serializeXml } from "./index.js";
import { normalizeSchemaSource } from "./schema-sources.js";
import { SchemaError } from "./validation-types.js";
import type {
  SchemaSource,
  SchemaSourceOptions,
  SchemaSourceKind,
} from "./validation-types.js";
export interface SchemaResourceRequest {
  readonly kind: "include" | "import" | "redefine" | "hint";
  readonly namespace?: string;
  readonly systemId?: string;
  readonly baseURI: string;
  readonly requestedURI: string;
}
export interface SchemaGraphOptions extends SchemaSourceOptions {
  resourceMap?: Readonly<Record<string, SchemaSource>>;
  namespaceCatalog?: Readonly<Record<string, string>>;
  resolver?: (
    request: Readonly<SchemaResourceRequest>,
  ) => SchemaSource | undefined | Promise<SchemaSource | undefined>;
  maxDocuments?: number;
  maxGraphDepth?: number;
  maxGraphBytes?: number;
  maxRequests?: number;
}
export interface SchemaGraph {
  root: string;
  resources: Record<string, string>;
  sourceIds: readonly string[];
  resourceMetadata: Record<
    string,
    { sourceKind: SchemaSourceKind; provenance: "original" | "generated" }
  >;
}
const XSD = "http://www.w3.org/2001/XMLSchema";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
function positive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer no greater than ${fallback}.`,
    );
  return value;
}
function canonical(
  id: string,
  base = "https://xmlweave.invalid/root.xsd",
): string {
  try {
    const URLClass = (
      globalThis as unknown as {
        URL: new (id: string, base?: string) => { href: string };
      }
    ).URL;
    return new URLClass(id, base).href;
  } catch (cause) {
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Resource identifiers must resolve as URLs.",
      [],
      cause,
    );
  }
}
/** XML-aware preflight. Hints never trigger incidental transport. */
export function inspectInstance(
  text: string,
  approvedHints?: readonly InstanceSchemaHint[],
  systemId?: string,
): void {
  const doc = parseXml(text);
  if (
    approvedHints &&
    (doc.documentElement!.hasAttributeNS(XSI, "schemaLocation") ||
      doc.documentElement!.hasAttributeNS(XSI, "noNamespaceSchemaLocation"))
  ) {
    const actual = readInstanceSchemaHints(text, systemId);
    if (
      actual.some(
        (hint) =>
          !approvedHints.some(
            (approved) =>
              approved.namespace === hint.namespace &&
              approved.uri === hint.uri,
          ),
      )
    )
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        "Instance hints differ from the explicitly compiled catalogue.",
      );
  }
  const stack = [doc.documentElement!];
  while (stack.length) {
    const el = stack.pop()!;
    if (
      el.namespaceURI === "http://www.w3.org/2001/XInclude" ||
      ((el.hasAttributeNS(XSI, "schemaLocation") ||
        el.hasAttributeNS(XSI, "noNamespaceSchemaLocation")) &&
        (!approvedHints || el !== doc.documentElement))
    )
      throw new SchemaError(
        "EXTERNAL_RESOURCE_FORBIDDEN",
        "XInclude and instance hints are forbidden in explicit grammar mode.",
      );
    for (const child of Array.from(el.childNodes))
      if (child.nodeType === 1) stack.push(child as typeof el);
  }
}
export async function prepareSchemaGraph(
  input: SchemaSource | readonly SchemaSource[],
  options: SchemaGraphOptions = {},
): Promise<SchemaGraph> {
  const countLimit = positive(options.maxDocuments, 128, "maxDocuments"),
    depthLimit = positive(options.maxGraphDepth, 32, "maxGraphDepth"),
    byteLimit = positive(options.maxGraphBytes, 8_000_000, "maxGraphBytes"),
    requestLimit = positive(options.maxRequests, 512, "maxRequests");
  const roots = Array.isArray(input) ? input : [input];
  const entries = Object.entries(options.resourceMap ?? {});
  if (roots.length > countLimit || entries.length > countLimit)
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Schema catalogue document limit exceeded.",
    );
  // Check every fixed-size source before snapshotting any resource. Unused
  // catalogue entries still occupy memory and must fit the catalogue budget.
  preflightSources(
    entries.map(([, source]) => source),
    byteLimit,
  );
  preflightSources(roots, byteLimit);
  const map: Record<string, SchemaSource> = {};
  for (const [key, value] of entries) {
    const id = canonical(key);
    if (Object.hasOwn(map, id))
      throw new SchemaError(
        "INVALID_ARGUMENT",
        "Resource identifiers must be canonically unique.",
      );
    map[id] = snapshot(value);
  }
  const catalog = { ...options.namespaceCatalog };
  const resources: Record<string, string> = Object.create(null),
    namespaces = new Map<string, string>();
  const resourceMetadata: SchemaGraph["resourceMetadata"] = Object.create(null);
  let bytes = 0,
    requests = 0;
  if (!roots.length)
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "At least one schema source is required.",
    );
  const normalized = await Promise.all(
    roots.map((source) => normalizeSchemaSource(source, options)),
  );
  const reserved = new Set([
    ...Object.keys(map),
    ...normalized
      .filter((s) => s.systemId !== undefined)
      .map((s) => canonical(s.systemId!)),
  ]);
  const fresh = (preferred: string) => {
    let id = preferred,
      index = 0;
    while (reserved.has(id))
      id = preferred.replace(/\.xsd$/, `-${++index}.xsd`);
    reserved.add(id);
    return id;
  };
  const ids = normalized.map((source, i) =>
    source.systemId !== undefined
      ? canonical(source.systemId)
      : fresh(`https://xmlweave.invalid/source-${i}.xsd`),
  );
  for (let i = 0; i < ids.length; i++) {
    if (ids.indexOf(ids[i]!) !== i)
      throw new SchemaError(
        "INVALID_ARGUMENT",
        "Schema set source identifiers must be unique.",
      );
    map[ids[i]!] = {
      kind: "text",
      text: normalized[i]!.text,
      systemId: ids[i],
    };
  }
  async function visit(
    text: string,
    id: string,
    depth: number,
    metadata: SchemaGraph["resourceMetadata"][string],
  ): Promise<void> {
    if (options.signal?.aborted)
      throw new SchemaError("ABORTED", "Schema graph loading was aborted.");
    if (Object.hasOwn(resources, id)) return;
    if (depth > depthLimit || Object.keys(resources).length >= countLimit)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Schema graph document/depth limit exceeded.",
      );
    bytes += new (TextEncoderCompat())().encode(text).length;
    if (bytes > byteLimit)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Schema graph byte limit exceeded.",
      );
    let doc;
    try {
      doc = parseXml(text);
    } catch (cause) {
      throw new SchemaError(
        "INVALID_SCHEMA",
        "Schema resource is not safe well-formed XML.",
        [],
        cause,
      );
    }
    const root = doc.documentElement!;
    if (root.namespaceURI !== XSD || root.localName !== "schema")
      throw new SchemaError(
        "INVALID_SCHEMA",
        "Expected an XSD schema resource.",
      );
    reserved.add(id);
    namespaces.set(id, root.getAttribute("targetNamespace") ?? "");
    resources[id] = text;
    resourceMetadata[id] = {
      sourceKind: metadata.sourceKind,
      provenance: metadata.provenance,
    };
    let rewritten = false;
    const stack = [{ element: root, annotationContent: false }];
    while (stack.length) {
      const { element: el, annotationContent } = stack.pop()!;
      if (
        el.namespaceURI === "http://www.w3.org/2001/XInclude" ||
        el.hasAttributeNS(XSI, "schemaLocation") ||
        el.hasAttributeNS(XSI, "noNamespaceSchemaLocation")
      )
        throw new SchemaError(
          "EXTERNAL_RESOURCE_FORBIDDEN",
          "Schema resources cannot use XInclude or instance hints.",
        );
      if (
        !annotationContent &&
        el.namespaceURI === XSD &&
        [
          "assert",
          "alternative",
          "openContent",
          "defaultOpenContent",
          "override",
        ].includes(el.localName)
      )
        throw new SchemaError(
          "UNSUPPORTED_CAPABILITY",
          "XSD 1.1 constructs are unsupported.",
        );
      if (
        !annotationContent &&
        el.namespaceURI === XSD &&
        ["include", "import", "redefine"].includes(el.localName)
      ) {
        if (++requests > requestLimit)
          throw new SchemaError(
            "RESOURCE_LIMIT",
            "Schema graph request limit exceeded.",
          );
        const kind = el.localName as SchemaResourceRequest["kind"],
          ns = el.getAttribute("namespace") ?? undefined;
        let location = el.getAttribute("schemaLocation") ?? undefined;
        if (!location && kind === "import") {
          location = catalog[ns ?? ""];
          if (!location) {
            const matching = ids.filter((key) => {
              const d = parseXml((map[key] as { text: string }).text);
              return (
                (d.documentElement!.getAttribute("targetNamespace") ?? "") ===
                (ns ?? "")
              );
            });
            if (matching.length === 1) location = matching[0];
          }
        }
        if (!location)
          throw new SchemaError(
            "EXTERNAL_RESOURCE_FORBIDDEN",
            "A schema import requires an explicit location or namespace catalogue entry.",
          );
        let base = id;
        const ancestors = [];
        for (
          let node: typeof el | null = el;
          node;
          node =
            node.parentNode?.nodeType === 1
              ? (node.parentNode as typeof el)
              : null
        )
          ancestors.unshift(node);
        for (const ancestor of ancestors) {
          const localBase = ancestor.getAttributeNS(
            "http://www.w3.org/XML/1998/namespace",
            "base",
          );
          if (localBase) base = canonical(localBase, base);
        }
        const requestedURI = canonical(location, base);
        if (!el.hasAttribute("schemaLocation")) {
          el.setAttribute("schemaLocation", requestedURI);
          rewritten = true;
        }
        let source: SchemaSource | undefined = map[requestedURI];
        if (!source && options.resolver)
          source = await options.resolver(
            Object.freeze({
              kind,
              namespace: ns,
              systemId: location,
              baseURI: base,
              requestedURI,
            }),
          );
        if (!source)
          throw new SchemaError(
            "EXTERNAL_RESOURCE_FORBIDDEN",
            `No explicit schema resource for ${requestedURI}.`,
          );
        const resolved = await normalizeSchemaSource(source, options);
        const rootIndex = ids.indexOf(requestedURI);
        await visit(
          resolved.text,
          requestedURI,
          depth + 1,
          rootIndex < 0 ? resolved : normalized[rootIndex]!,
        );
        const target = namespaces.get(requestedURI)!;
        if (
          kind === "import"
            ? target !== (ns ?? "")
            : target !== "" &&
              target !== (root.getAttribute("targetNamespace") ?? "")
        )
          throw new SchemaError(
            "INVALID_SCHEMA",
            "Schema resource target namespace does not match its composition directive.",
          );
      }
      // Annotation payloads are data; security checks still visit every element.
      const childAnnotationContent =
        annotationContent ||
        (el.namespaceURI === XSD &&
          ["appinfo", "documentation"].includes(el.localName));
      for (const child of Array.from(el.childNodes))
        if (child.nodeType === 1)
          stack.push({
            element: child as typeof root,
            annotationContent: childAnnotationContent,
          });
    }
    if (rewritten) {
      resources[id] = serializeXml(doc);
      resourceMetadata[id]!.provenance = "generated";
    }
  }
  for (let i = 0; i < normalized.length; i++)
    await visit(normalized[i]!.text, ids[i]!, 0, normalized[i]!);
  let root = ids[0]!;
  if (ids.length > 1) {
    root = fresh("https://xmlweave.invalid/schema-set.xsd");
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const ns = namespaces.get(id)!;
      groups.set(ns, [...(groups.get(ns) ?? []), id]);
    }
    const imports: string[] = [];
    let i = 0;
    for (const [ns, group] of groups) {
      const wrapper = fresh(`https://xmlweave.invalid/set-${i++}.xsd`);
      resourceMetadata[wrapper] = {
        sourceKind: "text",
        provenance: "generated",
      };
      resources[wrapper] =
        `<xs:schema xmlns:xs="${XSD}"${ns ? ` targetNamespace="${escape(ns)}"` : ""}>${group.map((id) => `<xs:include schemaLocation="${escape(id)}"/>`).join("")}</xs:schema>`;
      imports.push(
        ns
          ? `<xs:import namespace="${escape(ns)}" schemaLocation="${wrapper}"/>`
          : `<xs:include schemaLocation="${wrapper}"/>`,
      );
    }
    resourceMetadata[root] = { sourceKind: "text", provenance: "generated" };
    resources[root] =
      `<xs:schema xmlns:xs="${XSD}">${imports.join("")}</xs:schema>`;
  }
  const finalBytes = Object.values(resources).reduce(
    (sum, text) => sum + new (TextEncoderCompat())().encode(text).length,
    0,
  );
  if (Object.keys(resources).length > countLimit || finalBytes > byteLimit)
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Generated schema-set wrappers exceed the graph document/byte budget.",
    );
  return { root, resources, sourceIds: Object.freeze(ids), resourceMetadata };
}
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
function TextEncoderCompat(): new () => { encode(text: string): Uint8Array } {
  return (
    globalThis as unknown as {
      TextEncoder: new () => { encode(text: string): Uint8Array };
    }
  ).TextEncoder;
}

function snapshot(source: SchemaSource): SchemaSource {
  if (typeof source === "string") return source;
  if (source.kind === "bytes")
    return { ...source, bytes: source.bytes.slice() };
  if (source.kind === "dom")
    return {
      ...source,
      node: source.node.cloneNode(true) as typeof source.node,
    };
  return { ...source };
}

function preflightSources(
  sources: readonly SchemaSource[],
  limit: number,
): void {
  let bytes = 0;
  const add = (text: string) => {
    // Count UTF-8 without allocating an encoded copy of an oversized string.
    for (const scalar of text) {
      const point = scalar.codePointAt(0)!;
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes > limit) fail();
    }
  };
  const fail = (): never => {
    throw new SchemaError(
      "RESOURCE_LIMIT",
      "Schema catalogue byte limit exceeded.",
    );
  };
  for (const source of sources) {
    if (typeof source === "string") add(source);
    else if (source?.kind === "text") add(source.text);
    else if (source?.kind === "bytes") {
      bytes += source.bytes.byteLength;
      if (bytes > limit) fail();
    } else if (source?.kind === "dom") {
      // A lower bound on serialized size rejects oversized DOMs before clone.
      // Exact escaped/generated sizes remain checked after normalization.
      const root = source.node as import("slimdom").Node;
      let node: import("slimdom").Node | null = root;
      while (node) {
        if (node.nodeType !== 9) add(node.nodeValue ?? node.nodeName);
        if (node.nodeType === 1)
          for (const attribute of Array.from(
            (node as import("slimdom").Element).attributes,
          )) {
            add(attribute.name);
            add(attribute.value);
          }
        if (node.firstChild) node = node.firstChild;
        else {
          while (node !== root && !node.nextSibling) node = node.parentNode!;
          node = node === root ? null : node.nextSibling;
        }
      }
    }
  }
}

export interface InstanceSchemaHint {
  namespace: string;
  location: string;
  uri: string;
}
/** Read only explicit root hints; this function never resolves or fetches. */
export function readInstanceSchemaHints(
  text: string,
  systemId?: string,
): InstanceSchemaHint[] {
  const doc = parseXml(text),
    root = doc.documentElement!,
    base = canonical(
      root.getAttributeNS("http://www.w3.org/XML/1998/namespace", "base") ??
        systemId ??
        "https://xmlweave.invalid/instance.xml",
      systemId,
    );
  const hints: InstanceSchemaHint[] = [];
  const paired = root.getAttributeNS(XSI, "schemaLocation");
  if (paired !== null) {
    const words = paired.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length % 2 !== 0)
      throw new SchemaError(
        "INVALID_XML",
        "schemaLocation must contain namespace/location pairs.",
      );
    for (let i = 0; i < words.length; i += 2)
      hints.push({
        namespace: words[i]!,
        location: words[i + 1]!,
        uri: canonical(words[i + 1]!, base),
      });
  }
  const noNamespace = root.getAttributeNS(XSI, "noNamespaceSchemaLocation");
  if (noNamespace !== null) {
    if (!noNamespace.trim() || /\s/.test(noNamespace.trim()))
      throw new SchemaError(
        "INVALID_XML",
        "noNamespaceSchemaLocation requires one location.",
      );
    hints.push({
      namespace: "",
      location: noNamespace.trim(),
      uri: canonical(noNamespace.trim(), base),
    });
  }
  const namespaces = new Set<string>();
  for (const hint of hints) {
    if (namespaces.has(hint.namespace))
      throw new SchemaError("INVALID_XML", "Duplicate schema hint namespace.");
    namespaces.add(hint.namespace);
  }
  if (!hints.some((hint) => hint.namespace === (root.namespaceURI ?? "")))
    throw new SchemaError(
      "INVALID_XML",
      "Schema hints must include the instance root namespace.",
    );
  return hints;
}
