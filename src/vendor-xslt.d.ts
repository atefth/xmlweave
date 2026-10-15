interface EngineDocument { readonly nodeType: number }
interface EngineOptions {
  cData: boolean;
  escape: boolean;
  selfClosingTags: boolean;
  outputMethod: 'xml' | 'text';
  parameters: { name: string; value: string | number | boolean }[];
  fetchFunction: (uri: string) => Promise<string>;
  documentLoader: (uri: string) => EngineDocument | null;
}
export function loadXslt(): Promise<{
  XmlParser: new () => { xmlParse(xml: string): EngineDocument };
  Xslt: new (options: EngineOptions) => { xsltProcess(xml: EngineDocument, stylesheet: EngineDocument): Promise<string> };
}>;
