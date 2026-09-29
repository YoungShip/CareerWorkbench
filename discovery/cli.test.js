const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const CLI=path.join(__dirname,'cli.js');
const {writeV2Fixture}=require('./v2-fixture');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-discovery-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state={schema_version:2,updated_at:'2026-09-20T00:00:00Z',active_run_id:'',runs:[],leads:[{lead_id:'one',company:'Fixture Co',aliases:[],source_urls:['https://example.com/jobs'],official_url:'https://example.com/jobs',state:'discovered',evidence_summary:'官方网申截止 2026-09-21',open_questions:['完整JD'],discovered_at:'2026-09-19T00:00:00Z',last_checked_at:'2026-09-19T00:00:00Z'}]};
 fs.writeFileSync(path.join(root,'leads.json'),JSON.stringify(state),{encoding:'utf8'});return root;
}

test('query and next support atomic UTF-8 output',t=>{
 const root=fixture(t),out=path.join(root,'next.json'),env={...process.env,JOBHUNT_DISCOVERY_DIR:root};
 const receipt=JSON.parse(execFileSync(process.execPath,[CLI,'next','--limit=3','--out',out],{env,encoding:'utf8'}));
 assert.equal(path.resolve(receipt.file),path.resolve(out));
 const bytes=fs.readFileSync(out);assert.notEqual(bytes[0],0xef);const value=JSON.parse(bytes.toString('utf8'));
 assert.equal(value.deadline_attention.total,1);assert.equal(value.deadline_attention.items[0].confirmed,false);
 const query=JSON.parse(execFileSync(process.execPath,[CLI,'query','--state=discovered','--fields=lead_id,company'],{env,encoding:'utf8'}));
 assert.deepEqual(query.leads,[{lead_id:'one',company:'Fixture Co'}]);
});

test('invalid structured deadline fails closed',t=>{
 const root=fixture(t),file=path.join(root,'leads.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));state.leads[0].deadline='2026-02-30';fs.writeFileSync(file,JSON.stringify(state));
 const result=spawnSync(process.execPath,[CLI,'snapshot'],{env:{...process.env,JOBHUNT_DISCOVERY_DIR:root},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/deadline/);
});
test('research-inspect returns a report header template before preview',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-inspect-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const matching=writeV2Fixture(root),matching_file=path.join(root,'matching.json'),research_file=path.join(root,'report.md'),input=path.join(root,'input.json'),out=path.join(root,'inspect.json');
 fs.writeFileSync(matching_file,JSON.stringify(matching));fs.writeFileSync(research_file,'wrong metadata');fs.writeFileSync(input,JSON.stringify({matching_file,research_file}));
 const result=spawnSync(process.execPath,[CLI,'research-inspect',input,'--out',out],{encoding:'utf8'});
 assert.notEqual(result.status,0);const report=JSON.parse(fs.readFileSync(out,'utf8'));
 assert.equal(report.ready_for_plan,false);assert.deepEqual(report.report_metadata.missing,['company','date']);assert.match(report.report_metadata.header_template,/Fixture Company/);
});