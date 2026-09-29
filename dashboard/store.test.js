const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore,parseCSV,csv}=require('./store');
test('failed sync remains retryable; acknowledgment cannot clear newer edits',t=>{
 const {store}=fixture(t);const edit=notes=>store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes}}]});
 edit('first');const change=store.snapshot().tables.sync_queue[0].change_id;
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'sync.ack',job_id:'j1',change_id:change,error:'Network failed'}]});
 assert.equal(store.snapshot().tables.sync_queue[0].state,'error');edit('newer');
 assert.throws(()=>store.commit({expected_revision:store.snapshot().revision,operations:[{type:'sync.ack',job_id:'j1',change_id:change}]}),/stale/);
 assert.equal(store.snapshot().tables.sync_queue[0].state,'pending');
});
test('backup restores all tables into an isolated store',t=>{
 const {store,dir}=fixture(t);const before=store.snapshot();
 const result=store.commit({expected_revision:before.revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'new'}}]});
 const restored=path.join(dir,'restored');fs.mkdirSync(restored);
 for(const name of fs.readdirSync(result.backup))fs.copyFileSync(path.join(result.backup,name),path.join(restored,name));
 assert.deepEqual(createStore(restored).snapshot(),before);
});
test('explicit history deletion requires exact IDs and retains recoverable backup',t=>{
 const {store}=fixture(t);
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'log.add',job_id:'j1',log_id:'l1',record:{status:'Submitted',submission_evidence:'User confirmed'}},{type:'event.add',job_id:'j1',event_id:'e1',record:{date:'2026-09-15',event_type:'Test'}},{type:'job.add',job_id:'j2',registration:'manual',registration_reason:'Fixture lead entry',record:{company:'Other',job_title:'Other',status:'Pending'}}]});
 const before=store.snapshot(), op={type:'job.delete',job_id:'j1',reason:'User explicitly requested deletion'};
 assert.throws(()=>store.commit({expected_revision:before.revision,operations:[op]}),/exact history archive/);
 Object.assign(op,{archive_history:true,expected_log_ids:['wrong'],expected_event_ids:['e1']});
 assert.throws(()=>store.commit({expected_revision:before.revision,operations:[op]}),/exact history archive/);
 op.expected_log_ids=['l1'];
 store.commit({expected_revision:before.revision,operations:[op]},true);
 assert.equal(store.snapshot().revision,before.revision);
 const result=store.commit({expected_revision:before.revision,operations:[op]});
 const after=store.snapshot();
 assert.deepEqual(after.tables.job_pool.map(r=>r.job_id),['j2']);
 assert.equal(after.tables.application_log.length,0);assert.equal(after.tables.follow_up.length,0);
 assert.equal(parseCSV(fs.readFileSync(path.join(result.backup,'application_log.csv'),'utf8')).rows[0].log_id,'l1');
});
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createStore(dir,options);store.initialize({job_pool:[{job_id:'j1',company:'Company',job_title:'Title',status:'Pending'}],application_log:[],follow_up:[],sync_queue:[]});return {dir,store};}
test('CSV roundtrip preserves Chinese, quotes, commas and multiline JD',()=>{const table={header:['id','text'],rows:[{id:'1',text:'职责："测试",接口\n第二行'}]};assert.deepEqual(parseCSV(csv(table)),table);});
test('stale writes rejected without changing data; stable identity cannot be duplicated',t=>{const {store}=fixture(t);const before=store.snapshot();store.commit({expected_revision:before.revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'new'}}]});assert.throws(()=>store.commit({expected_revision:before.revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'stale'}}]}),/Revision conflict/);const now=store.snapshot();assert.equal(now.tables.job_pool[0].notes,'new');assert.throws(()=>store.commit({expected_revision:now.revision,operations:[{type:'job.add',job_id:'j1',record:{company:'Company',job_title:'Title',status:'Pending'}}]}),/already exists/);assert.equal(store.snapshot().revision,now.revision);});

