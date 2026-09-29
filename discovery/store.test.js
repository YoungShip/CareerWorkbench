const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDiscoveryStore}=require('./store');
const lead=(id='one',company='Example')=>({lead_id:id,company,aliases:[company+' Ltd'],source_urls:['https://example.com/campus'],official_url:'https://example.com/',state:'discovered',evidence_summary:'Official campus entry found; details unverified',open_questions:['Full catalog and eligibility'],research_file:'',matching_file:''});
function fixture(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=createDiscoveryStore(root,options);const apply=operations=>store.execute({expected_revision:store.snapshot().revision,operations});return {root,store,apply};}
const start={type:'run.start',run_id:'r'};
const upsert=l=>({type:'lead.upsert',run_id:'r',lead:l});

test('Latin company aliases do not match arbitrary substrings of technical terms',()=>{
 const {mentions}=require('./store');assert.equal(mentions('FastAPI TestClient','TCL'),false);assert.equal(mentions('| TCL | 已研究','tcl'),true);assert.equal(mentions('TCL集团2027校招','TCL'),true);assert.equal(mentions('苏州盛科通信股份有限公司','盛科通信'),true);
});

test('legacy leads survive migration, aliases merge and preview is read-only',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'leads.json'),JSON.stringify({schema_version:1,leads:[lead()]}));const before=fs.readFileSync(path.join(f.root,'leads.json'),'utf8');
 const plan={expected_revision:f.store.snapshot().revision,operations:[start,upsert({...lead('other','Example Ltd'),aliases:['Example'],source_urls:['https://example.com/new']})]};
 assert.equal(f.store.execute(plan,true).decisions[0].decision,'updated_existing');assert.equal(fs.readFileSync(path.join(f.root,'leads.json'),'utf8'),before);
 const result=f.store.execute(plan);const s=f.store.snapshot();assert.equal(s.leads.length,1);assert.equal(s.leads[0].lead_id,'one');assert.equal(s.leads[0].source_urls.length,2);assert.equal(fs.readFileSync(result.backup,'utf8'),before);
});
test('known companies are recorded as skipped without entering lead pool',t=>{
 const f=fixture(t,{knownMatches:l=>l.company==='Known'?[{source:'profile',line:4}]:[]});f.apply([start,upsert(lead('known','Known'))]);const s=f.store.snapshot();assert.equal(s.leads.length,0);assert.equal(s.runs[0].decisions[0].decision,'known_company');
});
test('stale revisions and overlapping runs cannot discard previous progress',t=>{
 const f=fixture(t),old=f.store.snapshot().revision;f.apply([start,upsert(lead())]);const s=f.store.snapshot();assert.throws(()=>f.store.execute({expected_revision:old,operations:[start]}),/Revision/);assert.throws(()=>f.apply([{type:'run.start',run_id:'another'}]),/Unfinished/);assert.equal(f.store.snapshot().revision,s.revision);
});
test('paused run reloads its checkpoint in a new instance and resumes to completion',t=>{
 const f=fixture(t);f.apply([start,upsert(lead()),{type:'run.pause',run_id:'r',summary:'Saved source one',next_steps:['Review source two']}]);
 const recovered=createDiscoveryStore(f.root),s=recovered.snapshot();assert.equal(s.runs[0].status,'paused');assert.deepEqual(s.runs[0].next_steps,['Review source two']);
 assert.throws(()=>f.apply([upsert(lead('two','Other'))]),/paused/);
 recovered.execute({expected_revision:s.revision,operations:[{type:'run.resume',run_id:'r'},upsert(lead('two','Other')),{type:'run.finish',run_id:'r',summary:'Two leads saved',next_steps:['Full research']} ]});
 const done=recovered.snapshot();assert.equal(done.leads.length,2);assert.equal(done.active_run_id,'');assert.equal(done.runs[0].status,'completed');
});
test('failed replacement leaves original checkpoint intact and recoverable',t=>{
 const f=fixture(t);f.apply([start]);const before=f.store.snapshot();const broken=createDiscoveryStore(f.root,{beforeReplace:()=>{throw Error('Simulated interruption');}});
 assert.throws(()=>broken.execute({expected_revision:before.revision,operations:[upsert(lead())]}),/interruption/);assert.equal(createDiscoveryStore(f.root).snapshot().revision,before.revision);
 assert.ok(!fs.existsSync(path.join(f.root,'.lock')));f.apply([upsert(lead())]);assert.equal(f.store.snapshot().leads.length,1);
});
test('caps and source failure limits persist across checkpoints',t=>{
 const f=fixture(t);f.apply([start,...Array.from({length:10},(_,i)=>upsert(lead('lead'+i,'Company '+i)))]);const before=f.store.snapshot().revision;
 assert.throws(()=>f.apply([upsert(lead('eleven','Eleven'))]),/limit/);assert.equal(f.store.snapshot().revision,before);
 const error={type:'source.record',run_id:'r',url:'https://example.com/failure',outcome:'error',summary:'No response'};f.apply([error,error]);assert.throws(()=>f.apply([error]),/retry limit/);assert.equal(f.store.snapshot().runs[0].sources.length,2);
});
test('discovery cannot invent research completion or repurpose an existing identity',t=>{
 const f=fixture(t);f.apply([start,upsert(lead())]);const before=f.store.snapshot().revision;
 assert.throws(()=>f.apply([upsert({...lead(),state:'researched'})]),/research workflow/);
 assert.throws(()=>f.apply([upsert({...lead(),company:'Unrelated',aliases:[]})]),/reused/);assert.equal(f.store.snapshot().revision,before);
});

test('live write lock blocks another instance without altering the file',t=>{
 const f=fixture(t);f.apply([start]);const before=fs.readFileSync(path.join(f.root,'leads.json'),'utf8'),lock=path.join(f.root,'.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
 assert.throws(()=>createDiscoveryStore(f.root).snapshot(),/Another discovery writer/);assert.equal(fs.readFileSync(path.join(f.root,'leads.json'),'utf8'),before);fs.rmSync(lock,{recursive:true});assert.equal(f.store.snapshot().active_run_id,'r');
});

test('rediscovery preserves researched or excluded leads even when external index is absent',t=>{
 for(const state of ['researched','researching','excluded']){
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'leads.json'),JSON.stringify({schema_version:2,leads:[{...lead(),state,research_file:'kept.md'}],runs:[],active_run_id:''}));
  f.apply([start,upsert({...lead('alias','Example Ltd'),aliases:[]})]);const s=f.store.snapshot();assert.equal(s.leads.length,1);assert.equal(s.leads[0].state,state);assert.equal(s.leads[0].research_file,'kept.md');assert.equal(s.runs[0].decisions[0].decision,'existing_disposition');assert.equal(s.runs[0].new_count,0);
 }
});
