const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function sync(jobStatus,eventStatuses,{dryRun=false,remoteStage=1}={}){
 const db={progress:[{id:'p',user:'u',company:'Example',department:'Role',job_note:'Keep me',city:'上海'}],progress_stages:[{id:'s',user:'u',progress:'p',stage:remoteStage,status:6,stage_date:'2026-09-10T00:00:00Z'}]},writes=[];
 const ctx={window:{localStorage:{getItem:()=>JSON.stringify({record:{id:'u'},token:'fake'})}},fetch:async(url,o)=>{
  const m=url.match(/collections\/(\w+)\/records(?:\/([^?]+))?/),rows=db[m[1]];let r;
  if(o.method==='GET')r=m[2]?rows.find(x=>x.id===m[2]):{items:rows,totalPages:1};
  else {writes.push(url);if(m[2]){r=rows.find(x=>x.id===m[2]);Object.assign(r,JSON.parse(o.body));}else{r={id:'new'+rows.length,...JSON.parse(o.body)};rows.push(r);}}
  return{ok:true,json:async()=>JSON.parse(JSON.stringify(r))};
 }};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('./offernotes-reconcile'),'utf8'),ctx);
 const result=await ctx.reconcileOfferNotes({dryRun,entries:[{job:{job_id:'j',offernotes_id:'p',company:'Example',job_title:'Role',location:'上海',status:jobStatus,notes:'New note'},change_id:'c',events:eventStatuses.map(status=>({stage:jobStatus==='Offer'?'5':'1',stage_status:String(status),date:'2026-09-12',event_type:'Historical event'}))}]});
 return {db,writes,result:result.results[0]};
}
test('new rejection and withdrawal survive older waiting events without taking their dates',async()=>{
 for(const [jobStatus,expected]of [['Rejected',5],['Skipped',3]])for(const status of [1,2,6]){
  const r=await sync(jobStatus,[status]);assert.equal(r.result.error,undefined);assert.equal(r.db.progress_stages[0].status,expected);assert.equal(r.db.progress_stages[0].stage_date,'2026-09-10T00:00:00Z');
 }
});
test('new offer cannot be overwritten by stale offer waiting event',async()=>{
 const r=await sync('Offer',[6]);assert.equal(r.result.error,undefined);assert.equal(r.db.progress_stages.find(s=>s.stage===5).status,4);
});
test('contradictory results and ambiguous later stages fail before writes in preview and apply',async()=>{
 for(const dryRun of [true,false]){
  const r=await sync('Rejected',[4],{dryRun});assert.match(r.result.error,/Conflicting terminal/);assert.equal(r.writes.length,0);assert.equal(r.db.progress[0].job_note,'Keep me');
  const later=await sync('Rejected',[6],{dryRun,remoteStage:0});assert.match(later.result.error,/later than/);assert.equal(later.writes.length,0);
 }
});
