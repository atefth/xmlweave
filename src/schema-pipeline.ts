import { SchemaError, markNormalizedTransport } from "./validation-types.js";
import { normalizeSourceWithDeadline } from "./source-deadline.js";
import type {
  SchemaSource,
  SchemaOptions,
  SchemaValidationResult,
  SchemaDiagnostic,
} from "./validation-types.js";
import { normalizeSchemaSource, sourceLimits } from "./schema-sources.js";
import { parseXml } from "./index.js";
import type { Document, Element } from "slimdom";

export interface ValidationLocator {
  readonly systemId?: string;
  readonly line?: number;
  readonly column?: number;
}
export interface GeneratedValidationLocator {
  readonly systemId?: string | null;
  readonly line?: number;
  readonly column?: number;
}
export interface ValidationLocation {
  readonly generated: Readonly<ValidationLocator>;
  readonly status:
    | "event"
    | "ambiguous"
    | "missing-locator"
    | "expired"
    | "unmapped"
    | "generated";
  readonly source?: Readonly<ValidationLocator>;
  readonly eventIndex?: number;
  readonly candidates?: readonly {
    readonly eventIndex: number;
    readonly source?: Readonly<ValidationLocator>;
  }[];
  /** Association with a supplied event position, never a fabricated lexical character offset. */
  readonly precision: "event" | "none";
}
export interface LocatedSchemaDiagnostic extends SchemaDiagnostic {
  readonly location?: ValidationLocation;
}
export type PipelineDiagnosticHandler = (
  diagnostic: Readonly<LocatedSchemaDiagnostic>,
) => void | Promise<void>;
export interface NativeDiagnosticOptions extends SchemaOptions {
  diagnosticHandler?: PipelineDiagnosticHandler;
  systemId?: string;
}
export interface ValidationName {
  readonly name: string;
  readonly localName: string;
  readonly namespaceURI: string;
}
export interface ValidationAttribute extends ValidationName {
  readonly value: string;
}
export interface NativeValidationAttribute extends ValidationAttribute {
  readonly type?: unknown;
  readonly psvi?: unknown;
  readonly specified?: boolean;
  readonly namespaceDeclaration?: boolean;
}
export type ValidationInputEvent =
  | {
      readonly kind: "startDocument" | "endDocument";
      readonly locator?: ValidationLocator;
    }
  | {
      readonly kind: "startPrefixMapping";
      readonly prefix: string;
      readonly namespaceURI: string;
      readonly locator?: ValidationLocator;
    }
  | {
      readonly kind: "endPrefixMapping";
      readonly prefix: string;
      readonly locator?: ValidationLocator;
    }
  | ({
      readonly kind: "startElement";
      readonly attributes: readonly ValidationAttribute[];
      readonly locator?: ValidationLocator;
    } & ValidationName)
  | ({
      readonly kind: "endElement";
      readonly locator?: ValidationLocator;
    } & ValidationName)
  | {
      readonly kind: "text";
      readonly text: string;
      readonly locator?: ValidationLocator;
    }
  | {
      readonly kind: "processingInstruction";
      readonly target: string;
      readonly data: string;
      readonly locator?: ValidationLocator;
    };
type NativeValidationEventBody =
  | { readonly kind: "startDocument" | "endDocument" }
  | {
      readonly kind: "startPrefixMapping";
      readonly prefix: string;
      readonly namespaceURI: string;
    }
  | { readonly kind: "endPrefixMapping"; readonly prefix: string }
  | ({
      readonly kind: "startElement";
      readonly attributes: readonly NativeValidationAttribute[];
      readonly type?: unknown;
      readonly psvi?: unknown;
    } & ValidationName)
  | ({
      readonly kind: "endElement";
      readonly type?: unknown;
      readonly psvi?: unknown;
    } & ValidationName)
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "processingInstruction";
      readonly target: string;
      readonly data: string;
    }
  | {
      readonly kind: "diagnostic";
      readonly diagnostic: Readonly<LocatedSchemaDiagnostic>;
    }
  | {
      readonly kind: "result";
      readonly result: SchemaValidationResult & {
        readonly diagnostics: readonly LocatedSchemaDiagnostic[];
      };
    };
