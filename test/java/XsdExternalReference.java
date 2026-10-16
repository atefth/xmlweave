import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.*;
import org.w3c.dom.ls.LSInput;
import org.xml.sax.SAXException;

/** Raw public JAXP reference, separate from XMLWeave's optional provider bridge. */
class XsdExternalReference {
  static final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
  static String decoded() throws IOException {
    return new String(Base64.getDecoder().decode(input.readLine()), StandardCharsets.UTF_8);
  }
  static StreamSource source(String id, String text) {
    StreamSource source = new StreamSource(new StringReader(text));
    source.setSystemId(id);
    return source;
  }
  static class Resource implements LSInput {
    String text, id;
    Resource(String text, String id) { this.text = text; this.id = id; }
    public Reader getCharacterStream() { return new StringReader(text); }
    public void setCharacterStream(Reader value) { }
    public InputStream getByteStream() { return null; }
    public void setByteStream(InputStream value) { }
    public String getStringData() { return text; }
    public void setStringData(String value) { text = value; }
    public String getSystemId() { return id; }
    public void setSystemId(String value) { id = value; }
    public String getPublicId() { return null; }
    public void setPublicId(String value) { }
    public String getBaseURI() { return id; }
    public void setBaseURI(String value) { }
    public String getEncoding() { return "UTF-8"; }
    public void setEncoding(String value) { }
    public boolean getCertifiedText() { return false; }
    public void setCertifiedText(boolean value) { }
  }
  public static void main(String[] args) throws Exception {
    for (String line; (line = input.readLine()) != null;) {
      int roots = Integer.parseInt(line), resources = Integer.parseInt(input.readLine()), instances = Integer.parseInt(input.readLine());
      StreamSource[] sources = new StreamSource[roots];
      for (int i = 0; i < roots; i++) sources[i] = source(decoded(), decoded());
      Map<String,String> catalogue = new HashMap<>();
      for (int i = 0; i < resources; i++) catalogue.put(decoded(), decoded());
      var factory = SchemaFactory.newDefaultInstance();
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
      factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
      factory.setResourceResolver((type, ns, publicId, systemId, base) -> {
        String id = base == null ? systemId : URI.create(base).resolve(systemId).toString();
        String text = catalogue.get(id);
        if (text == null) throw new IllegalArgumentException("Unapproved resource: " + id);
        return new Resource(text, id);
      });
      Schema schema = null;
      try { schema = factory.newSchema(sources); } catch (SAXException invalid) { }
      System.out.println(schema == null ? "schema:invalid" : "schema:valid");
      for (int i = 0; i < instances; i++) {
        StreamSource instance = source(decoded(), decoded());
        if (schema == null) { System.out.println("instance:unavailable"); continue; }
        try {
          var validator = schema.newValidator();
          validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
          validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
          validator.validate(instance);
          System.out.println("instance:valid");
        } catch (SAXException invalid) { System.out.println("instance:invalid"); }
      }
    }
  }
}