test('same-title positions warn without merging; remote identities remain unique and events stay linked',t=>{
 const {store}=fixture(t);
 const plan={expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{offernotes_id:'p1'}},{type:'event.add',job_id:'j1',event_id:'e1',record:{date:'2026-09-15',event_type:'Interview'}},{type:'job.add',job_id:'j2',registration:'manual',registration_reason:'Fixture lead entry',record:{company:'Company',job_title:'Title',status:'Pending',location:'北京',job_url:'https://example.com/job/B',notes:'官方岗位编号 B'}}]};
 const preview=store.commit(plan,true);assert.deepEqual(preview.warnings[0].job_ids,['j1','j2']);assert.equal(store.snapshot().tables.job_pool.length,1);
 store.commit(plan);let snap=store.snapshot();assert.equal(snap.tables.job_pool.length,2);assert.equal(snap.warnings[0].code,'possible_duplicate_jobs');
 assert.throws(()=>store.commit({expected_revision:snap.revision,operations:[{type:'sync.ack',job_id:'j2',change_id:snap.tables.sync_queue.find(q=>q.job_id==='j2').change_id,offernotes_id:'p1'}]}),/Duplicate OfferNotes ID/);
 assert.equal(store.snapshot().revision,snap.revision);
 store.commit({expected_revision:snap.revision,operations:[{type:'job.patch',job_id:'j2',patch:{job_title:'Renamed'}}]});snap=store.snapshot();assert.equal(snap.warnings.length,0);assert.equal(snap.tables.follow_up[0].job_id,'j1');assert.equal(snap.tables.follow_up[0].job_title,'Title');
});
test('submission needs evidence; calendar additions preserve existing records and stable links',t=>{const {store}=fixture(t);let snap=store.snapshot();assert.throws(()=>store.commit({expected_revision:snap.revision,operations:[{type:'job.patch',job_id:'j1',patch:{status:'Submitted'}}]}),/evidence/);store.commit({expected_revision:snap.revision,operations:[{type:'job.patch',job_id:'j1',patch:{status:'Submitted',application_date:'2026-09-13'}},{type:'log.add',job_id:'j1',log_id:'l1',record:{status:'Submitted',submission_evidence:'User confirmed',job_description:'Full JD'}}]});for(const n of [1,2])store.commit({expected_revision:store.snapshot().revision,operations:[{type:'event.add',job_id:'j1',event_id:'e'+n,record:{date:'2026-09-15',time:'17:10',event_type:'Test '+n}}]});store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{job_title:'Renamed'}}]});snap=store.snapshot();assert.equal(snap.tables.follow_up.length,2);assert.equal(snap.tables.application_log[0].job_description,'Full JD');assert.equal(snap.tables.follow_up[0].job_title,'Renamed');assert.equal(snap.tables.sync_queue.length,1);assert.equal(snap.tables.sync_queue[0].state,'pending');});
test('preview makes no changes; reinitialization and invalid dates rejected',t=>{const {store}=fixture(t);const snap=store.snapshot();store.commit({expected_revision:snap.revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'preview only'}}]},true);assert.equal(store.snapshot().revision,snap.revision);assert.throws(()=>store.initialize({}),/Already migrated/);assert.throws(()=>store.commit({expected_revision:snap.revision,operations:[{type:'event.add',job_id:'j1',record:{date:'2026-02-30',event_type:'Invalid'}}]}),/date/);});
test('unfinished transaction rolls back from backup on next read',t=>{const {dir,store}=fixture(t);const snap=store.snapshot();store.commit({expected_revision:snap.revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'committed'}}]});const committed=store.snapshot();const backup=path.join(dir,'.store','test-backup');fs.mkdirSync(backup);for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.csv')))fs.copyFileSync(path.join(dir,name),path.join(backup,name));fs.writeFileSync(path.join(dir,'.store','journal.json'),JSON.stringify({backup}));fs.writeFileSync(path.join(dir,'job_pool.csv'),'broken');assert.equal(store.snapshot().revision,committed.revision);});
test('live lock prevents overlapping writers and stale sync acknowledgments fail',t=>{const {dir,store}=fixture(t);const lock=path.join(dir,'.store','lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));assert.throws(()=>store.snapshot(),/Another process/);fs.rmSync(lock,{recursive:true});store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'queued'}}]});assert.throws(()=>store.commit({expected_revision:store.snapshot().revision,operations:[{type:'sync.ack',job_id:'j1',change_id:'stale'}]}),/stale/);});

// ---- 新研究岗位登记许可（对应审阅第三节的调用方约束）----
const {writeV2Fixture}=require('../discovery/v2-fixture');
const RUNTIME={python:process.env.JOBHUNT_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),verifier:path.resolve(__dirname,'../../.agents/skills/campus-recruitment/scripts/verify-matching.py')};
function researchFixture(t){
 const {dir,store}=fixture(t,{runtime:RUNTIME});
 const research=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-register-'));t.after(()=>fs.rmSync(research,{recursive:true,force:true}));
 const matching=writeV2Fixture(research,{company:'Fixture Company'});
 const matchingFile=path.join(research,'matching.json');fs.writeFileSync(matchingFile,JSON.stringify(matching));
 return {dir,store,research,matching,matchingFile};
}
const add=(store,extra)=>store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.add',job_id:extra.job_id??'role-1',...extra}]});

test('unverified new position cannot enter the standard pending path',t=>{
 const {store}=fixture(t);const before=store.snapshot();
 // 无 registration 声明：拒绝（这正是审阅中"仅靠调用方自觉"的缺口）
 assert.throws(()=>add(store,{registration:'manual',registration_reason:'x',record:{company:'C',job_title:'T',status:'Pending',matching_file:'/tmp/nope.json'}}),/must not claim a matching_file/);
 // 缺 matching_file 的 research 登记：拒绝
 assert.throws(()=>add(store,{registration:'research',selected_position_id:'role-1',record:{company:'C',job_title:'T',status:'Pending'}}),/requires matching_file/);
 // 完全未声明登记类型：拒绝
 assert.throws(()=>add(store,{record:{company:'C',job_title:'T',status:'Pending'}}),/registration/);
 assert.equal(store.snapshot().revision,before.revision);
});

test('verified selected position can preview and register; unselected position cannot borrow permission',t=>{
 const {store,matchingFile}=researchFixture(t);
 const plan={expected_revision:store.snapshot().revision,operations:[{type:'job.add',job_id:'role-1',registration:'research',selected_position_id:'role-1',record:{company:'Fixture Company',job_title:'Fixture QA Engineer',status:'Pending',matching_file:matchingFile}}]};
 const before=store.snapshot().revision;
 const preview=store.commit(plan,true);assert.deepEqual(preview.changed_jobs,['role-1']);assert.equal(store.snapshot().revision,before,'预览不得写入');
 store.commit(plan);const snap=store.snapshot();
 assert.equal(snap.tables.job_pool.length,2);assert.equal(snap.tables.job_pool[1].job_id,'role-1');
 // 登记元数据不得写进 job_pool 列
 assert.equal(snap.tables.job_pool[1].registration,undefined);
 assert.equal(snap.tables.job_pool[1].selected_position_id,undefined);
 assert.match(snap.tables.job_pool[1].source,/research: matching=/);
 // 未选中的岗位不能借用别的岗位许可：job_id 正确映射到 role-9，但 role-9 不在可登记列表
 const other=researchFixture(t);
 assert.throws(()=>add(other.store,{job_id:'role-9',registration:'research',selected_position_id:'role-9',record:{company:'Fixture Company',job_title:'Other',status:'Pending',matching_file:other.matchingFile}}),/does not permit|not in registerable/);
 assert.equal(other.store.snapshot().tables.job_pool.length,1,'拒绝时不得写入');
});

test('position_id maps to job_id explicitly and cannot silently mismatch',t=>{
 const {store,matchingFile}=researchFixture(t);
 // 未声明映射且 job_id 与 position_id 不同：拒绝
 assert.throws(()=>add(store,{job_id:'job_'+'a'.repeat(8),registration:'research',selected_position_id:'role-1',record:{company:'Fixture Company',job_title:'T',status:'Pending',matching_file:matchingFile}}),/must map to the selected position_id/);
 // 显式映射后允许（研究 position_id 与主表 job_id 不假设天然相同）
 const mapped='job_'+'b'.repeat(8);
 add(store,{job_id:mapped,registration:'research',selected_position_id:'role-1',position_job_map:{'role-1':mapped},record:{company:'Fixture Company',job_title:'T',status:'Pending',matching_file:matchingFile}});
 assert.ok(store.snapshot().tables.job_pool.some(r=>r.job_id===mapped));
});

test('pipeline exit 0 alone is not treated as matching permission',t=>{
 const {store,research,matching,matchingFile}=researchFixture(t);
 // 构造"引文不在快照内"的记录：校验器会给出 blocked，但流程本身能跑完
 matching.positions[0].jd_source.quotes[0].text='这句话不在 JD 快照里。';
 fs.writeFileSync(matchingFile,JSON.stringify(matching));
 assert.throws(()=>add(store,{registration:'research',selected_position_id:'role-1',record:{company:'Fixture Company',job_title:'T',status:'Pending',matching_file:matchingFile}}),/verified matching record|does not permit/);
 assert.equal(store.snapshot().tables.job_pool.length,1);
});

test('legacy schema-1 matching cannot grant registration permission',t=>{
 const {store,research,matchingFile}=researchFixture(t);
 fs.writeFileSync(matchingFile,JSON.stringify({company:'Fixture Company',date:'2026-01-01',raw_catalog:{file:'catalog.json',total_positions:1},catalog_index:[{id:'role-1',in_scope:true}],positions:[]}));
 assert.throws(()=>add(store,{registration:'research',selected_position_id:'role-1',record:{company:'Fixture Company',job_title:'T',status:'Pending',matching_file:matchingFile}}),/verified matching record/);
});

test('historical maintenance is unaffected by the registration gate',t=>{
 const {store,matchingFile}=researchFixture(t);
 // 历史岗位的备注/测评/面试/提交证据维护仍走原路径，不需要重做研究
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{notes:'历史备注维护'}}]});
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'event.add',job_id:'j1',event_id:'e9',record:{date:'2026-09-20',event_type:'在线测评'}}]});
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.patch',job_id:'j1',patch:{status:'Submitted',application_date:'2026-09-20'}},{type:'log.add',job_id:'j1',log_id:'l9',record:{status:'Submitted',submission_evidence:'本人确认'}}]});
 const snap=store.snapshot();
 assert.equal(snap.tables.job_pool[0].notes,'历史备注维护');
 assert.equal(snap.tables.job_pool[0].status,'Submitted');
 assert.equal(snap.tables.follow_up[0].event_type,'在线测评');
});