export type NativeValidationEvent = NativeValidationEventBody & {
  readonly generatedLocator?: GeneratedValidationLocator | null;
  readonly generatedReason?: string;
  readonly location?: ValidationLocation;
};
export interface NativeSchemaValidator {
  readonly disposed: boolean;
  validate(
    source: SchemaSource,
    options?: NativeDiagnosticOptions,
  ): Promise<SchemaValidationResult>;
  validateStream(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: NativeDiagnosticOptions,
  ): AsyncIterable<NativeValidationEvent>;
  dispose(): void;
}
export interface ValidationLocationMapping {
  readonly eventIndex: number;
  readonly generatedLine: number;
  readonly generatedColumn?: number;
  readonly locator: Readonly<ValidationLocator>;
}
export interface PipelineOptions extends SchemaOptions {
  systemId?: string;
  onDiagnostic?: (diagnostic: Readonly<LocatedSchemaDiagnostic>) => void;
  diagnosticHandler?: PipelineDiagnosticHandler;
  onLocator?: (mapping: ValidationLocationMapping) => void;
  maxLocatorSegments?: number;
  namespacePrefixes?: boolean;
}
interface EventSegment {
  index: number;
  kind: ValidationInputEvent["kind"];
  name?: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  locator?: Readonly<ValidationLocator>;
}
class LocatorWindow {
  private segments: EventSegment[] = [];
  private line = 1;
  private column = 1;
  private evicted = false;
  constructor(
    private readonly capacity: number,
    private readonly systemId?: string,
  ) {}
  append(event: ValidationInputEvent, index: number, text: string) {
    const start = { line: this.line, column: this.column };
    for (const character of text) {
      if (character === "\n") {
        this.line++;
        this.column = 1;
      } else this.column += character.length;
    }
    if (event.kind === "startElement")
      for (let i = this.segments.length - 1; i >= 0; i--) {
        const prior = this.segments[i]!;
        if (prior.kind !== "startPrefixMapping") break;
        prior.end = { line: this.line, column: this.column };
      }
    this.segments.push({
      index,
      kind: event.kind,
      ...("name" in event
        ? { name: event.name }
        : "prefix" in event
          ? { name: event.prefix }
          : {}),
      start,
      end: { line: this.line, column: this.column },
      ...(event.locator
        ? { locator: Object.freeze({ ...event.locator }) }
        : {}),
    });
    if (this.segments.length > this.capacity) {
      this.segments.shift();
      this.evicted = true;
    }
  }
  locate(
    generated: GeneratedValidationLocator,
    kind?: NativeValidationEvent["kind"],
    name?: string,
    reason?: string,
  ): ValidationLocation {
    const coordinates = {
      ...(generated.systemId == null ? {} : { systemId: generated.systemId }),
      ...(generated.line === undefined ? {} : { line: generated.line }),
      ...(generated.column === undefined ? {} : { column: generated.column }),
    };
    const result = (
      status: ValidationLocation["status"],
      extra: Partial<ValidationLocation> = {},
    ): ValidationLocation =>
      Object.freeze({
        generated: Object.freeze(coordinates),
        status,
        precision: "none",
        ...extra,
      });
    if (reason) return result("generated");
    if (!generated.line || !generated.column) return result("unmapped");
    if (
      this.systemId &&
      generated.systemId &&
      generated.systemId !== this.systemId
    )
      return result("unmapped");
    const compare = (point: { line: number; column: number }) =>
      generated.line === point.line
        ? generated.column! - point.column
        : generated.line! - point.line;
    let matches = this.segments.filter(
      (segment) =>
        compare(segment.start) >= 0 &&
        compare(segment.end) <= 0 &&
        (kind !== "diagnostic" ||
          [
            "startElement",
            "endElement",
            "text",
            "processingInstruction",
          ].includes(segment.kind)),
    );
    if (kind && kind !== "diagnostic") {
      const typed = matches.filter(
        (s) => s.kind === kind && (name === undefined || s.name === name),
      );
      if (typed.length) matches = typed;
      else
        return result(
          this.evicted &&
            this.segments.length &&
            compare(this.segments[0]!.start) < 0
            ? "expired"
            : "unmapped",
        );
    }
    if (matches.length === 1) {
      const segment = matches[0]!,
        usable =
          segment.locator?.line !== undefined &&
          segment.locator.column !== undefined;
      return result(usable ? "event" : "missing-locator", {
        eventIndex: segment.index,
        ...(segment.locator ? { source: segment.locator } : {}),
        ...(usable ? { precision: "event" as const } : {}),
      });
    }
    if (matches.length > 1)
      return result("ambiguous", {
        candidates: Object.freeze(
          matches.slice(0, 8).map((segment) =>
            Object.freeze({
              eventIndex: segment.index,
              ...(segment.locator ? { source: segment.locator } : {}),
            }),
          ),
        ),
      });
    return result(
      this.evicted &&
        this.segments.length &&
        compare(this.segments[0]!.start) < 0
        ? "expired"
        : "unmapped",
    );
  }
  diagnostic(
    diagnostic: Readonly<SchemaDiagnostic>,
  ): Readonly<LocatedSchemaDiagnostic> {
    return Object.freeze({
      ...diagnostic,
      provenance: "generated",
      location: this.locate(diagnostic, "diagnostic"),
    });
  }
}
const invalid = (message: string): never => {
  throw new SchemaError("INVALID_ARGUMENT", message);
};
const xmlNS = "http://www.w3.org/XML/1998/namespace",
  xmlnsNS = "http://www.w3.org/2000/xmlns/";
