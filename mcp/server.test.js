const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {createStore}=require('../dashboard/store');
const {createServer}=require('./server');
const {canonical}=require('./tools');

test('auxiliary-only writes do not claim that jobs entered the sync queue',()=>{
 const {createToolHandlers}=require('./tools');
 const service={store:{commit:()=>({changed_jobs:[],counts:{resume_rules:1}})}};
 const handlers=createToolHandlers({service,tokens:{verify(){}}});
 const result=handlers.apply({plan:{operations:[{type:'table.upsert',table:'resume_rules'}]},preview_token:'fixture'});
 assert.equal(result.readback,null);
 assert.match(result.sync,/未新增岗位同步项/);
 assert.doesNotMatch(result.sync,/已进入 sync_queue/);
});

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-mcp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dataDir=path.join(dir,'dashboard');fs.mkdirSync(dataDir);
 createStore(dataDir).initialize({job_pool:[{job_id:'j1',company:'Company',job_title:'Title',status:'Pending'}],application_log:[],follow_up:[],sync_queue:[]});
 const rulesFile=path.join(dir,'rules.md');fs.writeFileSync(rulesFile,'## 选岗规则\n只投江浙沪\n## 经历与表述边界\n不编造经历\n');
 return {dir,dataDir,options:{dataDir,rulesFile,discoveryDir:path.join(dir,'discovery'),policyFile:path.join(dir,'missing-policy.json')}};
}
async function connect(t,options){
 const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
 const server=createServer(options),client=new Client({name:'test',version:'0'});
 await server.connect(serverSide);await client.connect(clientSide);
 t.after(()=>client.close());
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});return {error:r.isError?r.content[0].text:null,data:r.isError?null:JSON.parse(r.content[0].text)};};
 return {client,call};
}
const patchPlan=(revision,notes)=>({expected_revision:revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes}}]});

test('tools are listed with read-only and destructive annotations',async t=>{
 const {client}=await connect(t,fixture(t).options);
 const {tools}=await client.listTools();const byName=Object.fromEntries(tools.map(x=>[x.name,x]));
 assert.deepEqual(Object.keys(byName).sort(),['discovery_next','discovery_query','tracker_apply','tracker_brief','tracker_preview','tracker_query','tracker_rules','tracker_validate']);
 for(const name of Object.keys(byName).filter(n=>n!=='tracker_apply'))assert.equal(byName[name].annotations.readOnlyHint,true,name);
 assert.equal(byName.tracker_apply.annotations.destructiveHint,true);
 assert.deepEqual(byName.tracker_apply.inputSchema.required.sort(),['plan','preview_token']);
});

test('read tools reuse the store, rules source and discovery views',async t=>{
 const {call}=await connect(t,fixture(t).options);
 const q=await call('tracker_query',{job_ids:['j1'],fields:['job_id','status']});
 assert.deepEqual(q.data.jobs,[{job_id:'j1',status:'Pending'}]);
 assert.equal((await call('tracker_validate')).data.revision,q.data.revision);
 const rules=await call('tracker_rules');assert.equal(rules.data.selection_rules,'只投江浙沪');assert.equal(rules.data.evidence_boundaries,'不编造经历');
 assert.ok(Array.isArray((await call('tracker_brief',{limit:3})).data.next_steps));
 assert.equal((await call('discovery_next')).error,null);
 assert.match((await call('tracker_query',{fields:['no_such_field']})).error,/Unknown job field/);
});

test('apply is refused without a preview token and leaves data untouched',async t=>{
 const f=fixture(t),{call}=await connect(t,f.options);
 const before=(await call('tracker_validate')).data.revision;
 assert.match((await call('tracker_apply',{plan:patchPlan(before,'x'),preview_token:''})).error,/preview_token/);
 assert.match((await call('tracker_apply',{plan:patchPlan(before,'x'),preview_token:Date.now()+'.'+'0'.repeat(64)})).error,/does not match/);
 assert.equal(createStore(f.dataDir).snapshot().revision,before);
});

