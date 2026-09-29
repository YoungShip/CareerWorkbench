const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(initial=[]){
 const db={progress:structuredClone(initial),progress_stages:[]},writes=[];
 const ctx={window:{localStorage:{getItem:()=>JSON.stringify({record:{id:'u'},token:'test'})}},fetch:async(url,opt)=>{
  const m=url.match(/collections\/(\w+)\/records(?:\/([^?]+))?/),rows=db[m[1]];let r;
  if(opt.method==='GET')r=m[2]?rows.find(x=>x.id===m[2]):{items:rows,totalPages:1};
  else {writes.push({url,method:opt.method});const values=JSON.parse(opt.body);if(m[2]){r=rows.find(x=>x.id===m[2]);Object.assign(r,values);}else{r={id:m[1]+rows.length,...values};rows.push(r);}}
  return {ok:true,json:async()=>structuredClone(r)};
 }};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('./offernotes-reconcile'),'utf8'),ctx);
 return {db,writes,sync:async(jobs,extra={})=>ctx.reconcileOfferNotes({dryRun:false,entries:jobs.map(job=>({job,change_id:'c',events:[]})),...extra})};
}
const job={job_id:'j1',company:'Company',job_title:'Role',status:'Pending',notes:'本地初始说明'};
const legacy={id:'legacy',user:'u',company:'Company',department:'Role',job_note:'人工备注：请保留\n历史记录'};

test('managed notes replace changing local content, retain human additions and are idempotent',async()=>{
 const f=fixture([legacy]);let r=await f.sync([job]);assert.equal(r.results[0].error,undefined);
 f.db.progress[0].job_note+='\n人工新增：电话记录';
 const updated={...job,notes:'本地更新说明\n新增第二行'};
 r=await f.sync([updated]);assert.equal(r.results[0].error,undefined);
 const note=f.db.progress[0].job_note;assert.ok(note.startsWith(legacy.job_note));assert.ok(note.endsWith('人工新增：电话记录'));assert.ok(!note.includes('本地初始说明'));assert.equal(note.split('新增第二行').length-1,1);
 f.writes.length=0;r=await f.sync([updated]);assert.equal(r.results[0].error,undefined);assert.equal(f.writes.length,0);
 await f.sync([{...job,notes:''}]);assert.ok(!f.db.progress[0].job_note.includes('本地更新说明'));assert.ok(f.db.progress[0].job_note.includes('人工新增：电话记录'));
});

test('identical legacy note is adopted once; uncertain legacy history is kept intact',async()=>{
 const f=fixture([{...legacy,job_note:job.notes}]);await f.sync([job]);assert.equal(f.db.progress[0].job_note.split(job.notes).length-1,1);
 const history=legacy.job_note+'\n补充记录：\n'+job.notes;
 const g=fixture([{...legacy,job_note:history}]);await g.sync([job]);await g.sync([{...job,notes:'新状态'}]);assert.ok(g.db.progress[0].job_note.startsWith(history));assert.equal(g.db.progress[0].job_note.split('新状态').length-1,1);
});

test('online edits within managed block and malformed blocks stop before writes',async()=>{
 const f=fixture();await f.sync([job]);const original=f.db.progress[0].job_note;
 for(const damaged of [original.replace(job.notes,'人工改写'),original+'\n'+original,original.replace('[/CareerWorkbench:v1]','')]){
  f.db.progress[0].job_note=damaged;f.writes.length=0;
  const r=await f.sync([{...job,offernotes_id:f.db.progress[0].id}]);assert.ok(r.results[0].error);assert.equal(f.writes.length,0);assert.equal(f.db.progress[0].job_note,damaged);
 }
});

test('historical managed blocks migrate once without duplicating identity or losing human notes',async()=>{
 const f=fixture([legacy]);await f.sync([job]);
 f.db.progress[0].job_note=f.db.progress[0].job_note.replaceAll('CareerWorkbench:v1','JobHuntBot:v1')+'\n人工新增';
 f.writes.length=0;
 const result=await f.sync([job]);assert.equal(result.results[0].error,undefined);
 assert.equal(f.db.progress.length,1);assert.match(f.db.progress[0].job_note,/\[CareerWorkbench:v1:/);
 assert.ok(f.db.progress[0].job_note.startsWith(legacy.job_note));assert.ok(f.db.progress[0].job_note.endsWith('人工新增'));
 f.writes.length=0;await f.sync([job]);assert.equal(f.writes.length,0);
});

test('two same-title jobs get separate identities and retry without IDs cannot merge them',async()=>{
 const f=fixture(),jobs=[job,{...job,job_id:'j2',notes:'另一个官方岗位'}];
 let r=await f.sync(jobs);assert.ok(r.results.every(x=>!x.error));assert.equal(f.db.progress.length,2);assert.notEqual(r.results[0].offernotes_id,r.results[1].offernotes_id);
 f.writes.length=0;r=await f.sync([...jobs].reverse());assert.ok(r.results.every(x=>!x.error));assert.equal(f.db.progress.length,2);assert.equal(f.writes.length,0);
 const p=f.db.progress[0];r=await f.sync([{...jobs[1],offernotes_id:p.id}]);assert.match(r.results[0].error,/identity/);assert.equal(f.writes.length,0);
});

test('full identity index blocks ambiguous legacy matching even when only one job is queued',async()=>{
 const f=fixture([legacy]),identity_index=[job,{...job,job_id:'j2'}];
 for(const dryRun of [true,false]){const r=await f.sync([job],{dryRun,identity_index});assert.match(r.results[0].error,/explicit OfferNotes ID/);assert.equal(f.writes.length,0);}
 const r=await f.sync([{...job,offernotes_id:'legacy'}],{identity_index});assert.equal(r.results[0].error,undefined);
});

test('remote record bound to a different local job is excluded from name matching',async()=>{
 const f=fixture([legacy]),identity_index=[job,{...job,job_id:'j2',offernotes_id:'legacy'}];
 const r=await f.sync([job],{identity_index});assert.equal(r.results[0].error,undefined);assert.notEqual(r.results[0].offernotes_id,'legacy');assert.equal(f.db.progress[0].job_note,legacy.job_note);
});

test('damaged identity markers cannot silently create another same-title remote record',async()=>{
 const f=fixture([{...legacy,job_note:'[JobHuntBot:damaged]\n人工信息'}]);
 const r=await f.sync([job]);assert.match(r.results[0].error,/Malformed/);assert.equal(f.writes.length,0);assert.equal(f.db.progress.length,1);
});