const ncName =
  /^[A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}][A-Z_a-z0-9.\-\u00B7\u0300-\u036F\u203F-\u2040\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u;
function characters(text: string): void {
  if (typeof text !== "string") invalid("XML values must be strings.");
  for (const scalar of text) {
    const n = scalar.codePointAt(0)!;
    if (
      !(
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 32 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      )
    )
      invalid("XML values contain an illegal character.");
  }
}
function escape(text: string, attribute = false): string {
  characters(text);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, attribute ? "&quot;" : '"')
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, attribute ? "&#10;" : "\n")
    .replace(/\t/g, attribute ? "&#9;" : "\t");
}
function qName(
  name: ValidationName,
  bindings: Map<string, string>,
  attribute = false,
): void {
  if (
    !name ||
    typeof name.name !== "string" ||
    typeof name.localName !== "string" ||
    typeof name.namespaceURI !== "string"
  )
    invalid("Names require name, localName and namespaceURI strings.");
  const parts = name.name.split(":");
  if (
    parts.length > 2 ||
    parts.some((p) => !ncName.test(p)) ||
    parts.at(-1) !== name.localName
  )
    invalid("Malformed or inconsistent qualified name.");
  const prefix = parts.length === 2 ? parts[0]! : "";
  if (
    prefix === "xmlns" ||
    name.name === "xmlns" ||
    name.namespaceURI === xmlnsNS
  )
    invalid("Namespace declarations must use prefix-mapping events.");
  const expected = prefix
    ? bindings.get(prefix)
    : attribute
      ? ""
      : (bindings.get("") ?? "");
  if (expected !== name.namespaceURI)
    invalid("Qualified name does not match the active namespace binding.");
}
function pipelineOptions(options: PipelineOptions): NativeDiagnosticOptions {
  sourceLimits(options);
  for (const key of Object.keys(options))
    if (
      ![
        "signal",
        "maxBytes",
        "maxCharacters",
        "maxDiagnostics",
        "onDiagnostic",
        "diagnosticHandler",
        "errorPolicy",
        "systemId",
        "onLocator",
        "maxLocatorSegments",
        "namespacePrefixes",
      ].includes(key)
    )
      invalid(`Unsupported pipeline option: ${key}.`);
  if (
    options.maxLocatorSegments !== undefined &&
    (!Number.isSafeInteger(options.maxLocatorSegments) ||
      options.maxLocatorSegments < 1 ||
      options.maxLocatorSegments > 8192)
  )
    invalid("maxLocatorSegments must be between 1 and 8192.");
  if (
    options.namespacePrefixes !== undefined &&
    typeof options.namespacePrefixes !== "boolean"
  )
    invalid("namespacePrefixes must be boolean.");
  if (
    options.maxDiagnostics !== undefined &&
    (!Number.isSafeInteger(options.maxDiagnostics) ||
      options.maxDiagnostics < 1 ||
      options.maxDiagnostics > 10000)
  )
    invalid("Invalid diagnostic budget.");
  if (
    options.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== "function"
  )
    invalid("onDiagnostic must be a function.");
  if (
    options.errorPolicy !== undefined &&
    !["result", "throw"].includes(options.errorPolicy)
  )
    invalid("Unsupported error policy.");
  if (
    options.diagnosticHandler !== undefined &&
    typeof options.diagnosticHandler !== "function"
  )
    invalid("diagnosticHandler must be a function.");
  if (
    options.onLocator !== undefined &&
    typeof options.onLocator !== "function"
  )
    invalid("onLocator must be a function.");
  if (options.systemId !== undefined && typeof options.systemId !== "string")
    invalid("systemId must be a string.");
  const {
    onLocator: _locator,
    maxLocatorSegments: _segments,
    namespacePrefixes: _prefixes,
    ...native
  } = options;
  return native;
}
/** Incremental XML serialization of namespace-aware input events, not native SAX injection. */
async function* serializeEvents(
  events: AsyncIterable<ValidationInputEvent> | Iterable<ValidationInputEvent>,
  options: PipelineOptions = {},
  window?: LocatorWindow,
): AsyncIterable<string> {
  pipelineOptions(options);
  if (
    !events ||
    (typeof (events as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
      "function" &&
      typeof (events as Iterable<unknown>)[Symbol.iterator] !== "function")
  )
    invalid("Input events must be iterable.");
  const limits = sourceLimits(options);
  let state: "new" | "document" | "ended" = "new",
    root = false,
    index = 0,
    line = 1,
    column = 1,
    length = 0;
  let bindings = new Map<string, string>([["xml", xmlNS]]);
  let pending = new Map<string, string>();
  let ending = new Set<string>();
  const stack: {
    name: ValidationName;
    prior: Map<string, string>;
    prefixes: string[];
  }[] = [];
  for await (const event of events) {
    if (options.signal?.aborted)
      throw new SchemaError("ABORTED", "Validation pipeline was aborted.");
    if (!event || typeof event !== "object" || typeof event.kind !== "string")
      invalid("Expected a validation event.");
    if (event.locator) {
      const l = event.locator;
      if (
        (l.line !== undefined &&
          (!Number.isSafeInteger(l.line) || l.line < 1)) ||
        (l.column !== undefined &&
          (!Number.isSafeInteger(l.column) || l.column < 1)) ||
        (l.systemId !== undefined && typeof l.systemId !== "string")
      )
        invalid("Invalid event locator.");
      options.onLocator?.(
        Object.freeze({
          eventIndex: index,
          generatedLine: line,
          generatedColumn: column,
          locator: Object.freeze({ ...l }),
        }),
      );
    }
    index++;
    let text = "";
    if (ending.size && event.kind !== "endPrefixMapping")
      invalid("End-prefix mappings must follow their end element.");
    if (event.kind === "startDocument") {
      if (state !== "new") invalid("startDocument must occur exactly once.");
      state = "document";
    } else if (state !== "document")
      invalid("Events must occur inside a document.");
    else if (event.kind === "startPrefixMapping") {
      characters(event.namespaceURI);
      if (
        typeof event.prefix !== "string" ||
        (event.prefix !== "" && !ncName.test(event.prefix))
      )
        invalid("Invalid namespace prefix.");
      if (
        event.prefix === "xmlns" ||
        event.namespaceURI === xmlnsNS ||
        (event.prefix === "xml") !== (event.namespaceURI === xmlNS) ||
        (event.prefix !== "" && event.namespaceURI === "")
      )
        invalid("Reserved or empty namespace binding.");
      if (pending.has(event.prefix))
        invalid("Duplicate prefix mapping before an element.");
      pending.set(event.prefix, event.namespaceURI);
    } else if (event.kind === "endPrefixMapping") {
      if (!ending.delete(event.prefix))
        invalid("Unexpected end-prefix mapping.");
    } else if (event.kind === "startElement") {
      if (!stack.length && root)
        invalid("Only one document element is allowed.");
      const prior = bindings;
      bindings = new Map(bindings);
      for (const [p, u] of pending) bindings.set(p, u);
      qName(event, bindings);
      if (!Array.isArray(event.attributes))
        invalid("Element attributes must be an array.");
      const seen = new Set<string>();
      let attrs = "";
      for (const attr of event.attributes) {
        qName(attr, bindings, true);
        const key = attr.namespaceURI + "\u0000" + attr.localName;
        if (seen.has(key)) invalid("Duplicate expanded attribute name.");
        seen.add(key);
        attrs += ` ${attr.name}="${escape(attr.value, true)}"`;
      }
      text = `<${event.name}${[...pending].map(([p, u]) => ` xmlns${p ? ":" + p : ""}="${escape(u, true)}"`).join("")}${attrs}>`;
      stack.push({
        name: {
          name: event.name,
          localName: event.localName,
          namespaceURI: event.namespaceURI,
        },
        prior,
        prefixes: [...pending.keys()],
      });
      pending = new Map();
      root = true;
      if (stack.length > 256)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Event element depth exceeds 256.",
        );
    } else if (event.kind === "endElement") {
      if (pending.size) invalid("Prefix mapping must precede a start element.");
      const frame = stack.pop();
      if (
        !frame ||
        frame.name.name !== event.name ||
        frame.name.localName !== event.localName ||
        frame.name.namespaceURI !== event.namespaceURI
      )
        invalid("End element does not match the open element.");
      text = `</${event.name}>`;
      bindings = frame!.prior;
      ending = new Set(frame!.prefixes);
    } else if (event.kind === "text") {
      if (pending.size) invalid("Prefix mapping must precede a start element.");
      characters(event.text);
      if (!stack.length && /[^\t\n\r ]/.test(event.text))
        invalid("Non-whitespace text outside the root element.");
      text = stack.length
        ? escape(event.text)
        : event.text.replace(/\r\n?/g, "\n");
    } else if (event.kind === "processingInstruction") {
      if (pending.size) invalid("Prefix mapping must precede a start element.");
      if (
        !ncName.test(event.target) ||
        event.target.toLowerCase() === "xml" ||
        event.data.includes("?>")
      )
        invalid("Invalid processing instruction.");
      characters(event.data);
      text = `<?${event.target} ${event.data}?>`;
    } else if (event.kind === "endDocument") {
      if (!root || stack.length || pending.size || ending.size)
        invalid(
          "Document must contain a complete root and balanced namespace mappings.",
        );
      state = "ended";
    } else invalid("Unsupported validation event.");
    length += text.length;
    if (length > limits.maxCharacters)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Generated XML exceeds maxCharacters.",
      );
    window?.append(event, index - 1, text);
    for (const character of text) {
      if (character === "\n") {
        line++;
        column = 1;
      } else column += character.length;
    }
    if (text) yield text;
  }
  if (state !== "ended") invalid("Input ended without endDocument.");
}
export function serializeValidationEvents(
  events: AsyncIterable<ValidationInputEvent> | Iterable<ValidationInputEvent>,
  options: PipelineOptions = {},
): AsyncIterable<string> {
  return serializeEvents(events, options);
}
export async function* validateEventStream(
  provider: NativeSchemaValidator,
  events: AsyncIterable<ValidationInputEvent> | Iterable<ValidationInputEvent>,
  options: PipelineOptions = {},
): AsyncIterable<NativeValidationEvent> {
  const native = pipelineOptions(options),
    window = new LocatorWindow(
      options.maxLocatorSegments ?? 1024,
      options.systemId,
    );
  const mapped = new WeakMap<object, Readonly<LocatedSchemaDiagnostic>>();
  let prefixMappings: { prefix: string; namespaceURI: string }[] = [];
  if (native.onDiagnostic) {
    const observer = native.onDiagnostic;
    native.onDiagnostic = (d) => {
      const located = mapped.get(d) ?? window.diagnostic(d);
      mapped.set(d, located);
      observer(located);
    };
  }
  if (native.diagnosticHandler) {
    const handler = native.diagnosticHandler;
    native.diagnosticHandler = (d) => {
      const located = mapped.get(d) ?? window.diagnostic(d);
      mapped.set(d, located);
      return handler(located);
    };
  }
  for await (const event of provider.validateStream(
    serializeEvents(events, options, window),
    native,
  )) {
    if (event.kind === "startPrefixMapping")
      prefixMappings.push({
        prefix: event.prefix,
        namespaceURI: event.namespaceURI,
      });
    if (event.kind === "diagnostic") {
      const diagnostic =
        mapped.get(event.diagnostic) ?? window.diagnostic(event.diagnostic);
      mapped.set(event.diagnostic, diagnostic);
      yield Object.freeze({
        ...event,
        diagnostic,
        location: diagnostic.location,
      });
    } else if (event.kind === "result")
      yield Object.freeze({
        ...event,
        result: Object.freeze({
          ...event.result,
          diagnostics: event.result.diagnostics.map(
            (d) => mapped.get(d) ?? window.diagnostic(d),
          ),
        }),
      });
    else if (event.kind === "startElement") {
      const attributes = event.attributes.filter(
        (attribute) => attribute.namespaceURI !== xmlnsNS,
      );
      if (options.namespacePrefixes)
        for (const mapping of prefixMappings)
          attributes.push(
            Object.freeze({
              name: mapping.prefix ? "xmlns:" + mapping.prefix : "xmlns",
              localName: mapping.prefix || "xmlns",
              namespaceURI: xmlnsNS,
              value: mapping.namespaceURI,
              namespaceDeclaration: true,
              specified: true,
              type: null,
              psvi: null,
            }),
          );
      prefixMappings = [];
      yield Object.freeze({
        ...event,
        attributes: Object.freeze(attributes),
        location: window.locate(
          event.generatedLocator ?? {},
          event.kind,
          event.name,
          event.generatedReason,
        ),
      });
    } else
      yield Object.freeze({
        ...event,
        location: window.locate(
          event.generatedLocator ?? {},
          event.kind,
          "name" in event
            ? event.name
            : "prefix" in event
              ? event.prefix
              : undefined,
          event.generatedReason,
        ),
      });
  }
}
function queue<T>(capacity: number) {
  let values: T[] = [];
  let ended = false,
    failure: unknown,
    reader: ((value: IteratorResult<T>) => void) | undefined,
    rejectReader: ((e: unknown) => void) | undefined;
  const writers: {
    value: T;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  const promote = () => {
    const writer = writers.shift();
    if (writer) {
      values.push(writer.value);
      writer.resolve();
    }
  };
  return {
    async push(value: T) {
      if (ended)
        throw failure ?? new SchemaError("DISPOSED", "Queue is closed.");
      if (reader) {
        const receive = reader;
        reader = undefined;
        rejectReader = undefined;
        receive({ done: false, value });
        return;
      }
      if (values.length < capacity) {
        values.push(value);
        return;
      }
      if (writers.length >= capacity)
        throw new SchemaError(
          "RESOURCE_LIMIT",
          "Too many concurrent queue writers.",
        );
      await new Promise<void>((resolve, reject) =>
        writers.push({ value, resolve, reject }),
      );
    },
    close(error?: unknown) {
      ended = true;
      failure = error;
      for (const w of writers.splice(0))
        w.reject(error ?? new SchemaError("DISPOSED", "Queue is closed."));
      if (reader) {
        if (error) rejectReader?.(error);
        else reader({ done: true, value: undefined });
        reader = undefined;
        rejectReader = undefined;
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (values.length) {
            const value = values.shift()!;
            promote();
            return { done: false, value };
          }
          if (ended) {
            if (failure) throw failure;
            return { done: true, value: undefined };
          }
          return new Promise((resolve, reject) => {
            reader = resolve;
            rejectReader = reject;
          });
        },
        async return() {
          ended = true;
          values = [];
          for (const w of writers.splice(0))
            w.reject(new SchemaError("ABORTED", "Queue consumer stopped."));
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}
export interface ValidationHandler {
  write(event: ValidationInputEvent): Promise<void>;
  end(): Promise<SchemaValidationResult>;
  abort(reason?: unknown): void;
  startDocument(locator?: ValidationLocator): Promise<void>;
  endDocument(locator?: ValidationLocator): Promise<SchemaValidationResult>;
  startPrefixMapping(
    prefix: string,
    namespaceURI: string,
    locator?: ValidationLocator,
  ): Promise<void>;
  endPrefixMapping(prefix: string, locator?: ValidationLocator): Promise<void>;
  startElement(
    name: ValidationName,
    attributes?: readonly ValidationAttribute[],
    locator?: ValidationLocator,
  ): Promise<void>;
  endElement(name: ValidationName, locator?: ValidationLocator): Promise<void>;
  characters(text: string, locator?: ValidationLocator): Promise<void>;
  processingInstruction(
    target: string,
    data: string,
    locator?: ValidationLocator,
  ): Promise<void>;
  readonly events: AsyncIterable<NativeValidationEvent>;
  readonly completion: Promise<SchemaValidationResult>;
}
export function createValidationHandler(
  provider: NativeSchemaValidator,
  options: PipelineOptions & {
    maxQueuedEvents?: number;
    output?: "none" | "events";
  } = {},
): ValidationHandler {
  const { maxQueuedEvents = 16, output = "none", ...settings } = options;
  if (
    !Number.isSafeInteger(maxQueuedEvents) ||
    maxQueuedEvents < 1 ||
    maxQueuedEvents > 256
  )
    invalid("maxQueuedEvents must be between 1 and 256.");
  if (!["none", "events"].includes(output))
    invalid("Unsupported handler output.");
  pipelineOptions(settings);
  const input = queue<ValidationInputEvent>(maxQueuedEvents),
    out = queue<NativeValidationEvent>(maxQueuedEvents);
  let stopped = false;
  let queuedCharacters = 0;
  const abort = (
    reason: unknown = new SchemaError(
      "ABORTED",
      "Validation handler was aborted.",
    ),
  ) => {
    if (stopped) return;
    stopped = true;
    input.close(reason);
    out.close(reason);
    provider.dispose();
  };
  const completion = (async () => {
    let result: SchemaValidationResult | undefined;
    try {
      for await (const event of validateEventStream(
        provider,
        input,
        settings,
      )) {
        if (event.kind === "result") result = event.result;
        if (output === "events") await out.push(event);
      }
      if (!result)
        throw new SchemaError(
          "ENGINE_ERROR",
          "Provider ended without a validation result.",
        );
      stopped = true;
      out.close();
      return result;
    } catch (error) {
      abort(error);
      throw error;
    }
  })();
  completion.catch(() => {});
  const events: AsyncIterable<NativeValidationEvent> = {
    [Symbol.asyncIterator]() {
      const iterator = out[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        async return() {
          abort();
          await iterator.return();
          return { done: true, value: undefined };
        },
      };
    },
  };
  const handler: ValidationHandler = {
    events,
    completion,
    async write(event) {
      if (stopped)
        throw new SchemaError("DISPOSED", "Validation handler is closed.");
      try {
        const snapshot = JSON.parse(
          JSON.stringify(event),
        ) as ValidationInputEvent;
        queuedCharacters += JSON.stringify(snapshot).length;
        if (queuedCharacters > sourceLimits(settings).maxCharacters * 8)
          throw new SchemaError(
            "RESOURCE_LIMIT",
            "Event input metadata exceeds its bounded budget.",
          );
        await input.push(snapshot);
      } catch (error) {
        abort(error);
        throw error;
      }
    },
    end() {
      input.close();
      return completion;
    },
    abort,
    startDocument: (locator) =>
      handler.write({ kind: "startDocument", locator }),
    endDocument: async (locator) => {
      await handler.write({ kind: "endDocument", locator });
      return handler.end();
    },
    startPrefixMapping: (prefix, namespaceURI, locator) =>
      handler.write({
        kind: "startPrefixMapping",
        prefix,
        namespaceURI,
        locator,
      }),
    endPrefixMapping: (prefix, locator) =>
      handler.write({ kind: "endPrefixMapping", prefix, locator }),
    startElement: (name, attributes = [], locator) =>
      handler.write({ kind: "startElement", ...name, attributes, locator }),
    endElement: (name, locator) =>
      handler.write({ kind: "endElement", ...name, locator }),
    characters: (text, locator) =>
      handler.write({ kind: "text", text, locator }),
    processingInstruction: (target, data, locator) =>
      handler.write({ kind: "processingInstruction", target, data, locator }),
  };
  return handler;
}
export type ValidationPipelineSource =
  | { family: "stream"; source: SchemaSource }
  | { family: "dom"; node: Document | Element; systemId?: string }
  | {
      family: "sax" | "stax";
      events:
        | AsyncIterable<ValidationInputEvent>
        | Iterable<ValidationInputEvent>;
    };
export type ValidationResultFamily =
  | "none"
  | "text"
  | "bytes"
  | "dom"
  | "events";
export interface ValidationPipelineResult {
  result: SchemaValidationResult;
  text?: string;
  bytes?: Uint8Array;
  document?: Document;
}
export interface ValidationEventPipeline {
  events: AsyncIterable<NativeValidationEvent>;
  completion: Promise<SchemaValidationResult>;
}
/** Matching family adapter. Event output remains asynchronous and provisional. */
export function validateSource(
  provider: NativeSchemaValidator,
  input: ValidationPipelineSource,
  resultFamily: "events",
  options?: PipelineOptions,
): Promise<ValidationEventPipeline>;
export function validateSource(
  provider: NativeSchemaValidator,
  input: ValidationPipelineSource,
  resultFamily?: Exclude<ValidationResultFamily, "events">,
  options?: PipelineOptions,
): Promise<ValidationPipelineResult>;
export async function validateSource(
  provider: NativeSchemaValidator,
  input: ValidationPipelineSource,
  resultFamily: ValidationResultFamily = "none",
  options: PipelineOptions = {},
): Promise<ValidationPipelineResult | ValidationEventPipeline> {
  if (!input || !["stream", "dom", "sax", "stax"].includes(input.family))
    invalid("Unsupported source family.");
  if (
    input.family === "stream" &&
    typeof input.source === "object" &&
    input.source?.kind === "dom"
  )
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "DOM sources require the DOM source family.",
    );
  const allowed =
    input.family === "stream"
      ? ["none", "text", "bytes"]
      : input.family === "dom"
        ? ["none", "dom"]
        : ["none", "events"];
  if (!allowed.includes(resultFamily))
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Source and result families do not match.",
    );
  if (resultFamily === "events") {
    let resolve!: (result: SchemaValidationResult) => void,
      reject!: (reason: unknown) => void;
    const completion = new Promise<SchemaValidationResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {});
    const source = (
      input as {
        events:
          | AsyncIterable<ValidationInputEvent>
          | Iterable<ValidationInputEvent>;
      }
    ).events;
    const events: AsyncIterable<NativeValidationEvent> = {
      async *[Symbol.asyncIterator]() {
        let complete = false;
        try {
          for await (const event of validateEventStream(
            provider,
            source,
            options,
          )) {
            if (event.kind === "result") {
              complete = true;
              resolve(event.result);
            }
            yield event;
          }
          if (!complete)
            throw new SchemaError(
              "ENGINE_ERROR",
              "Provider ended without a result.",
            );
        } catch (error) {
          reject(error);
          throw error;
        } finally {
          if (!complete)
            reject(
              new SchemaError(
                "ABORTED",
                "Event consumer stopped before completion.",
              ),
            );
        }
      },
    };
    return { events, completion };
  }
  const normalized =
    input.family === "stream"
      ? await normalizeSourceWithDeadline(
          input.source,
          options,
          () => provider.disposed,
        )
      : input.family === "dom"
        ? await normalizeSourceWithDeadline(
            { kind: "dom", node: input.node, systemId: input.systemId },
            options,
            () => provider.disposed,
          )
        : undefined;
  const nativeOptions = pipelineOptions(options);
  const metadata = (
    diagnostic: Readonly<SchemaDiagnostic>,
  ): Readonly<SchemaDiagnostic> =>
    Object.freeze({
      ...diagnostic,
      ...(normalized
        ? {
            systemId: diagnostic.systemId ?? normalized.systemId,
            sourceKind: normalized.sourceKind,
            provenance: normalized.provenance,
          }
        : { provenance: "generated" as const }),
    });
  if (normalized && nativeOptions.onDiagnostic) {
    const observer = nativeOptions.onDiagnostic;
    nativeOptions.onDiagnostic = (d) => observer(metadata(d));
  }
  if (normalized && nativeOptions.diagnosticHandler) {
    const handler = nativeOptions.diagnosticHandler;
    nativeOptions.diagnosticHandler = (d) => handler(metadata(d));
  }
  const upstream = normalized
    ? provider.validateStream(
        markNormalizedTransport([normalized.text], normalized),
        {
          ...nativeOptions,
          systemId: normalized.systemId,
        },
      )
    : validateEventStream(
        provider,
        (input as { events: AsyncIterable<ValidationInputEvent> }).events,
        options,
      );
  const events: AsyncIterable<NativeValidationEvent> = {
    async *[Symbol.asyncIterator]() {
      for await (const event of upstream) {
        if (event.kind === "diagnostic")
          yield { ...event, diagnostic: metadata(event.diagnostic) };
        else if (event.kind === "result")
          yield {
            ...event,
            result: {
              ...event.result,
              diagnostics: event.result.diagnostics.map(metadata),
            },
          };
        else yield event;
      }
    },
  };
  let result: SchemaValidationResult | undefined,
    text = "",
    pending: { prefix: string; namespaceURI: string }[] = [];
  const elements: {
    contentOffset: number;
    hasChild: boolean;
    hasPI: boolean;
    outputName: string;
    bindings: Map<string, string>;
  }[] = [];
  let generatedPrefix = 0;
  for await (const event of events) {
    if (event.kind === "result") result = event.result;
    if (resultFamily === "none") continue;
    if (event.kind === "startPrefixMapping") pending.push(event);
    else if (event.kind === "startElement") {
      if (elements.length) elements[elements.length - 1]!.hasChild = true;
      const bindings = new Map(elements.at(-1)?.bindings ?? [["xml", xmlNS]]),
        declarations = new Map(
          pending.map((mapping) => [mapping.prefix, mapping.namespaceURI]),
        );
      for (const [prefix, uri] of declarations) bindings.set(prefix, uri);
      const declare = (prefix: string, uri: string) => {
        bindings.set(prefix, uri);
        declarations.set(prefix, uri);
      };
      const outputName = (name: ValidationName, attribute = false): string => {
        if (!name.namespaceURI) {
          if (!attribute && bindings.get("")) declare("", "");
          return name.localName;
        }
        if (name.namespaceURI === xmlNS) return "xml:" + name.localName;
        const lexicalPrefix = name.name.includes(":")
          ? name.name.split(":")[0]!
          : "";
        if (lexicalPrefix && bindings.get(lexicalPrefix) === name.namespaceURI)
          return name.name;
        if (
          !attribute &&
          !lexicalPrefix &&
          bindings.get("") === name.namespaceURI
        )
          return name.localName;
        let prefix = [...bindings].find(
          ([candidate, uri]) => candidate !== "" && uri === name.namespaceURI,
        )?.[0];
        if (!prefix) {
          do {
            prefix = "ns" + generatedPrefix++;
          } while (bindings.has(prefix));
          declare(prefix, name.namespaceURI);
        }
        return prefix + ":" + name.localName;
      };
      const chosen = outputName(event),
        attributes = event.attributes
          .filter((attribute) => attribute.namespaceURI !== xmlnsNS)
          .map(
            (attribute) =>
              ` ${outputName(attribute, true)}="${escape(attribute.value, true)}"`,
          )
          .join("");
      text += `<${chosen}${[...declarations].map(([prefix, uri]) => ` xmlns${prefix ? ":" + prefix : ""}="${escape(uri, true)}"`).join("")}${attributes}>`;
      pending = [];
      elements.push({
        contentOffset: text.length,
        hasChild: false,
        hasPI: false,
        outputName: chosen,
        bindings,
      });
    } else if (event.kind === "endElement") {
      const element = elements.pop(),
        psvi = event.psvi as { normalizedValue?: unknown } | null | undefined;
      if (
        element &&
        !element.hasChild &&
        !element.hasPI &&
        typeof psvi?.normalizedValue === "string"
      )
        text =
          text.slice(0, element.contentOffset) + escape(psvi.normalizedValue);
      text += `</${element?.outputName ?? event.name}>`;
    } else if (event.kind === "text") text += escape(event.text);
    else if (event.kind === "processingInstruction") {
      if (elements.length) elements[elements.length - 1]!.hasPI = true;
      text += `<?${event.target} ${event.data}?>`;
    }
    if (text.length > sourceLimits(options).maxCharacters)
      throw new SchemaError(
        "RESOURCE_LIMIT",
        "Validated output exceeds maxCharacters.",
      );
  }
  if (!result)
    throw new SchemaError(
      "ENGINE_ERROR",
      "Provider ended without a validation result.",
    );
  if (!result.valid || resultFamily === "none") return { result };
  if (resultFamily === "dom") return { result, document: parseXml(text) };
  if (resultFamily === "text") return { result, text };
  const Encoder = (
    globalThis as unknown as {
      TextEncoder: new () => { encode(text: string): Uint8Array };
    }
  ).TextEncoder;
  if (!Encoder)
    throw new SchemaError(
      "UNSUPPORTED_CAPABILITY",
      "Byte output requires TextEncoder.",
    );
  const bytes = new Encoder().encode(text);
  if (bytes.length > sourceLimits(options).maxBytes)
    throw new SchemaError("RESOURCE_LIMIT", "Validated bytes exceed maxBytes.");
  return { result, bytes };
}
