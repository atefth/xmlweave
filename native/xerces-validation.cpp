// XMLWeave MIT. Xerces integration informed by xerces-wasm (MIT),
// https://github.com/harshanacz/xerces-wasm-validator . Xerces-C++ is Apache-2.0.
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <stdexcept>
#include <algorithm>
#include <set>
#include <xercesc/util/PlatformUtils.hpp>
#include <xercesc/util/XMLString.hpp>
#include <xercesc/util/XMLUni.hpp>
#include <xercesc/util/BinInputStream.hpp>
#include <xercesc/util/XMLEntityResolver.hpp>
#include <xercesc/util/XMLResourceIdentifier.hpp>
#include <xercesc/parsers/SAX2XMLReaderImpl.hpp>
#include <xercesc/sax2/DefaultHandler.hpp>
#include <xercesc/sax2/Attributes.hpp>
#include <xercesc/sax/Locator.hpp>
#include <xercesc/framework/MemBufInputSource.hpp>
#include <xercesc/framework/XMLGrammarPoolImpl.hpp>
#include <xercesc/framework/psvi/PSVIHandler.hpp>
#include <xercesc/framework/psvi/PSVIElement.hpp>
#include <xercesc/framework/psvi/PSVIAttribute.hpp>
#include <xercesc/framework/psvi/PSVIAttributeList.hpp>
#include <xercesc/framework/psvi/XSTypeDefinition.hpp>
#include <xercesc/framework/psvi/XSSimpleTypeDefinition.hpp>
#include <xercesc/framework/psvi/XSComplexTypeDefinition.hpp>
#include <emscripten.h>
using namespace xercesc;
EM_JS_DEPS(xw_deps, "$stringToNewUTF8");
EM_ASYNC_JS(int,xw_read,(unsigned char* ptr,int maximum),{try{Module.HEAPU8=HEAPU8;return await Module.xmlweaveRead(ptr,maximum);}catch(error){if(!Module.xmlweaveFailed){Module.xmlweaveFailed=true;Module.xmlweaveFailure=error;}return -1;}});
EM_ASYNC_JS(int,xw_emit,(const char* json),{try{await Module.xmlweaveEmit(JSON.parse(UTF8ToString(json)));return 1;}catch(error){if(!Module.xmlweaveFailed){Module.xmlweaveFailed=true;Module.xmlweaveFailure=error;}return 0;}});
EM_JS(int,xw_diagnostic,(const char* json),{try{Module.xmlweaveDiagnostic(JSON.parse(UTF8ToString(json)));return 1;}catch(error){if(!Module.xmlweaveFailed){Module.xmlweaveFailed=true;Module.xmlweaveFailure=error;}return 0;}});
EM_JS(char*,xw_resolve,(const char* system,const char* base),{try{const key=new URL(UTF8ToString(system),UTF8ToString(base)||undefined).href;return stringToNewUTF8(key);}catch(error){return stringToNewUTF8(UTF8ToString(system));}});
static std::string str(const XMLCh* s){if(!s)return "";char* p=XMLString::transcode(s);std::string out(p);XMLString::release(&p);return out;}
static std::string quoted(const std::string& s){std::string out="\"";for(unsigned char c:s){if(c=='"')out+="\\\"";else if(c=='\\')out+="\\\\";else if(c=='\n')out+="\\n";else if(c=='\r')out+="\\r";else if(c=='\t')out+="\\t";else if(c<32){const char* hex="0123456789abcdef";out+="\\u00";out+=hex[c>>4];out+=hex[c&15];}else out+=c;}return out+'"';}
static std::string qs(const XMLCh* s){return s?quoted(str(s)):"null";}
static const Locator*activeLocator=nullptr;
static std::string location(){if(!activeLocator)return "null";return "{\"systemId\":"+qs(activeLocator->getSystemId())+",\"line\":"+std::to_string(activeLocator->getLineNumber())+",\"column\":"+std::to_string(activeLocator->getColumnNumber())+"}";}
static void emit(const std::string& value){bool diagnostic=value.rfind("{\"kind\":\"diagnostic\"",0)==0||value.rfind("{\"kind\":\"failure\"",0)==0;std::string event=value;if(!diagnostic&&value.find("\"generatedLocator\"")==std::string::npos)event=value.substr(0,value.size()-1)+",\"generatedLocator\":"+location()+"}";if(!(diagnostic?xw_diagnostic(event.c_str()):xw_emit(event.c_str())))throw std::runtime_error("Application callback interrupted validation");}
struct Query{std::string uri,name;int method;};
static std::vector<Query> queries;
static std::string schemaIdentity;
static std::map<XSTypeDefinition*,std::string>anonymousNames;
static std::map<std::pair<std::string,std::string>,XSTypeDefinition*>typeIdentities;
static std::string typeName(XSTypeDefinition*t){if(!t)return "";if(!t->getAnonymous())return str(t->getName());auto found=anonymousNames.find(t);if(found!=anonymousNames.end())return found->second;std::string name="anonymous-"+std::to_string(anonymousNames.size()+1);anonymousNames[t]=name;return name;}
static std::string typeNamespace(XSTypeDefinition*t){return t&&t->getAnonymous()?schemaIdentity:str(t?t->getNamespace():nullptr);}
static bool matches(XSTypeDefinition*t,const Query&q){return t&&typeName(t)==q.name&&typeNamespace(t)==q.uri;}
static bool restriction(XSTypeDefinition*t,const Query&q){std::set<XSTypeDefinition*>seen;while(t&&seen.insert(t).second){if(matches(t,q))return true;if(t->getTypeCategory()==XSTypeDefinition::COMPLEX_TYPE&&static_cast<XSComplexTypeDefinition*>(t)->getDerivationMethod()!=XSConstants::DERIVATION_RESTRICTION)return false;t=t->getBaseType();}return false;}
static bool extension(XSTypeDefinition*t,const Query&q){bool extended=false;std::set<XSTypeDefinition*>seen;while(t&&seen.insert(t).second){if(matches(t,q))return extended;if(t->getTypeCategory()==XSTypeDefinition::COMPLEX_TYPE&&static_cast<XSComplexTypeDefinition*>(t)->getDerivationMethod()==XSConstants::DERIVATION_EXTENSION)extended=true;t=t->getBaseType();}return false;}
static bool anyDerivation(XSTypeDefinition*t,const Query&q,std::set<XSTypeDefinition*>&seen){if(!t||!seen.insert(t).second)return false;if(matches(t,q))return true;if(anyDerivation(t->getBaseType(),q,seen))return true;if(t->getTypeCategory()==XSTypeDefinition::SIMPLE_TYPE){auto*s=static_cast<XSSimpleTypeDefinition*>(t);if(s->getVariety()==XSSimpleTypeDefinition::VARIETY_LIST&&anyDerivation(s->getItemType(),q,seen))return true;if(s->getVariety()==XSSimpleTypeDefinition::VARIETY_UNION){auto*members=s->getMemberTypes();for(XMLSize_t n=0;members&&n<members->size();n++)if(anyDerivation(members->elementAt(n),q,seen))return true;}}return false;}
static bool varietyDerivation(XSTypeDefinition*t,const Query&q,bool list){std::set<XSTypeDefinition*>seen;while(t&&seen.insert(t).second){if(t->getTypeCategory()==XSTypeDefinition::SIMPLE_TYPE){auto*s=static_cast<XSSimpleTypeDefinition*>(t);if(list&&s->getVariety()==XSSimpleTypeDefinition::VARIETY_LIST&&restriction(s->getItemType(),q))return true;if(!list&&s->getVariety()==XSSimpleTypeDefinition::VARIETY_UNION){auto*members=s->getMemberTypes();for(XMLSize_t n=0;members&&n<members->size();n++)if(restriction(members->elementAt(n),q))return true;}}t=t->getBaseType();}return false;}
static bool derived(XSTypeDefinition*t,const Query&q){if(q.method==0){std::set<XSTypeDefinition*>seen;return anyDerivation(t,q,seen);}return ((q.method&1)&&restriction(t,q))||((q.method&2)&&extension(t,q))||((q.method&4)&&varietyDerivation(t,q,false))||((q.method&8)&&varietyDerivation(t,q,true));}
static std::string basicType(XSTypeDefinition*t){return t?"{\"name\":"+qs(t->getName())+",\"namespaceURI\":"+qs(t->getNamespace())+"}":"null";}
static std::string type(XSTypeDefinition* t){if(!t)return "null";std::string name=typeName(t),ns=typeNamespace(t);typeIdentities[{ns,name}]=t;std::string out="{\"name\":"+quoted(name)+",\"namespaceURI\":"+(ns.empty()?"null":quoted(ns))+",\"rawName\":"+qs(t->getName())+",\"rawNamespaceURI\":"+qs(t->getNamespace())+",\"identity\":{\"schemaIdentity\":"+quoted(schemaIdentity)+",\"namespaceURI\":"+quoted(ns)+",\"name\":"+quoted(name)+"},\"anonymous\":"+(t->getAnonymous()?"true":"false")+",\"derivations\":[";for(size_t n=0;n<queries.size();n++){if(n)out+=',';out+=derived(t,queries[n])?"true":"false";}auto*simple=t->getTypeCategory()==XSTypeDefinition::SIMPLE_TYPE?static_cast<XSSimpleTypeDefinition*>(t):static_cast<XSComplexTypeDefinition*>(t)->getSimpleType();return out+"],\"primitiveType\":"+basicType(simple?simple->getPrimitiveType():nullptr)+",\"itemPrimitiveType\":"+basicType(simple&&simple->getVariety()==XSSimpleTypeDefinition::VARIETY_LIST&&simple->getItemType()?simple->getItemType()->getPrimitiveType():nullptr)+",\"variety\":"+std::to_string(simple?simple->getVariety():0)+"}";}
static std::string info(PSVIItem* i){if(!i)return "{\"type\":null,\"memberType\":null}";return "{\"type\":"+type(i->getTypeDefinition())+",\"memberType\":"+type(i->getMemberTypeDefinition())+",\"normalizedValue\":"+qs(i->getSchemaNormalizedValue())+",\"schemaDefault\":"+qs(i->getSchemaDefault())+",\"schemaSpecified\":"+(i->getIsSchemaSpecified()?"true":"false")+",\"validity\":"+std::to_string(i->getValidity())+"}";}
static const XMLCh utf8[]={0x55,0x54,0x46,0x2D,0x38,0};
class ChunkStream:public BinInputStream{XMLFilePos pos=0;public:XMLFilePos curPos()const override{return pos;}const XMLCh*getContentType()const override{return nullptr;}XMLSize_t readBytes(XMLByte*const ptr,const XMLSize_t max)override{int n=xw_read(ptr,(int)std::min<XMLSize_t>(max,65536));if(n<0)throw std::runtime_error("Input interrupted");pos+=n;return n;}};
class ChunkSource:public InputSource{public:explicit ChunkSource(const char*id):InputSource(id){setEncoding(utf8);}BinInputStream*makeStream()const override{return new ChunkStream();}};
struct Attribute {std::string name,local,uri,value;std::string psvi="null";bool specified=true,id=false;};
struct Element {std::string name,local,uri;std::vector<Attribute> attrs;bool emitted=false;std::string pendingText;std::map<std::string,std::string> bindings;std::string startLocation,pendingTextLocation;std::vector<std::string> generatedPrefixes;};
class ReportingReader:public SAX2XMLReaderImpl {
public:
 std::string diagnosticPhase="validate";
 ReportingReader(XMLGrammarPool*pool):SAX2XMLReaderImpl(XMLPlatformUtils::fgMemoryManager,pool){}
 void error(const unsigned int code,const XMLCh*const domain,const XMLErrorReporter::ErrTypes severity,const XMLCh*const text,const XMLCh*const systemId,const XMLCh*const publicId,const XMLFileLoc line,const XMLFileLoc column)override{
  diagnosticPhase=(XMLString::equals(domain,XMLUni::fgValidityDomain)||severity==XMLErrorReporter::ErrType_Error)?"validate":"parse";
  SAX2XMLReaderImpl::error(code,domain,severity,text,systemId,publicId,line,column);
 }
};
class Engine:public DefaultHandler,public PSVIHandler,public XMLEntityResolver {
public:
 std::map<std::string,std::string> sources;std::vector<std::string> order;std::unique_ptr<XMLGrammarPoolImpl> pool;std::unique_ptr<ReportingReader> parser;std::vector<Element> stack;std::map<std::string,std::string> pendingBindings;const Locator*locator=nullptr;bool valid=true;std::string phase="compile";
 Engine(){pool=std::make_unique<XMLGrammarPoolImpl>(XMLPlatformUtils::fgMemoryManager);parser=std::make_unique<ReportingReader>(pool.get());parser->setFeature(XMLUni::fgSAX2CoreNameSpaces,true);parser->setFeature(XMLUni::fgSAX2CoreValidation,true);parser->setFeature(XMLUni::fgXercesSchema,true);parser->setFeature(XMLUni::fgXercesSchemaFullChecking,true);parser->setFeature(XMLUni::fgXercesLoadExternalDTD,false);parser->setFeature(XMLUni::fgXercesDisallowDoctype,true);parser->setFeature(XMLUni::fgXercesDisableDefaultEntityResolution,true);XMLSize_t lowWaterMark=0;parser->setProperty(XMLUni::fgXercesLowWaterMark,&lowWaterMark);parser->setErrorHandler(this);parser->setContentHandler(this);parser->setXMLEntityResolver(this);parser->setPSVIHandler(this);}
 InputSource*resolveEntity(XMLResourceIdentifier* resource)override{std::string sys=str(resource->getSystemId()),base=str(resource->getBaseURI());char*resolved=xw_resolve(sys.c_str(),base.c_str());std::string key(resolved);free(resolved);auto found=sources.find(key);if(found==sources.end())throw std::runtime_error("Unresolved external resource: "+key);auto*input=new MemBufInputSource(reinterpret_cast<const XMLByte*>(found->second.data()),found->second.size(),key.c_str());input->setEncoding(utf8);return input;}
 void diagnostic(const SAXParseException&e,const char*severity){if(std::string(severity)!="warning")valid=false;emit("{\"kind\":\"diagnostic\",\"diagnostic\":{\"message\":"+qs(e.getMessage())+",\"severity\":"+quoted(severity)+",\"phase\":"+quoted(phase=="compile"?phase:parser->diagnosticPhase)+",\"systemId\":"+qs(e.getSystemId())+",\"line\":"+std::to_string(e.getLineNumber())+",\"column\":"+std::to_string(e.getColumnNumber())+"}}");}
 void warning(const SAXParseException&e)override{diagnostic(e,"warning");}void error(const SAXParseException&e)override{diagnostic(e,"error");if(phase=="compile")throw e;}void fatalError(const SAXParseException&e)override{diagnostic(e,"fatal");throw e;}
 void setDocumentLocator(const Locator*const value)override{locator=value;activeLocator=value;}
 void processingInstruction(const XMLCh*const target,const XMLCh*const data)override{if(phase=="validate")emit("{\"kind\":\"processingInstruction\",\"target\":"+qs(target)+",\"data\":"+qs(data)+"}");}
 void checkDefaultQName(PSVIItem*i,const Element&e){
  if(!i||!i->getIsSchemaSpecified()||!i->getSchemaNormalizedValue())return;
  XSTypeDefinition*t=i->getMemberTypeDefinition()?static_cast<XSTypeDefinition*>(i->getMemberTypeDefinition()):i->getTypeDefinition();if(!t)return;
  auto*simple=t->getTypeCategory()==XSTypeDefinition::SIMPLE_TYPE?static_cast<XSSimpleTypeDefinition*>(t):static_cast<XSComplexTypeDefinition*>(t)->getSimpleType();if(!simple)return;
  bool list=simple->getVariety()==XSSimpleTypeDefinition::VARIETY_LIST;auto*atomic=list?(simple->getItemType()?simple->getItemType()->getPrimitiveType():nullptr):simple->getPrimitiveType();
  if(!atomic||str(atomic->getNamespace())!="http://www.w3.org/2001/XMLSchema"||(str(atomic->getName())!="QName"&&str(atomic->getName())!="NOTATION"))return;
  std::unique_ptr<BaseRefVectorOf<XMLCh>>tokens(XMLString::tokenizeString(i->getSchemaNormalizedValue()));
  for(XMLSize_t n=0;n<tokens->size();n++){const XMLCh*token=tokens->elementAt(n);int colon=XMLString::indexOf(token,XMLCh(':'));if(colon<0)continue;std::vector<XMLCh>prefix(token,token+colon);prefix.push_back(0);auto found=e.bindings.find(str(prefix.data()));if(found==e.bindings.end()||found->second.empty()){
   valid=false;emit("{\"kind\":\"diagnostic\",\"diagnostic\":{\"message\":\"Schema-defaulted QName prefix has no binding in the instance namespace context.\",\"severity\":\"error\",\"phase\":\"validate\",\"systemId\":"+qs(locator?locator->getSystemId():nullptr)+",\"line\":"+std::to_string(locator?locator->getLineNumber():0)+",\"column\":"+std::to_string(locator?locator->getColumnNumber():0)+"}}");
  }}
 }
 void startDocument()override{if(phase=="validate")emit("{\"kind\":\"startDocument\"}");}void endDocument()override{if(phase=="validate")emit("{\"kind\":\"endDocument\"}");}
 void startPrefixMapping(const XMLCh*const p,const XMLCh*const u)override{if(phase=="validate"){pendingBindings[str(p)]=str(u);emit("{\"kind\":\"startPrefixMapping\",\"prefix\":"+qs(p)+",\"namespaceURI\":"+qs(u)+"}");}}void endPrefixMapping(const XMLCh*const p)override{if(phase=="validate")emit("{\"kind\":\"endPrefixMapping\",\"prefix\":"+qs(p)+"}");}
 void startElement(const XMLCh*const u,const XMLCh*const l,const XMLCh*const n,const Attributes&a)override{if(phase!="validate")return;Element e{str(n),str(l),str(u),{}};e.startLocation=location();for(XMLSize_t i=0;i<a.getLength();i++)e.attrs.push_back({str(a.getQName(i)),str(a.getLocalName(i)),str(a.getURI(i)),str(a.getValue(i))});e.bindings=stack.empty()?std::map<std::string,std::string>{{"xml","http://www.w3.org/XML/1998/namespace"}}:stack.back().bindings;for(const auto&binding:pendingBindings)e.bindings[binding.first]=binding.second;pendingBindings.clear();stack.push_back(e);}
 void endElement(const XMLCh*const,const XMLCh*const,const XMLCh*const)override{}
 void start(Element&e,PSVIElement*i){if(e.emitted)return;e.emitted=true;for(auto&a:e.attrs){if(a.uri.empty()||a.uri=="http://www.w3.org/2000/xmlns/"||a.name.find(':')!=std::string::npos)continue;std::string prefix;for(const auto&binding:e.bindings)if(!binding.first.empty()&&binding.second==a.uri){prefix=binding.first;break;}if(prefix.empty()){unsigned n=1;do{prefix="ns"+std::to_string(n++);}while(e.bindings.count(prefix));e.bindings[prefix]=a.uri;e.generatedPrefixes.push_back(prefix);emit("{\"kind\":\"startPrefixMapping\",\"prefix\":"+quoted(prefix)+",\"namespaceURI\":"+quoted(a.uri)+",\"generatedReason\":\"schema-default\"}");}a.name=prefix+":"+a.local;}std::string attrs="[";for(size_t n=0;n<e.attrs.size();n++){const auto&a=e.attrs[n];if(n)attrs+=',';attrs+="{\"name\":"+quoted(a.name)+",\"localName\":"+quoted(a.local)+",\"namespaceURI\":"+quoted(a.uri)+",\"value\":"+quoted(a.value)+",\"specified\":"+(a.specified?"true":"false")+",\"isId\":"+(a.id?"true":"false")+",\"psvi\":"+a.psvi+"}";}attrs+=']';emit("{\"kind\":\"startElement\",\"name\":"+quoted(e.name)+",\"localName\":"+quoted(e.local)+",\"namespaceURI\":"+quoted(e.uri)+",\"psvi\":"+info(i)+",\"attributes\":"+attrs+",\"generatedLocator\":"+e.startLocation+"}");}
 void handleAttributesPSVI(const XMLCh*const,const XMLCh*const,PSVIAttributeList*list)override{if(phase!="validate"||stack.empty()||!list)return;for(auto&a:stack.back().attrs){PSVIAttribute*i=nullptr;for(XMLSize_t n=0;n<list->getLength();n++)if(str(list->getAttributeNameAtIndex(n))==a.local&&str(list->getAttributeNamespaceAtIndex(n))==a.uri){i=list->getAttributePSVIAtIndex(n);break;}if(i){checkDefaultQName(i,stack.back());a.psvi=info(i);a.specified=!i->getIsSchemaSpecified();if(i->getSchemaNormalizedValue())a.value=str(i->getSchemaNormalizedValue());XMLCh*xsd=XMLString::transcode("http://www.w3.org/2001/XMLSchema");XMLCh*id=XMLString::transcode("ID");auto*t=i->getMemberTypeDefinition()?static_cast<XSTypeDefinition*>(i->getMemberTypeDefinition()):i->getTypeDefinition();a.id=t&&t->derivedFrom(xsd,id);XMLString::release(&xsd);XMLString::release(&id);}}}
 void handlePartialElementPSVI(const XMLCh*const,const XMLCh*const,PSVIElement*i)override{if(phase=="validate"&&!stack.empty())start(stack.back(),i);}
 void handleElementPSVI(const XMLCh*const,const XMLCh*const,PSVIElement*i)override{if(phase!="validate"||stack.empty())return;auto&e=stack.back();checkDefaultQName(i,e);start(e,i);if(!e.pendingText.empty())emit("{\"kind\":\"text\",\"text\":"+quoted(e.pendingText)+",\"generatedLocator\":"+e.pendingTextLocation+",\"generatedReason\":\"schema-default\"}");emit("{\"kind\":\"endElement\",\"name\":"+quoted(e.name)+",\"localName\":"+quoted(e.local)+",\"namespaceURI\":"+quoted(e.uri)+",\"psvi\":"+info(i)+"}");for(auto p=e.generatedPrefixes.rbegin();p!=e.generatedPrefixes.rend();++p)emit("{\"kind\":\"endPrefixMapping\",\"prefix\":"+quoted(*p)+",\"generatedReason\":\"schema-default\"}");stack.pop_back();}
 void characters(const XMLCh*const text,const XMLSize_t length)override{if(phase!="validate")return;std::vector<XMLCh> value(text,text+length);value.push_back(0);if(!stack.empty()&&!stack.back().emitted){stack.back().pendingText+=str(value.data());stack.back().pendingTextLocation=location();return;}emit("{\"kind\":\"text\",\"text\":"+qs(value.data())+"}");}void ignorableWhitespace(const XMLCh*const text,const XMLSize_t length)override{characters(text,length);}
 void compile(){phase="compile";valid=true;for(const auto&id:order){const auto&text=sources.at(id);MemBufInputSource input(reinterpret_cast<const XMLByte*>(text.data()),text.size(),id.c_str());input.setEncoding(utf8);parser->loadGrammar(input,Grammar::SchemaGrammarType,true);}pool->lockPool();parser->setFeature(XMLUni::fgXercesUseCachedGrammarInParse,true);parser->setFeature(XMLUni::fgXercesLoadSchema,false);}
 void validate(const char*id){phase="validate";valid=true;stack.clear();pendingBindings.clear();ChunkSource input(id);parser->parse(input);}
};
static std::unique_ptr<Engine> engine;
extern "C" {
EMSCRIPTEN_KEEPALIVE void xw_set_type_namespace(const char*value){schemaIdentity=value;}
EMSCRIPTEN_KEEPALIVE int xw_query_type(const char*ns,const char*name,const char*ancestorNS,const char*ancestorName,int method){auto found=typeIdentities.find({ns,name});if(found==typeIdentities.end())return -1;return derived(found->second,{ancestorNS,ancestorName,method})?1:0;}
EMSCRIPTEN_KEEPALIVE void xw_add_type_query(const char*uri,const char*name,int method){queries.push_back({uri,name,method});}
EMSCRIPTEN_KEEPALIVE void xw_set_features(int fullChecking,int identityConstraints,int multipleImports){engine->parser->setFeature(XMLUni::fgXercesSchemaFullChecking,fullChecking!=0);engine->parser->setFeature(XMLUni::fgXercesIdentityConstraintChecking,identityConstraints!=0);engine->parser->setFeature(XMLUni::fgXercesHandleMultipleImports,multipleImports!=0);}
EMSCRIPTEN_KEEPALIVE void xw_add_source(const char*id,const char*text){if(!engine){XMLPlatformUtils::Initialize();engine=std::make_unique<Engine>();}engine->sources[id]=text;engine->order.push_back(id);}
EMSCRIPTEN_KEEPALIVE int xw_compile(){try{engine->compile();return engine->valid?1:0;}catch(const XMLException&e){try{emit("{\"kind\":\"failure\",\"message\":"+qs(e.getMessage())+"}");}catch(...){}return 0;}catch(const std::exception&e){try{emit("{\"kind\":\"failure\",\"message\":"+quoted(e.what())+"}");}catch(...){}return 0;}catch(...){return 0;}}
EMSCRIPTEN_KEEPALIVE int xw_validate(const char*id){try{engine->validate(id);return engine->valid?1:0;}catch(const XMLException&e){try{emit("{\"kind\":\"failure\",\"message\":"+qs(e.getMessage())+"}");}catch(...){}return 0;}catch(const std::exception&e){try{emit("{\"kind\":\"failure\",\"message\":"+quoted(e.what())+"}");}catch(...){}return 0;}catch(...){return 0;}}
EMSCRIPTEN_KEEPALIVE void xw_dispose(){engine.reset();queries.clear();activeLocator=nullptr;anonymousNames.clear();typeIdentities.clear();}
}













