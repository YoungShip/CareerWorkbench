'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveArtifactPath}=require('../lib/artifact-paths');
test('legacy resolution only maps missing artifacts within the exact old sibling directory',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'career-path-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const project=path.join(base,'CareerWorkbench');fs.mkdirSync(path.join(project,'data'),{recursive:true});
 const current=path.join(project,'data','matching.json');fs.writeFileSync(current,'{}');
 const old=path.join(base,'JobHuntBot','data','matching.json');
 assert.equal(resolveArtifactPath(old,project),current);
 assert.equal(resolveArtifactPath('relative/matching.json',project),'relative/matching.json');
 const outside=path.join(base,'unrelated','JobHuntBot','data','matching.json');assert.equal(resolveArtifactPath(outside,project),outside);
 fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'original');assert.equal(resolveArtifactPath(old,project),old);
});