test('manual registration is explicit and traceable, never a silent fallback',t=>{
 const {store}=fixture(t);
 // 缺理由：拒绝
 assert.throws(()=>add(store,{job_id:'m1',registration:'manual',record:{company:'C',job_title:'T',status:'Pending'}}),/registration_reason/);
 // 显式声明并给出理由：允许，且来源可追溯
 add(store,{job_id:'m1',registration:'manual',registration_reason:'本人指定的人工补录',record:{company:'C',job_title:'T',status:'Pending'}});
 const row=store.snapshot().tables.job_pool.find(r=>r.job_id==='m1');
 assert.match(row.source,/^manual: 本人指定的人工补录$/);
});

// ---- snapshot 精简读取（对应审阅第四节）----
test('query projects fields and keeps the same overall revision as full snapshot',t=>{
 const {store}=fixture(t);
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.add',job_id:'j2',registration:'manual',registration_reason:'fixture',record:{company:'Other',job_title:'Other',status:'Pending',job_description:'很长的 JD 正文',notes:'内部备注',legacy_record:'{"old":1}'}}]});
 const full=store.snapshot();
 const slim=store.query();
 // 同一个整体 revision 语义
 assert.equal(slim.revision,full.revision);
 assert.equal(slim.jobs.length,full.tables.job_pool.length);
 // 重字段默认不返回
 for(const job of slim.jobs){
  for(const heavy of ['job_description','legacy_record','legacy_row','notes'])assert.equal(job[heavy],undefined,`默认投影不应包含 ${heavy}`);
 }
 assert.ok(slim.meta.utf8_bytes>0);
 // 需要 JD 时显式索取
 const withJd=store.query({job_ids:['j2'],include_description:true});
 assert.equal(withJd.jobs.length,1);
 assert.equal(withJd.jobs[0].job_description,'很长的 JD 正文');
 assert.equal(withJd.revision,full.revision);
});

