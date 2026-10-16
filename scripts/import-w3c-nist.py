from pathlib import Path
import subprocess,hashlib,json,gzip,xml.etree.ElementTree as E,argparse
parser=argparse.ArgumentParser(description="Reproduce the pinned, unmodified W3C/NIST fixture selection.")
parser.add_argument("upstream_checkout",type=Path,help="Local git checkout of https://github.com/w3c/xsdtests containing the pinned revision")
args=parser.parse_args()
import posixpath
repo=args.upstream_checkout.resolve();revision='7bc3365c652a322f3d762021b3879eb92dae7e30';dest=Path(__file__).resolve().parents[1]/'test/fixtures/w3c-nist';dest.mkdir(parents=True,exist_ok=True)
def original(path):return subprocess.check_output(['git','-C',str(repo),'show',revision+':'+path])
def meta(path,data):return {'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'gitBlob':subprocess.check_output(['git','-C',str(repo),'rev-parse',revision+':'+path],text=True).strip(),'url':'https://github.com/w3c/xsdtests/blob/'+revision+'/'+path}
def retain(path):
 data=original(path);target=dest/'upstream'/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);return meta(path,data)
metadataPath='nistMeta/NISTXMLSchemaDatatypes.testSet';data=original(metadataPath);metadata=meta(metadataPath,data);compressed=gzip.compress(data,compresslevel=9,mtime=0);(dest/'NISTXMLSchemaDatatypes.testSet.gz').write_bytes(compressed);metadata['storedAs']='NISTXMLSchemaDatatypes.testSet.gz';metadata['compressedSha256']=hashlib.sha256(compressed).hexdigest()
ns={'t':'http://www.w3.org/XML/2004/xml-schema-test-suite/'};link='{http://www.w3.org/1999/xlink}href';root=E.fromstring(data)
types=['base64Binary','date','integer','decimal','boolean','hexBinary','duration','string'];selected=[]
for typ in types:
 groups=[g for g in root if g.tag.endswith('testGroup') and g.get('name','').startswith('atomic-'+typ+'-')]
 selected.append((typ,groups[0],'First upstream group in metadata order for this datatype.'))
 negatives=[g for g in groups if any(x.find('t:expected',ns).get('validity')=='invalid' for x in g if x.tag.endswith('instanceTest'))]
 if negatives:selected.append((typ,negatives[0],'First upstream group in metadata order declaring invalid instances for this datatype.'))
fixtures=[]
for typ,group,reason in selected:
 tests=[]
 for element in group:
  kind=element.tag.split('}')[-1]
  if kind not in ['schemaTest','instanceTest']:continue
  document=element.find('t:'+('schemaDocument' if kind=='schemaTest' else 'instanceDocument'),ns)
  path=posixpath.normpath(posixpath.join('nistMeta',document.get(link)))
  record={'name':element.get('name'),'kind':kind,'expected':element.find('t:expected',ns).attrib,'status':element.find('t:current',ns).attrib,'source':retain(path)};tests.append(record)
 fixtures.append({'group':group.get('name'),'datatype':typ,'selectionReason':reason,'tests':tests})
manifest={'formatVersion':1,'upstream':'https://github.com/w3c/xsdtests','revision':revision,'scope':'Explicit XSD 1.0 NIST datatype selection; not complete W3C conformance.','selectionPolicy':'Eight named datatype families, complete first group in metadata order and complete first group with metadata-declared invalid instances where available; selected before executing engines.','copyright':retain('00COPYRIGHT'),'metadata':metadata,'groups':fixtures}
(dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(len(fixtures),'groups',sum(x['kind']=='instanceTest' for g in fixtures for x in g['tests']),'instances',len(compressed),'compressed metadata bytes')

