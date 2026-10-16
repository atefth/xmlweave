import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.*;
import org.xml.sax.SAXException;

/** Line-framed, base64 UTF-8 data only. No filesystem or network schema resolution. */
class XsdReference {
  static String decode(String value) {
    return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
  }
  public static void main(String[] args) throws Exception {
    var factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
    factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line; (line = input.readLine()) != null;) {
      int count = Integer.parseInt(input.readLine());
      Schema schema = null;
      try { schema = factory.newSchema(new StreamSource(new StringReader(decode(line)))); }
      catch (SAXException invalid) { }
      System.out.println(schema == null ? "schema:invalid" : "schema:valid");
      for (int i = 0; i < count; i++) {
        String xml = decode(input.readLine());
        if (schema == null) { System.out.println("instance:unavailable"); continue; }
        try {
          schema.newValidator().validate(new StreamSource(new StringReader(xml)));
          System.out.println("instance:valid");
        } catch (SAXException invalid) { System.out.println("instance:invalid"); }
      }
    }
  }
}