test('preview then apply writes once, reads back changed fields and queues sync',async t=>{
 const f=fixture(t),{call}=await connect(t,f.options);
 const plan=patchPlan((await call('tracker_validate')).data.revision,'笔试已完成');
 const preview=await call('tracker_preview',{plan});
 assert.deepEqual(preview.data.changed_jobs,['j1']);
 assert.equal(createStore(f.dataDir).snapshot().revision,plan.expected_revision,'preview must not write');
 // 字段顺序不同但内容相同的计划仍被视为同一份计划
 const reordered={operations:[{patch:{notes:'笔试已完成'},job_id:'j1',type:'job.patch'}],expected_revision:plan.expected_revision};
 assert.equal(canonical(reordered),canonical(plan));
 const applied=await call('tracker_apply',{plan:reordered,preview_token:preview.data.preview_token});
 assert.equal(applied.error,null);
 assert.deepEqual(applied.data.readback.jobs,[{job_id:'j1',company:'Company',job_title:'Title',status:'Pending',notes:'笔试已完成'}]);
 const snap=createStore(f.dataDir).snapshot();
 assert.equal(snap.tables.sync_queue.find(q=>q.job_id==='j1').state,'pending');
 // 同一令牌重放：计划里的 expected_revision 已过期，被主表乐观锁拒绝
 assert.match((await call('tracker_apply',{plan,preview_token:preview.data.preview_token})).error,/Revision conflict/);
});

test('token is bound to the exact plan and expires',async t=>{
 const f=fixture(t);let clock=1_000_000;
 const {call}=await connect(t,{...f.options,now:()=>clock});
 const plan=patchPlan((await call('tracker_validate')).data.revision,'A');
 const {preview_token}=(await call('tracker_preview',{plan})).data;
 assert.match((await call('tracker_apply',{plan:patchPlan(plan.expected_revision,'B'),preview_token})).error,/does not match this plan/);
 clock+=10*60*1000+1;
 assert.match((await call('tracker_apply',{plan,preview_token})).error,/expired/);
 assert.equal(createStore(f.dataDir).snapshot().tables.job_pool[0].notes??'','');
});

test('intervening write invalidates an outstanding preview',async t=>{
 const f=fixture(t),{call}=await connect(t,f.options);
 const plan=patchPlan((await call('tracker_validate')).data.revision,'mine');
 const {preview_token}=(await call('tracker_preview',{plan})).data;
 const other=createStore(f.dataDir);other.commit(patchPlan(other.snapshot().revision,'someone else'));
 assert.match((await call('tracker_apply',{plan,preview_token})).error,/Revision conflict/);
 assert.equal(createStore(f.dataDir).snapshot().tables.job_pool[0].notes,'someone else');
});

test('high-risk operations and extra plan fields are rejected before touching the store',async t=>{
 const f=fixture(t),{call}=await connect(t,f.options);
 const revision=(await call('tracker_validate')).data.revision;
 assert.match((await call('tracker_preview',{plan:{expected_revision:revision,operations:[{type:'job.delete',job_id:'j1',reason:'x'}]}})).error,/not available via MCP/);
 assert.match((await call('tracker_preview',{plan:{expected_revision:revision,operations:[{type:'sync.ack',job_id:'j1',change_id:'c'}]}})).error,/not available via MCP/);
 assert.ok((await call('tracker_preview',{plan:{...patchPlan(revision,'x'),runtime:{python:'evil'}}})).error);
 assert.ok((await call('tracker_preview',{plan:{expected_revision:revision,operations:[]}})).error);
 assert.equal(createStore(f.dataDir).snapshot().revision,revision);
});

test('stdio entrypoint serves tools against the configured data directory',async t=>{
 const f=fixture(t);
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'server.js')],env:{...process.env,JOBHUNT_DATA_DIR:f.dataDir,JOBHUNT_DISCOVERY_DIR:f.options.discoveryDir},stderr:'pipe'});
 const client=new Client({name:'stdio-test',version:'0'});await client.connect(transport);t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,8);
 const r=await client.callTool({name:'tracker_query',arguments:{job_ids:['j1'],fields:['job_id']}});
 assert.deepEqual(JSON.parse(r.content[0].text).jobs,[{job_id:'j1'}]);
});
