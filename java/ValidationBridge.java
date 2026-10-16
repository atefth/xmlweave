import java.io.*;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.Source;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.*;
import org.xml.sax.*;
import org.xml.sax.helpers.DefaultHandler;
import org.xml.sax.helpers.XMLFilterImpl;
import org.w3c.dom.TypeInfo;
import org.w3c.dom.ls.*;
// Explicit OpenJDK Xerces XS binding. Launch grants this package only;
// no private fields or reflective access are used.
import com.sun.org.apache.xerces.internal.xs.*;

/** Fixed protocol bridge. Application data is exclusively read from stdin. */
public class ValidationBridge {
 static DataInputStream in = new DataInputStream(System.in);
 static PrintWriter out = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
 static final int LIMIT=16*1024*1024;
 static String frame() throws IOException { int n=in.readInt(); if(n<0||n>LIMIT)throw new IOException("Frame limit"); return new String(in.readNBytes(n),StandardCharsets.UTF_8); }
 static String q(String s){if(s==null)return "null";StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){switch(c){case '\\':b.append("\\\\");break;case '"':b.append("\\\"");break;case '\n':b.append("\\n");break;case '\r':b.append("\\r");break;case '\t':b.append("\\t");break;default:if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}return b.append('"').toString();}
 static Locator activeLocator;
 static void emit(String s){if(activeLocator!=null&&!s.startsWith("{\"kind\":\"diagnostic\"")&&!s.startsWith("{\"kind\":\"failure\"")&&!s.startsWith("{\"kind\":\"ready\"")&&!s.startsWith("{\"kind\":\"result\"")&&!s.startsWith("{\"kind\":\"needChunk\"")&&!s.startsWith("{\"kind\":\"queryTypeResult\""))s=s.substring(0,s.length()-1)+",\"generatedLocator\":{\"systemId\":"+q(activeLocator.getSystemId())+",\"line\":"+activeLocator.getLineNumber()+",\"column\":"+activeLocator.getColumnNumber()+"}}";out.println(s);if(out.checkError())throw new RuntimeException("Output closed");}
 static String schemaNamespace(String text) throws Exception {
  final String[] namespace={null};
  SAXParserFactory parser=SAXParserFactory.newInstance();parser.setNamespaceAware(true);
  parser.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING,true);
  parser.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
  XMLReader reader=parser.newSAXParser().getXMLReader();
  reader.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD,"");reader.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
  reader.setEntityResolver((pub,sys)->{throw new SAXException("External entities forbidden");});
  reader.setContentHandler(new DefaultHandler(){public void startElement(String uri,String local,String name,Attributes attrs){if(namespace[0]==null)namespace[0]=attrs.getValue("targetNamespace")==null?"":attrs.getValue("targetNamespace");}});
  reader.parse(new InputSource(new StringReader(text)));return namespace[0]==null?"":namespace[0];
 }
 static List<String[]> queries=new ArrayList<>();
 static String schemaIdentity;
 static Map<XSTypeDefinition,String>anonymousNames=new IdentityHashMap<>();
 static Map<String,XSTypeDefinition>typeIdentities=new HashMap<>();
 static String typeName(XSTypeDefinition type){if(!type.getAnonymous())return type.getName();return anonymousNames.computeIfAbsent(type,key->"anonymous-"+(anonymousNames.size()+1));}
 static String typeNamespace(XSTypeDefinition type){return type.getAnonymous()?schemaIdentity:type.getNamespace()==null?"":type.getNamespace();}
 static class UnsupportedProvider extends RuntimeException {UnsupportedProvider(){super("The installed Java provider does not expose the supported OpenJDK Xerces XS binding.");}}
 static Set<XSTypeDefinition> visited(){return Collections.newSetFromMap(new IdentityHashMap<XSTypeDefinition,Boolean>());}
 static boolean target(XSTypeDefinition type,String ns,String name){return type!=null&&Objects.equals(name,typeName(type))&&Objects.equals(ns,typeNamespace(type));}
 static boolean anyType(String ns,String name){return ns.equals(XMLConstants.W3C_XML_SCHEMA_NS_URI)&&name.equals("anyType");}
 static boolean restriction(XSTypeDefinition type,String ns,String name){
  if(type!=null&&type.getTypeCategory()==XSTypeDefinition.SIMPLE_TYPE&&anyType(ns,name))return true;
  Set<XSTypeDefinition>seen=visited();while(type!=null&&seen.add(type)){if(target(type,ns,name))return true;if(type.getTypeCategory()==XSTypeDefinition.COMPLEX_TYPE&&((XSComplexTypeDefinition)type).getDerivationMethod()!=XSConstants.DERIVATION_RESTRICTION)return false;type=type.getBaseType();}return false;
 }
 static boolean extension(XSTypeDefinition type,String ns,String name){boolean extended=false;Set<XSTypeDefinition>seen=visited();while(type!=null&&seen.add(type)){if(target(type,ns,name))return extended;if(type.getTypeCategory()==XSTypeDefinition.SIMPLE_TYPE&&anyType(ns,name))return extended;if(type.getTypeCategory()==XSTypeDefinition.COMPLEX_TYPE&&((XSComplexTypeDefinition)type).getDerivationMethod()==XSConstants.DERIVATION_EXTENSION)extended=true;type=type.getBaseType();}return false;}
 static boolean anyDerivation(XSTypeDefinition type,String ns,String name,Set<XSTypeDefinition>seen){if(type==null||!seen.add(type))return false;if(target(type,ns,name)||anyType(ns,name))return true;if(anyDerivation(type.getBaseType(),ns,name,seen))return true;if(type.getTypeCategory()==XSTypeDefinition.SIMPLE_TYPE){XSSimpleTypeDefinition simple=(XSSimpleTypeDefinition)type;if(simple.getVariety()==XSSimpleTypeDefinition.VARIETY_LIST&&anyDerivation(simple.getItemType(),ns,name,seen))return true;if(simple.getVariety()==XSSimpleTypeDefinition.VARIETY_UNION){XSObjectList members=simple.getMemberTypes();for(int i=0;i<members.getLength();i++)if(anyDerivation((XSTypeDefinition)members.item(i),ns,name,seen))return true;}}return false;}
 static boolean varietyDerivation(XSTypeDefinition type,String ns,String name,boolean list){Set<XSTypeDefinition>seen=visited();while(type!=null&&seen.add(type)){if(type.getTypeCategory()==XSTypeDefinition.SIMPLE_TYPE){XSSimpleTypeDefinition simple=(XSSimpleTypeDefinition)type;if(list&&simple.getVariety()==XSSimpleTypeDefinition.VARIETY_LIST&&restriction(simple.getItemType(),ns,name))return true;if(!list&&simple.getVariety()==XSSimpleTypeDefinition.VARIETY_UNION){XSObjectList members=simple.getMemberTypes();for(int i=0;i<members.getLength();i++)if(restriction((XSTypeDefinition)members.item(i),ns,name))return true;}}type=type.getBaseType();}return false;}
 static boolean derived(XSTypeDefinition type,String ns,String name,int method){if(method==0)return anyDerivation(type,ns,name,visited());return ((method&1)!=0&&restriction(type,ns,name))||((method&2)!=0&&extension(type,ns,name))||((method&4)!=0&&varietyDerivation(type,ns,name,false))||((method&8)!=0&&varietyDerivation(type,ns,name,true));}
 static String type(TypeInfo t){if(t==null)return "null";if(!(t instanceof XSTypeDefinition))throw new UnsupportedProvider();XSTypeDefinition component=(XSTypeDefinition)t;String name=typeName(component),ns=typeNamespace(component);typeIdentities.put(ns+'\0'+name,component);StringBuilder b=new StringBuilder("{\"name\":"+q(name)+",\"namespaceURI\":"+q(ns.isEmpty()?null:ns)+",\"rawName\":"+q(t.getTypeName())+",\"rawNamespaceURI\":"+q(t.getTypeNamespace())+",\"anonymous\":"+component.getAnonymous()+",\"identity\":{\"schemaIdentity\":"+q(schemaIdentity)+",\"namespaceURI\":"+q(ns)+",\"name\":"+q(name)+"},\"qNameValue\":"+(derived(component,XMLConstants.W3C_XML_SCHEMA_NS_URI,"QName",0)||derived(component,XMLConstants.W3C_XML_SCHEMA_NS_URI,"NOTATION",0))+",\"derivations\":[");for(int i=0;i<queries.size();i++){if(i>0)b.append(',');String[] query=queries.get(i);b.append(derived(component,query[0],query[1],Integer.parseInt(query[2])));}return b.append("]}").toString();}
 static class SourceElement {
  boolean inputText=false,outputText=false;StringBuilder value;
  void type(TypeInfo info,DefaultReferences references){if(references.mayBeId(references.simple(info),visited()))value=new StringBuilder();}
  void characters(char[] c,int s,int n){outputText=true;if(value!=null)value.append(c,s,n);}
 }
 // JDK Xerces omits schema-added IDREF(S) from its reference table. Use actual
 // validated type metadata and check only those omitted references at EOF.
 static class DefaultReferences {
  Set<String> ids=new HashSet<>();Map<String,SAXParseException> refs=new LinkedHashMap<>();
  XSSimpleTypeDefinition simple(TypeInfo info){if(!(info instanceof XSTypeDefinition))return null;XSTypeDefinition type=(XSTypeDefinition)info;return type.getTypeCategory()==XSTypeDefinition.SIMPLE_TYPE?(XSSimpleTypeDefinition)type:((XSComplexTypeDefinition)type).getSimpleType();}
  boolean atomic(XSSimpleTypeDefinition type,String name){return type!=null&&type.getVariety()==XSSimpleTypeDefinition.VARIETY_ATOMIC&&restriction(type,XMLConstants.W3C_XML_SCHEMA_NS_URI,name);}
  boolean mayBeId(XSSimpleTypeDefinition type,Set<XSTypeDefinition>seen){
   if(type==null||!seen.add(type))return false;
   if(atomic(type,"ID"))return true;
   // A union's selected member is only known at element end.
   if(type.getVariety()==XSSimpleTypeDefinition.VARIETY_UNION){XSObjectList members=type.getMemberTypes();for(int i=0;i<members.getLength();i++)if(mayBeId((XSSimpleTypeDefinition)members.item(i),seen))return true;}
   return false;
  }
  void attribute(TypeInfo info,boolean isId,boolean specified,String value){
   if(isId)ids.add(value.trim());
   if(specified)return;
   XSSimpleTypeDefinition type=simple(info);
   boolean list=type!=null&&type.getVariety()==XSSimpleTypeDefinition.VARIETY_LIST&&atomic(type.getItemType(),"IDREF");
   if(!list&&!atomic(type,"IDREF"))return;
   for(String ref:value.trim().split("[ \\t\\r\\n]+"))if(!ref.isEmpty())refs.putIfAbsent(ref,new SAXParseException("Schema-default ID reference '"+ref+"' has no matching ID.",activeLocator));
  }
  void element(TypeInfo info,String value){if(atomic(simple(info),"ID"))ids.add(value.trim());}
  void finish(Diagnostics diagnostics)throws SAXException{for(Map.Entry<String,SAXParseException>ref:refs.entrySet())if(!ids.contains(ref.getKey()))diagnostics.error(ref.getValue());}
 }
 static class Input implements LSInput {
 String text,id;Input(String t,String i){text=t;id=i;}public Reader getCharacterStream(){return new StringReader(text);}public void setCharacterStream(Reader r){}public InputStream getByteStream(){return null;}public void setByteStream(InputStream s){}public String getStringData(){return text;}public void setStringData(String s){text=s;}public String getSystemId(){return id;}public void setSystemId(String s){id=s;}public String getPublicId(){return null;}public void setPublicId(String s){}public String getBaseURI(){return id;}public void setBaseURI(String s){}public String getEncoding(){return "UTF-8";}public void setEncoding(String s){}public boolean getCertifiedText(){return false;}public void setCertifiedText(boolean b){}
 }
 static class Diagnostics implements ErrorHandler {
 boolean valid=true;String phase;Diagnostics(String p){phase=p;}
 void report(SAXParseException e,String severity)throws SAXException{if(!severity.equals("warning"))valid=false;emit("{\"kind\":\"diagnostic\",\"diagnostic\":{\"message\":"+q(e.getMessage())+",\"severity\":"+q(severity)+",\"phase\":"+q(phase)+",\"systemId\":"+q(e.getSystemId())+",\"line\":"+e.getLineNumber()+",\"column\":"+e.getColumnNumber()+"}}");try{if(!frame().equals("continue"))throw new SAXException("Diagnostic handler stopped validation");}catch(IOException cause){throw new SAXException("Diagnostic acknowledgement channel closed",cause);}}
 public void warning(SAXParseException e)throws SAXException{report(e,"warning");} public void error(SAXParseException e)throws SAXException{report(e,"error");}public void fatalError(SAXParseException e)throws SAXException{report(e,"fatal");throw e;}
 }
 static class ChunkInput extends InputStream {
 byte[] bytes=new byte[0];int pos;boolean ended;
 public int read()throws IOException{byte[] b=new byte[1];return read(b,0,1)<0?-1:b[0]&255;}
 public int read(byte[] b,int o,int l)throws IOException{if(l==0)return 0;while(pos==bytes.length){if(ended)return -1;emit("{\"kind\":\"needChunk\"}");int n=in.readInt();if(n<0||n>LIMIT)throw new IOException("Chunk limit");if(n==0){ended=true;return -1;}bytes=in.readNBytes(n);if(bytes.length!=n)throw new EOFException();pos=0;}int n=Math.min(l,bytes.length-pos);System.arraycopy(bytes,pos,b,o,n);pos+=n;return n;}
 void finish()throws IOException{byte[] b=new byte[8192];while(read(b)>=0){}}
 }
 public static void main(String[] args)throws Exception {
 try {
 int count=Integer.parseInt(frame());if(count<1||count>256)throw new IOException("Schema count limit");
 schemaIdentity=frame();
 int queryCount=Integer.parseInt(frame());if(queryCount<0||queryCount>256)throw new IOException("Type query limit");for(int i=0;i<queryCount;i++)queries.add(new String[]{frame(),frame(),frame()});
 Map<String,String> catalogue=new HashMap<>();Map<String,List<String>> namespaceCatalogue=new HashMap<>();Source[] sources=new Source[count];
 for(int i=0;i<count;i++){String id=frame(),text=frame();catalogue.put(id,text);namespaceCatalogue.computeIfAbsent(schemaNamespace(text),key->new ArrayList<>()).add(id);StreamSource s=new StreamSource(new StringReader(text));s.setSystemId(id);sources[i]=s;}
 SchemaFactory f=SchemaFactory.newDefaultInstance();
 f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING,true);f.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD,"");f.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
 LSResourceResolver resolver=(kind,ns,pub,sys,base)->{String resolved=sys;try{if(base!=null&&sys!=null)resolved=URI.create(base).resolve(sys).toString();}catch(Exception e){throw new IllegalArgumentException("Invalid resource identifier",e);}String text=catalogue.get(resolved);if(text==null&&sys==null){List<String> matches=namespaceCatalogue.get(ns==null?"":ns);if(matches!=null&&matches.size()==1){resolved=matches.get(0);text=catalogue.get(resolved);}else if(matches!=null&&matches.size()>1)throw new IllegalArgumentException("Ambiguous namespace-only schema import: "+ns+"; supply an explicit include entry schema and schemaLocation");}if(text==null)throw new IllegalArgumentException("Unresolved schema resource: "+resolved);return new Input(text,resolved);};
 f.setResourceResolver(resolver);Diagnostics compile=new Diagnostics("compile");f.setErrorHandler(compile);
 Schema schema=f.newSchema(sources);if(!compile.valid)throw new SAXException("Invalid schema");emit("{\"kind\":\"ready\"}");
 while(true){String cmd;try{cmd=frame();}catch(EOFException e){break;}if(cmd.equals("dispose"))break;if(cmd.equals("queryType")){String ns=frame(),name=frame(),ancestorNS=frame(),ancestorName=frame();int method=Integer.parseInt(frame());XSTypeDefinition component=typeIdentities.get(ns+'\0'+name);if(component==null)emit("{\"kind\":\"queryTypeResult\",\"found\":false}");else emit("{\"kind\":\"queryTypeResult\",\"found\":true,\"value\":"+derived(component,ancestorNS,ancestorName,method)+"}");continue;}if(!cmd.equals("validate"))throw new IOException("Invalid command");String id=frame();
 ChunkInput xml=new ChunkInput();Diagnostics diagnostics=new Diagnostics("validate");
 try{
 ValidatorHandler handler=schema.newValidatorHandler();handler.setResourceResolver(resolver);handler.setErrorHandler(diagnostics);TypeInfoProvider types=handler.getTypeInfoProvider();Deque<SourceElement> original=new ArrayDeque<>();DefaultReferences defaultReferences=new DefaultReferences();
 handler.setContentHandler(new DefaultHandler(){
 final Map<String,String>pending=new HashMap<>();final Deque<Map<String,String>>bindings=new ArrayDeque<>();final Deque<List<String>>generated=new ArrayDeque<>();
 public void setDocumentLocator(Locator locator){activeLocator=locator;}
 public void startDocument(){emit("{\"kind\":\"startDocument\"}");}public void endDocument()throws SAXException{defaultReferences.finish(diagnostics);emit("{\"kind\":\"endDocument\"}");}
 public void startPrefixMapping(String p,String u){pending.put(p,u);emit("{\"kind\":\"startPrefixMapping\",\"prefix\":"+q(p)+",\"namespaceURI\":"+q(u)+"}");}public void endPrefixMapping(String p){emit("{\"kind\":\"endPrefixMapping\",\"prefix\":"+q(p)+"}");}
 public void startElement(String u,String l,String n,Attributes a){if(!original.isEmpty())original.peek().type(types.getElementTypeInfo(),defaultReferences);Map<String,String>scope=bindings.isEmpty()?new HashMap<>():new HashMap<>(bindings.peek());scope.put("xml",XMLConstants.XML_NS_URI);scope.putAll(pending);pending.clear();bindings.push(scope);List<String>created=new ArrayList<>();generated.push(created);StringBuilder attrs=new StringBuilder("[");for(int i=0;i<a.getLength();i++){defaultReferences.attribute(types.getAttributeTypeInfo(i),types.isIdAttribute(i),types.isSpecified(i),a.getValue(i));if(i>0)attrs.append(',');String attributeName=a.getQName(i),uri=a.getURI(i);if(!uri.isEmpty()&&!uri.equals(XMLConstants.XMLNS_ATTRIBUTE_NS_URI)&&attributeName.indexOf(':')<0){String prefix=null;for(Map.Entry<String,String>entry:scope.entrySet())if(!entry.getKey().isEmpty()&&entry.getValue().equals(uri)){prefix=entry.getKey();break;}if(prefix==null){int index=1;do{prefix="ns"+index++;}while(scope.containsKey(prefix));scope.put(prefix,uri);created.add(prefix);emit("{\"kind\":\"startPrefixMapping\",\"prefix\":"+q(prefix)+",\"namespaceURI\":"+q(uri)+",\"generatedReason\":\"schema-default\"}");}attributeName=prefix+":"+a.getLocalName(i);}attrs.append("{\"name\":").append(q(attributeName)).append(",\"localName\":").append(q(a.getLocalName(i))).append(",\"namespaceURI\":").append(q(a.getURI(i))).append(",\"value\":").append(q(a.getValue(i))).append(",\"type\":").append(type(types.getAttributeTypeInfo(i))).append(",\"isId\":").append(types.isIdAttribute(i)).append(",\"specified\":").append(types.isSpecified(i)).append('}');}emit("{\"kind\":\"startElement\",\"name\":"+q(n)+",\"localName\":"+q(l)+",\"namespaceURI\":"+q(u)+",\"type\":"+type(types.getElementTypeInfo())+",\"attributes\":"+attrs.append(']')+"}");}
 public void endElement(String u,String l,String n){SourceElement source=original.peek();if(source!=null&&source.value!=null)defaultReferences.element(types.getElementTypeInfo(),source.value.toString());boolean specified=source==null||source.inputText||!source.outputText;emit("{\"kind\":\"endElement\",\"name\":"+q(n)+",\"localName\":"+q(l)+",\"namespaceURI\":"+q(u)+",\"specified\":"+specified+",\"type\":"+type(types.getElementTypeInfo())+"}");List<String>created=generated.pop();for(int index=created.size()-1;index>=0;index--)emit("{\"kind\":\"endPrefixMapping\",\"prefix\":"+q(created.get(index))+",\"generatedReason\":\"schema-default\"}");bindings.pop();}
 public void characters(char[] c,int s,int n){boolean defaulted=n>0&&!original.isEmpty()&&!original.peek().inputText;if(n>0&&!original.isEmpty())original.peek().characters(c,s,n);emit("{\"kind\":\"text\",\"text\":"+q(new String(c,s,n))+(defaulted?",\"generatedReason\":\"schema-default\"":"")+"}");}
 public void ignorableWhitespace(char[] c,int s,int n){characters(c,s,n);}
 public void processingInstruction(String target,String data){emit("{\"kind\":\"processingInstruction\",\"target\":"+q(target)+",\"data\":"+q(data)+"}");}
 });
 SAXParserFactory pf=SAXParserFactory.newInstance();pf.setNamespaceAware(true);pf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING,true);pf.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);XMLReader reader=pf.newSAXParser().getXMLReader();reader.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD,"");reader.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");reader.setEntityResolver((pub,sys)->{throw new SAXException("External entities forbidden");});reader.setErrorHandler(new Diagnostics("parse"));XMLFilterImpl filter=new XMLFilterImpl(reader){public void startElement(String u,String l,String n,Attributes a)throws SAXException{original.push(new SourceElement());super.startElement(u,l,n,a);}public void endElement(String u,String l,String n)throws SAXException{super.endElement(u,l,n);original.pop();}public void characters(char[]c,int s,int n)throws SAXException{if(n>0&&!original.isEmpty())original.peek().inputText=true;super.characters(c,s,n);}public void ignorableWhitespace(char[]c,int s,int n)throws SAXException{if(n>0&&!original.isEmpty())original.peek().inputText=true;super.ignorableWhitespace(c,s,n);}};filter.setEntityResolver((pub,sys)->{throw new SAXException("External entities forbidden");});filter.setErrorHandler(new Diagnostics("parse"));filter.setContentHandler(handler);InputSource input=new InputSource(xml);input.setEncoding("UTF-8");input.setSystemId(id);filter.parse(input);
 }catch(Exception e){if(e instanceof UnsupportedProvider){xml.ended=true;emit("{\"kind\":\"failure\",\"code\":\"UNSUPPORTED_CAPABILITY\",\"message\":"+q(e.getMessage())+"}");return;}diagnostics.valid=false;if(!(e instanceof SAXParseException))diagnostics.report(new SAXParseException(e.getMessage(),null),"fatal");}finally{xml.finish();}
 emit("{\"kind\":\"result\",\"valid\":"+diagnostics.valid+"}");
 }
 }catch(Exception e){emit("{\"kind\":\"failure\",\"message\":"+q(e.getMessage())+"}");}
 }
}






