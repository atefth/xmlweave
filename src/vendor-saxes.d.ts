/** Local structural description of the pinned saxes 6.0.0 surface used by stream.ts. */
export interface SaxesTagNS {
  name: string;
  local: string;
  prefix: string;
  uri: string;
  ns: Record<string, string>;
  attributes: Record<string, { name: string; local: string; prefix: string; uri: string; value: string }>;
}
interface Handlers {
  error: (error: Error) => void;
  doctype: (doctype: string) => void;
  xmldecl: (declaration: { version?: string; encoding?: string; standalone?: string }) => void;
  opentag: (tag: SaxesTagNS) => void;
  closetag: (tag: SaxesTagNS) => void;
  text: (value: string) => void;
  cdata: (value: string) => void;
  comment: (value: string) => void;
  processinginstruction: (instruction: { target: string; body: string }) => void;
}
export declare class SaxesParser {
  constructor(options: { xmlns: true; defaultXMLVersion: '1.0'; forceXMLVersion: true });
  readonly line: number;
  readonly column: number;
  on<K extends keyof Handlers>(event: K, handler: Handlers[K]): void;
  write(chunk: string): this;
  close(): this;
}