test('query filters by job_id, company and status without losing revision semantics',t=>{
 const {store}=fixture(t);
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.add',job_id:'j2',registration:'manual',registration_reason:'fixture',record:{company:'Other',job_title:'Other',status:'Pending'}}]});
 const rev=store.snapshot().revision;
 assert.deepEqual(store.query({job_ids:['j1']}).jobs.map(j=>j.job_id),['j1']);
 assert.deepEqual(store.query({company:'Other'}).jobs.map(j=>j.job_id),['j2']);
 assert.deepEqual(store.query({status:'Pending'}).jobs.map(j=>j.job_id).sort(),['j1','j2']);
 for(const options of [{job_ids:['j1']},{company:'Other'},{status:'Pending'}])assert.equal(store.query(options).revision,rev);
 // 未匹配到岗位时也返回有效 revision，不报错
 const none=store.query({company:'不存在'});
 assert.equal(none.jobs.length,0);assert.equal(none.revision,rev);
 assert.throws(()=>store.query({fields:['not_a_column']}),/Unknown job field/);
});

test('query returns only necessary related events, including shared links',t=>{
 const {store}=fixture(t);
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'job.add',job_id:'j2',registration:'manual',registration_reason:'fixture',record:{company:'Company',job_title:'Other',status:'Pending'}}]});
 // j1 与 j2 同公司共享一条测评日程
 store.commit({expected_revision:store.snapshot().revision,operations:[{type:'event.add',job_id:'j1',event_id:'e1',record:{date:'2026-09-25',event_type:'共享在线测评',related_job_ids:'["j2"]'}},{type:'event.add',job_id:'j2',event_id:'e2',record:{date:'2026-09-26',event_type:'仅 j2 的日程'}}]});
 // 只查 j1 时，共享日程必须带出（否则会漏掉关联岗位的测评）
 const onlyJ1=store.query({job_ids:['j1']});
 const ids=onlyJ1.events.map(e=>e.event_id).sort();
 assert.deepEqual(ids,['e1'],'共享事件应带出，且不应带出无关事件');
 const both=store.query({job_ids:['j1','j2']});
 assert.deepEqual(both.events.map(e=>e.event_id).sort(),['e1','e2']);
 // 不需要事件时可以不返回
 assert.deepEqual(store.query({job_ids:['j1'],with_events:false}).events,[]);
});

test('query does not weaken write-path validation',t=>{
 const {store}=fixture(t);
 const snap=store.snapshot();
 // 查询是只读的
 store.query();
 assert.equal(store.snapshot().revision,snap.revision);
 // 写入仍然要求完整状态与 revision 校验
 assert.throws(()=>store.commit({expected_revision:'stale',operations:[{type:'job.patch',job_id:'j1',patch:{notes:'x'}}]}),/Revision conflict/);
});
