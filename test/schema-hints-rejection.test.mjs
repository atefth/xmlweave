import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

for (const mode of ["abort", "dispose", "failure", "success"]) {
  test(`hint shared compiler ${mode} has no orphan rejection in strict Node`, () => {
    const entry = new URL("../dist/schema-hints.js", import.meta.url).href;
    const code = `
import assert from 'node:assert/strict';
import {createHintValidator} from ${JSON.stringify(entry)};
const mode=${JSON.stringify(mode)}, signal={aborted:false}, sentinel=new Error('shared-compile-sentinel');
const schema='<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:int"/></xs:schema>';
const validator=await createHintValidator({resourceMap:{'urn:strict:schema':schema},compiler:()=>{
  if(mode==='abort')signal.aborted=true;
  if(mode==='dispose')validator.dispose();
  return mode==='success'?Promise.resolve({dispose(){},async validate(){return{valid:true,diagnostics:[]};}}):Promise.reject(sentinel);
}});
try{
  const operation=validator.validate('<r xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:strict:schema">1</r>',{signal});
  if(mode==='success')assert.equal((await operation).valid,true);
  else await assert.rejects(operation,error=>mode==='failure'?error===sentinel:error.code===(mode==='abort'?'ABORTED':'DISPOSED'));
}finally{validator.dispose();}
await new Promise(resolve=>setTimeout(resolve,25));
console.log('strict-rejection-check-passed');
`;
    assert.match(
      execFileSync(
        process.execPath,
        ["--unhandled-rejections=strict", "--input-type=module", "-e", code],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      ),
      /strict-rejection-check-passed/,
    );
  });
}
