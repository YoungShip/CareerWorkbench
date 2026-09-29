const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDiscoveryStore}=require('./store');
const {inspectResearch,verifyResearch}=require('./research');
const {writeV2Fixture,legacyRecord}=require('./v2-fixture');
const runtime={python:process.env.JOBHUNT_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),verifier:path.resolve(__dirname,'../../.agents/skills/campus-recruitment/scripts/verify-matching.py')};
function setup(t,{record}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-research-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const matching_file=path.join(root,'matching.json'),research_file=path.join(root,'report.md');
 const matching=record||writeV2Fixture(root);
 fs.writeFileSync(matching_file,JSON.stringify(matching));fs.writeFileSync(research_file,`${matching.company} ${matching.date} report`);
 const store=createDiscoveryStore(path.join(root,'state'),{researchValidator:(op,lead)=>verifyResearch(op,lead,runtime),knownMatches:()=>[{source:'already researched profile'}]});
 const lead={lead_id:'example',company:'Fixture Company Ltd',aliases:['Fixture Company'],source_urls:['https://example.com'],official_url:'https://example.com',state:'discovered',evidence_summary:'Found',open_questions:['JD']};
 fs.writeFileSync(path.join(root,'state','leads.json'),JSON.stringify({schema_version:2,leads:[lead],runs:[],active_run_id:''}));
 const op={type:'research.complete',run_id:'r',lead_id:'example',matching_file,research_file,evidence_summary:'Research complete',open_questions:['Quota unverified']};
 op.expected_hashes=inspectResearch(op).hashes;
 const plan=()=>({expected_revision:store.snapshot().revision,operations:[{type:'run.start',run_id:'r'},op,{type:'run.finish',run_id:'r',summary:'Done',next_steps:['Choose job']}]});
 return {root,matching,store,op,plan};
}
test('validated result bypasses new-company dedup; preview leaves files unchanged and apply preserves questions',t=>{
 const f=setup(t),before=f.store.snapshot().revision,raw=fs.readFileSync(f.op.matching_file,'utf8');
 assert.equal(f.store.execute(f.plan(),true).decisions[0].decision,'research_completed');assert.equal(f.store.snapshot().revision,before);
 assert.equal(fs.readFileSync(f.op.matching_file,'utf8'),raw);assert.equal(fs.existsSync(path.join(f.root,'matching-verification.json')),false);
 f.store.execute(f.plan());const s=f.store.snapshot();assert.equal(s.leads[0].state,'researched');assert.equal(s.runs[0].research_count,1);assert.deepEqual(s.leads[0].open_questions,['Quota unverified']);assert.equal(s.leads[0].research_evidence.validation.passed,true);
 // 研究完成必须带上新版 readiness，消费者据此判断，而不是只看退出码
 assert.equal(s.leads[0].research_evidence.readiness.status,'ready_for_human_review');assert.deepEqual(s.leads[0].research_evidence.readiness.registerable_position_ids,['role-1']);
});
test('evidence snapshots survive isolated validation; discovery agrees with direct verification',t=>{
 const f=setup(t),op={...f.op};
 const evidence=inspectResearch(op);
 // 证据依赖必须进入隔离校验，且被纳入哈希
 assert.ok(Object.keys(evidence.hashes).some(k=>k.startsWith('evidence:')),'证据快照应纳入哈希');
 const out=verifyResearch(op,{company:'Fixture Company',aliases:[]},runtime);
 assert.equal(out.validation.passed,true);
 assert.equal(out.validation.checks.evidence_consistency,'passed');
 assert.deepEqual(out.readiness.registerable_position_ids,['role-1']);
 // 隔离目录已清理，原始目录不被写入校验报告
 assert.equal(fs.existsSync(path.join(f.root,'matching-verification.json')),false);
});
test('legacy schema-1 matching cannot be upgraded to verified research',t=>{
 const f=setup(t);
 // 旧式记录：无 schema_version，只有 catalog/positions 的旧字段
 const legacy=legacyRecord();
 fs.writeFileSync(path.join(f.root,'catalog.json'),JSON.stringify([{id:'job1'}]));
 fs.writeFileSync(f.op.matching_file,JSON.stringify(legacy));
 f.op.expected_hashes=inspectResearch(f.op).hashes;
 const before=f.store.snapshot().revision;
 assert.throws(()=>f.store.execute(f.plan()),/Matching validation failed/);
 assert.equal(f.store.snapshot().revision,before);
 assert.equal(f.store.snapshot().leads[0].state,'discovered','旧记录不得被标记为已研究');
});
test('missing evidence snapshot is rejected with readiness detail, not silently passed',t=>{
 const f=setup(t);
 const record=writeV2Fixture(f.root);
 record.positions[0].jd_source.snapshot_file='absent-jd.txt';
 fs.writeFileSync(f.op.matching_file,JSON.stringify(record));
 f.op.expected_hashes=inspectResearch(f.op).hashes;
 let error=null;try{f.store.execute(f.plan());}catch(e){error=e;}
 assert.ok(error,'缺证据快照必须拒绝');
 assert.match(error.message,/Matching validation failed/);
 assert.equal(f.store.snapshot().leads[0].state,'discovered');
});
test('changed report, matching or catalog cannot reuse prepared hashes',t=>{
 for(const key of ['research_file','matching_file','catalog_file']){const f=setup(t),file=inspectResearch(f.op).files[key];fs.appendFileSync(file,' ');const before=f.store.snapshot().revision;assert.throws(()=>f.store.execute(f.plan()),/artifacts changed/);assert.equal(f.store.snapshot().revision,before);}
});
test('changed evidence snapshot cannot reuse prepared hashes',t=>{
 const f=setup(t),evidence=inspectResearch(f.op);
 const key=Object.keys(evidence.files).find(k=>k.startsWith('evidence:'));
 fs.appendFileSync(evidence.files[key],' 变更');
 const before=f.store.snapshot().revision;
 assert.throws(()=>f.store.execute(f.plan()),/artifacts changed/);
 assert.equal(f.store.snapshot().revision,before);
});
test('evidence path escaping the record directory is rejected',t=>{
 const f=setup(t);
 const record=writeV2Fixture(f.root);
 record.positions[0].jd_source.snapshot_file='../../outside-jd.txt';
 fs.writeFileSync(f.op.matching_file,JSON.stringify(record));
 assert.throws(()=>inspectResearch(f.op),/escapes/);
 const before=f.store.snapshot().revision;
 assert.throws(()=>f.store.execute(f.plan()));
 assert.equal(f.store.snapshot().revision,before);
});
test('evidence path colliding with reserved verification files is rejected',t=>{
 const f=setup(t);
 const record=writeV2Fixture(f.root);
 record.positions[0].jd_source.snapshot_file='matching-verification.json';
 fs.writeFileSync(f.op.matching_file,JSON.stringify(record));
 assert.throws(()=>inspectResearch(f.op),/reserved/);
});
test('fresh validator rejects invalid matching even with updated hashes and a forged old pass file',t=>{
 const f=setup(t);f.matching.positions=[];fs.writeFileSync(f.op.matching_file,JSON.stringify(f.matching));fs.writeFileSync(path.join(f.root,'matching-verification.json'),JSON.stringify({passed:true}));f.op.expected_hashes=inspectResearch(f.op).hashes;
 assert.throws(()=>f.store.execute(f.plan()),/validation failed/);assert.equal(f.store.snapshot().leads[0].state,'discovered');
});
test('company mismatch, missing lead and stale revision fail closed',t=>{
 const f=setup(t);f.matching.company='Wrong';fs.writeFileSync(f.op.matching_file,JSON.stringify(f.matching));f.op.expected_hashes=inspectResearch(f.op).hashes;assert.throws(()=>f.store.execute(f.plan()),/company/);
 f.op.lead_id='missing';assert.throws(()=>f.store.execute(f.plan()),/non-excluded/);
 const p=f.plan();p.expected_revision='old';assert.throws(()=>f.store.execute(p),/Revision/);
});
test('excluded lead is not silently reopened',t=>{
 const f=setup(t),file=path.join(f.root,'state','leads.json'),s=JSON.parse(fs.readFileSync(file));s.leads[0].state='excluded';fs.writeFileSync(file,JSON.stringify(s));assert.throws(()=>f.store.execute(f.plan()),/non-excluded/);
});
test('repeating same result counts once and third company rejects entire transaction',t=>{
 const f=setup(t);f.store.execute({expected_revision:f.store.snapshot().revision,operations:[{type:'run.start',run_id:'r'},f.op,f.op]});assert.equal(f.store.snapshot().runs[0].research_count,1);
 const file=path.join(f.root,'state','leads.json'),s=JSON.parse(fs.readFileSync(file));
 s.leads.push({...s.leads[0],lead_id:'two',company:'Two',aliases:[],state:'discovered'},{...s.leads[0],lead_id:'three',company:'Three',aliases:[],state:'discovered'});fs.writeFileSync(file,JSON.stringify(s));
 const ops=['Two','Three'].map(company=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-two-'));const matching=writeV2Fixture(dir,{company});const matching_file=path.join(dir,'matching.json'),research_file=path.join(dir,'report.md');fs.writeFileSync(matching_file,JSON.stringify(matching));fs.writeFileSync(research_file,`${company} 2026-01-01`);const op={...f.op,lead_id:company.toLowerCase(),matching_file,research_file};op.expected_hashes=inspectResearch(op).hashes;return op;});
 const before=f.store.snapshot().revision;assert.throws(()=>f.store.execute({expected_revision:before,operations:ops}),/limit/);assert.equal(f.store.snapshot().revision,before);
});

function registration(t){
 const f=setup(t),file=path.join(f.root,'state','leads.json');
 const s=JSON.parse(fs.readFileSync(file));const lead=s.leads.pop();fs.writeFileSync(file,JSON.stringify(s));
 f.op.type='research.register';f.op.lead=lead;f.op.registration_reason='Existing report predates discovery entry';return f;
}
test('explicit registration validates known company atomically without counting as new discovery',t=>{
 const f=registration(t),before=f.store.snapshot().revision;
 f.store.execute(f.plan(),true);assert.equal(f.store.snapshot().revision,before);assert.equal(f.store.snapshot().leads.length,0);
 f.store.execute(f.plan());const s=f.store.snapshot();assert.equal(s.leads[0].state,'researched');assert.equal(s.runs[0].research_count,1);assert.equal(s.runs[0].new_count,0);assert.equal(s.leads[0].research_registration.known_matches.length,1);
 const retry={expected_revision:s.revision,operations:[{type:'run.start',run_id:'retry'},{...f.op,run_id:'retry'}]};assert.throws(()=>f.store.execute(retry),/already exists/);assert.equal(f.store.snapshot().revision,s.revision);
});
test('registration rejects invalid evidence and malformed source metadata without persisting lead',t=>{
 for(const kind of ['hash','matching','source','reason']){
  const f=registration(t),before=f.store.snapshot().revision;
  if(kind==='hash')f.op.expected_hashes={};
  if(kind==='matching'){f.matching.positions=[];fs.writeFileSync(f.op.matching_file,JSON.stringify(f.matching));f.op.expected_hashes=inspectResearch(f.op).hashes;}
  if(kind==='source')f.op.lead.source_urls=['invalid'];
  if(kind==='reason')f.op.registration_reason='';
  assert.throws(()=>f.store.execute(f.plan()));assert.equal(f.store.snapshot().revision,before);
 }
});
test('registration rejects conflicting aliases and excluded identities',t=>{
 const f=setup(t);f.op.type='research.register';f.op.registration_reason='Backfill';
 f.op.lead={lead_id:'different-id',company:'Fixture Company',aliases:[],source_urls:['https://example.com']};f.op.lead_id='different-id';
 assert.throws(()=>f.store.execute(f.plan()),/identity conflict/);
 f.op.lead_id='example';f.op.lead.lead_id='example';assert.throws(()=>f.store.execute(f.plan()),/already exists/);
});
test('research inspection reports exact company/date metadata before transaction preview',t=>{
 const f=setup(t);fs.writeFileSync(f.op.research_file,'泛化报告，没有精确公司与日期','utf8');
 const inspected=inspectResearch(f.op);assert.equal(inspected.report_metadata.status,'failed');
 assert.deepEqual(inspected.report_metadata.missing,['company','date']);assert.match(inspected.report_metadata.header_template,/公司：Fixture Company/);
 f.op.expected_hashes=inspected.hashes;
 assert.throws(()=>verifyResearch(f.op,{company:'Fixture Company',aliases:[]},runtime),/Report metadata mismatch/);
});