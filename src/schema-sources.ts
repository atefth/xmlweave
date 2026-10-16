import { recordNormalizedSourceBytes } from "./validation-types.js";
import type { Document, Element } from "slimdom";
import { parseXml, serializeXml } from "./index.js";
import {
  SchemaError,
  type SchemaSource,
  type SchemaSourceOptions,
  type NormalizedSchemaSource,
} from "./validation-types.js";

const ceilings = { maxBytes: 4_000_000, maxCharacters: 1_000_000 };
export function checkSchemaSignal(options?: SchemaSourceOptions): void {
  if (options?.signal?.aborted)
    throw new SchemaError("ABORTED", "Schema operation was aborted.");
}
export function sourceLimits(options?: SchemaSourceOptions) {
  if (
    options !== undefined &&
    (!options || typeof options !== "object" || Array.isArray(options))
  )
    throw new SchemaError("INVALID_ARGUMENT", "Options must be an object.");
  const result = { ...ceilings };
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    const value = options?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
        throw new SchemaError(
          "INVALID_ARGUMENT",
          `${key} must be an integer from 1 to ${ceilings[key]}.`,
        );
      result[key] = value;
    }
  }
  if (
    options?.signal !== undefined &&
    (!options.signal || typeof options.signal.aborted !== "boolean")
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "signal must expose a boolean aborted property.",
    );
  return result;
}
function canonical(label: string): string {
  const l = label.toLowerCase().replace(/_/g, "-");
  if (["utf8", "utf-8"].includes(l)) return "utf-8";
  if (["utf16", "utf-16"].includes(l)) return "utf-16";
  if (["utf16le", "utf-16le"].includes(l)) return "utf-16le";
  if (["utf16be", "utf-16be"].includes(l)) return "utf-16be";
  if (["utf32", "utf-32"].includes(l)) return "utf-32";
  if (["utf32le", "utf-32le"].includes(l)) return "utf-32le";
  if (["utf32be", "utf-32be"].includes(l)) return "utf-32be";
  if (
    ["iso-8859-1", "iso8859-1", "iso_8859-1", "latin1", "latin-1"].includes(l)
  )
    return "iso-8859-1";
  if (["ascii", "us-ascii"].includes(l)) return "us-ascii";
  return l;
}
type Decoder = { decode(bytes: Uint8Array): string };
function decoder(encoding: string): Decoder {
  const RuntimeDecoder = (
    globalThis as unknown as {
      TextDecoder?: new (label: string, options: { fatal: boolean }) => Decoder;
    }
  ).TextDecoder;
  if (!RuntimeDecoder)
    throw new SchemaError(
      "UNSUPPORTED_ENCODING",
      "This runtime does not provide TextDecoder.",
    );
  try {
    return new RuntimeDecoder(encoding, { fatal: true });
  } catch (cause) {
    throw new SchemaError(
      "UNSUPPORTED_ENCODING",
      `Unsupported byte encoding: ${encoding}.`,
      [],
      cause,
    );
  }
}
function decode(bytes: Uint8Array, explicit?: string): string {
  let detected: string | undefined;
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0 &&
    bytes[3] === 0
  )
    detected = "utf-32le";
  else if (
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  )
    detected = "utf-32be";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) detected = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) detected = "utf-16be";
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    detected = "utf-8";
  else if (
    bytes[0] === 0 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0 &&
    bytes[3] === 0x3f
  )
    detected = "utf-16be";
  else if (
    bytes[0] === 0x3c &&
    bytes[1] === 0 &&
    bytes[2] === 0x3f &&
    bytes[3] === 0
  )
    detected = "utf-16le";
  else if (
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0x3c
  )
    detected = "utf-32be";
  else if (
    bytes[0] === 0x3c &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0
  )
    detected = "utf-32le";
  let declarationEnd = 0;
  if (
    bytes[0] === 60 &&
    bytes[1] === 63 &&
    bytes[2] === 120 &&
    bytes[3] === 109 &&
    bytes[4] === 108
  ) {
    declarationEnd = bytes.length;
    for (let index = 5; index < bytes.length - 1; index++)
      if (bytes[index] === 63 && bytes[index + 1] === 62) {
        declarationEnd = index + 2;
        break;
      }
  }
  const prefix = Array.from(bytes.subarray(0, declarationEnd), (byte) =>
    byte < 128 ? String.fromCharCode(byte) : "?",
  ).join("");
  const declaredAscii = /^<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i.exec(
    prefix,
  )?.[1];
  const chosen =
    explicit === undefined
      ? (detected ?? (declaredAscii ? canonical(declaredAscii) : "utf-8"))
      : canonical(explicit);
  const compatible = (a: string, b: string) =>
    a === b ||
    (["utf-16", "utf-32"].includes(a) && b.startsWith(a)) ||
    (["utf-16", "utf-32"].includes(b) && a.startsWith(b));
  if (detected && !compatible(chosen, detected))
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "Byte encoding conflicts with XML BOM/signature.",
    );
  let text: string;
  try {
    if (["utf-32", "utf-32le", "utf-32be"].includes(chosen)) {
      const endian = chosen === "utf-32" ? detected : chosen;
      if (!endian || endian === "utf-32")
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "UTF-32 needs an explicit byte order or BOM/signature.",
        );
      if (bytes.length % 4 !== 0)
        throw new SchemaError(
          "INVALID_XML",
          "UTF-32 input ends inside a code point.",
        );
      const pieces: string[] = [];
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      for (let offset = 0; offset < bytes.length; offset += 4) {
        const point = view.getUint32(offset, endian === "utf-32le");
        if (offset === 0 && point === 0xfeff) continue;
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          throw new SchemaError(
            "INVALID_XML",
            "UTF-32 input contains an invalid Unicode scalar.",
          );
        pieces.push(String.fromCodePoint(point));
      }
      text = pieces.join("");
    } else if (chosen === "iso-8859-1" || chosen === "us-ascii") {
      const pieces: string[] = [];
      for (const byte of bytes) {
        if (chosen === "us-ascii" && byte > 127)
          throw new SchemaError(
            "INVALID_XML",
            "ASCII XML contains a non-ASCII byte.",
          );
        pieces.push(String.fromCharCode(byte));
      }
      text = pieces.join("");
    } else
      text = decoder(
        chosen === "utf-16" ? (detected ?? "utf-16le") : chosen,
      ).decode(bytes);
  } catch (cause) {
    if (cause instanceof SchemaError) throw cause;
    throw new SchemaError(
      "INVALID_XML",
      "Malformed byte sequence for XML encoding.",
      [],
      cause,
    );
  }
  const declared = /^<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i.exec(
    text,
  )?.[1];
  if (declared && !compatible(canonical(declared), chosen))
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "XML encoding declaration conflicts with byte decoding.",
    );
  return text;
}
function domText(
  node: Document | Element,
  maxCharacters: number,
  systemId?: string,
): string {
  if (
    !node ||
    typeof node !== "object" ||
    ![1, 9].includes(node.nodeType) ||
    typeof node.cloneNode !== "function"
  )
    throw new SchemaError(
      "INVALID_ARGUMENT",
      "DOM source must be an XMLWeave document or element.",
    );
  if (node.nodeType === 9)
    return serializeXml(node as Document, { maxLength: maxCharacters });
  const element = node as Element;
  // Inspect the original tree before cloning, avoiding unbounded serializer recursion.
  const stack = [{ node: node as import("slimdom").Node, depth: 1 }];
  let count = 0;
  let characters = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    characters += entry.node.nodeValue?.length ?? 0;
    if (entry.node.nodeType === 1)
      for (const attribute of (entry.node as Element).attributes) {
        count++;
        characters += attribute.name.length + attribute.value.length;
      }
    if (++count > 100_000 || entry.depth > 256 || characters > maxCharacters)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "DOM source exceeds structural or character limits.",
      );
    for (const child of entry.node.childNodes)
      stack.push({
        node: child,
        depth: entry.depth + (child.nodeType === 1 ? 1 : 0),
      });
  }
  const doc = parseXml("<placeholder/>");
  doc.removeChild(doc.documentElement!);
  const copy = doc.importNode(node, true) as Element;
  doc.appendChild(copy);
  const ancestors: Element[] = [];
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (ancestors.length >= 256)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "DOM ancestor context exceeds nesting limits.",
      );
    ancestors.push(parent);
  }
  const xmlns = "http://www.w3.org/2000/xmlns/";
  const xml = "http://www.w3.org/XML/1998/namespace";
  for (const ancestor of ancestors)
    for (const attribute of ancestor.attributes)
      if (
        attribute.namespaceURI === xmlns &&
        !copy.hasAttributeNS(xmlns, attribute.localName)
      )
        copy.setAttributeNS(xmlns, attribute.name, attribute.value);
  {
    const bases = [...ancestors.slice().reverse(), element]
      .map((a) => a.getAttributeNS(xml, "base"))
      .filter((v): v is string => v !== null);
    if (bases.length) {
      const RuntimeURL = (
        globalThis as unknown as {
          URL?: new (url: string, base?: string) => { href: string };
        }
      ).URL;
      let base = systemId ?? bases[0]!;
      for (const next of systemId === undefined ? bases.slice(1) : bases) {
        try {
          if (!RuntimeURL) throw new Error();
          base = new RuntimeURL(next, base).href;
        } catch {
          throw new SchemaError(
            "UNSUPPORTED_CAPABILITY",
            "Inherited relative xml:base requires a resolvable absolute ancestor base or systemId.",
          );
        }
      }
      copy.setAttributeNS(xml, "xml:base", base);
    }
  }
  return serializeXml(doc);
}
/** Buffered source adapter; iterables do not imply incremental schema validation. */
export async function normalizeSchemaSource(
  input: SchemaSource,
  options?: SchemaSourceOptions,
): Promise<NormalizedSchemaSource> {
  const limits = sourceLimits(options);
  checkSchemaSignal(options);
  const source =
    typeof input === "string" ? { kind: "text" as const, text: input } : input;
  if (
    !source ||
    typeof source !== "object" ||
    !["text", "bytes", "dom", "chunks"].includes(source.kind)
  )
    throw new SchemaError("INVALID_ARGUMENT", "Expected a schema source.");
  if (source.systemId !== undefined && typeof source.systemId !== "string")
    throw new SchemaError("INVALID_ARGUMENT", "systemId must be a string.");
  let text: string;
  let originalBytes: number | undefined;
  if (source.kind === "text") {
    if (typeof source.text !== "string")
      throw new SchemaError(
        "INVALID_ARGUMENT",
        "Text source requires a string.",
      );
    text = source.text;
  } else if (source.kind === "dom")
    text = domText(source.node, limits.maxCharacters, source.systemId);
  else {
    if (source.encoding !== undefined && typeof source.encoding !== "string")
      throw new SchemaError("INVALID_ARGUMENT", "encoding must be a string.");
    if (source.kind === "bytes") {
      if (!(source.bytes instanceof Uint8Array))
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Byte source requires Uint8Array.",
        );
      if (source.bytes.byteLength > limits.maxBytes)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Byte source exceeds maxBytes.",
        );
      originalBytes = source.bytes.byteLength;
      text = decode(source.bytes, source.encoding);
    } else {
      if (
        !source.chunks ||
        (typeof (source.chunks as AsyncIterable<unknown>)[
          Symbol.asyncIterator
        ] !== "function" &&
          typeof (source.chunks as Iterable<unknown>)[Symbol.iterator] !==
            "function")
      )
        throw new SchemaError(
          "INVALID_ARGUMENT",
          "Chunks require an iterable.",
        );
      let mode: "text" | "bytes" | undefined;
      const strings: string[] = [];
      const buffers: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of source.chunks) {
        checkSchemaSignal(options);
        const kind =
          typeof chunk === "string"
            ? "text"
            : chunk instanceof Uint8Array
              ? "bytes"
              : undefined;
        if (!kind || (mode && mode !== kind))
          throw new SchemaError(
            "INVALID_ARGUMENT",
            "Chunks must contain only strings or only Uint8Arrays.",
          );
        mode = kind;
        total += typeof chunk === "string" ? chunk.length : chunk.byteLength;
        if (total > (kind === "text" ? limits.maxCharacters : limits.maxBytes))
          throw new SchemaError(
            "RESOURCE_LIMIT",
            "Chunk source exceeds its input budget.",
          );
        if (typeof chunk === "string") strings.push(chunk);
        else buffers.push(chunk.slice());
      }
      if (mode === "bytes") {
        originalBytes = total;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const buffer of buffers) {
          bytes.set(buffer, offset);
          offset += buffer.length;
        }
        text = decode(bytes, source.encoding);
      } else text = strings.join("");
    }
  }
  checkSchemaSignal(options);
  if (text.length > limits.maxCharacters)
    throw new SchemaError("RESOURCE_LIMIT", "Source exceeds maxCharacters.");
  const result: NormalizedSchemaSource = {
    text,
    ...(source.systemId === undefined ? {} : { systemId: source.systemId }),
    sourceKind: source.kind,
    provenance: source.kind === "dom" ? "generated" : "original",
  };
  return recordNormalizedSourceBytes(result, originalBytes);
}
