import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileJavaSchema } from "../dist/schema-java.js";

const xs = "http://www.w3.org/2001/XMLSchema";
const definitions = `<xs:simpleType name="Id"><xs:restriction base="xs:ID"/></xs:simpleType>
  <xs:simpleType name="Choice"><xs:union memberTypes="xs:integer Id"/></xs:simpleType>
  <xs:simpleType name="StringChoice"><xs:union memberTypes="xs:string Id"/></xs:simpleType>
  <xs:complexType name="ComplexChoice"><xs:simpleContent><xs:extension base="Choice"/></xs:simpleContent></xs:complexType>`;

test("Java captures only potential ID text using actual schema type callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmlweave-id-capture-"));
  const exports = "java.xml/com.sun.org.apache.xerces.internal.xs=ALL-UNNAMED";
  try {
    const source = join(directory, "IdCaptureProbe.java");
    await writeFile(source, String.raw`
import java.io.StringReader;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.*;
import org.xml.sax.*;
import org.xml.sax.helpers.DefaultHandler;
class IdCaptureProbe {
  public static void main(String[] args) throws Exception {
    String schema = ${JSON.stringify(`<xs:schema xmlns:xs="${xs}">${definitions}<xs:element name="root"><xs:complexType mixed="true"><xs:sequence><xs:element name="body" type="xs:string"/><xs:element name="number" type="xs:integer"/><xs:element name="tokens" type="xs:NMTOKENS"/><xs:element name="id" type="Id"/><xs:element name="choice" type="Choice"/><xs:element name="textChoice" type="StringChoice"/><xs:element name="complexChoice" type="ComplexChoice"/><xs:element name="typed" type="xs:string"/></xs:sequence><xs:attribute name="ref" type="xs:IDREF" default="known"/></xs:complexType></xs:element></xs:schema>`)};
    ValidatorHandler handler = SchemaFactory.newDefaultInstance().newSchema(new StreamSource(new StringReader(schema))).newValidatorHandler();
    TypeInfoProvider types = handler.getTypeInfoProvider();
    ValidationBridge.DefaultReferences references = new ValidationBridge.DefaultReferences();
    Deque<ValidationBridge.SourceElement> stack = new ArrayDeque<>();
    Set<String> captured = new HashSet<>();
    int[] uncapturedCharacters = {0};
    handler.setContentHandler(new DefaultHandler() {
      public void setDocumentLocator(Locator locator) { ValidationBridge.activeLocator = locator; }
      public void startElement(String uri, String local, String name, Attributes attributes) {
        ValidationBridge.SourceElement element = new ValidationBridge.SourceElement();
        element.type(types.getElementTypeInfo(), references);
        stack.push(element);
        if (element.value != null) captured.add(local);
        for (int i=0; i<attributes.getLength(); i++) references.attribute(types.getAttributeTypeInfo(i), types.isIdAttribute(i), types.isSpecified(i), attributes.getValue(i));
      }
      public void characters(char[] text, int start, int length) {
        ValidationBridge.SourceElement element = stack.peek();
        if (element == null) return;
        if (element.value == null) uncapturedCharacters[0] += length;
        element.characters(text, start, length);
      }
      public void endElement(String uri, String local, String name) {
        ValidationBridge.SourceElement element = stack.pop();
        if (element.value != null) references.element(types.getElementTypeInfo(), element.value.toString());
      }
    });
    SAXParserFactory parser = SAXParserFactory.newInstance();
    parser.setNamespaceAware(true);
    XMLReader reader = parser.newSAXParser().getXMLReader();
    reader.setContentHandler(handler);
    String xml = "<root xmlns:xs='http://www.w3.org/2001/XMLSchema' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'>mixed<body>" + "x".repeat(750000) + "</body><number>42</number><tokens>a b</tokens><id>known</id><choice>unionId</choice><textChoice>notAnId</textChoice><complexChoice>complexId</complexChoice><typed xsi:type='xs:ID'>typedId</typed></root>";
    reader.parse(new InputSource(new StringReader(xml)));
    if (!captured.equals(Set.of("id", "choice", "textChoice", "complexChoice", "typed"))) throw new AssertionError("Unexpected text retention: " + captured);
    if (uncapturedCharacters[0] < 750000) throw new AssertionError("Large ordinary text was retained");
    if (!references.ids.equals(Set.of("known", "unionId", "complexId", "typedId"))) throw new AssertionError("Wrong actual IDs: " + references.ids);
    if (!references.refs.containsKey("known")) throw new AssertionError("Missing schema default reference");
    references.finish(new ValidationBridge.Diagnostics("validate"));
    System.out.println("Actual type callbacks retained only possible ID values.");
  }
}
`);
    execFileSync("javac", ["--add-exports", exports, "-d", directory,
      fileURLToPath(new URL("../dist/java/ValidationBridge.java", import.meta.url)), source],
    { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    const output = execFileSync("java", ["--add-exports", exports, "-cp", directory, "IdCaptureProbe"],
      { encoding: "utf8", timeout: 30000 });
    assert.match(output, /retained only possible ID values/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Java streamed ID unions and xsi:type still resolve schema-default references", async () => {
  const grammar = await compileJavaSchema(`<xs:schema xmlns:xs="${xs}">${definitions}
    <xs:element name="root"><xs:complexType><xs:sequence>
      <xs:element name="choice" type="Choice"/><xs:element name="complexChoice" type="ComplexChoice"/>
      <xs:element name="typed" type="xs:string"/><xs:element name="textChoice" type="StringChoice"/>
    </xs:sequence><xs:attribute name="refs" type="xs:IDREFS" default="unionId complexId typedId"/></xs:complexType></xs:element></xs:schema>`);
  try {
    const chunks = [
      `<root xmlns:xs="${xs}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><choice>union`,
      "Id</choice><complexChoice>complexId</complexChoice>",
      '<typed xsi:type="xs:ID">typedId</typed><textChoice>notAnId</textChoice></root>',
    ];
    let result;
    for await (const event of grammar.validateStream(chunks))
      if (event.kind === "result") result = event.result;
    assert.equal(result.valid, true);
    assert.equal((await grammar.validate(chunks.join("").replace("unionId</choice>", "42</choice>"))).valid, false);
  } finally {
    grammar.dispose();
  }
});
