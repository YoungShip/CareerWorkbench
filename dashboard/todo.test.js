'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),rules=require('./todo');
test('unknown invitation time is not a deadline; estimates stay estimates; completed events leave todo',()=>{
 const unknown={event_type:'邀请收到（截止待核实）',date:'2026-09-01'},estimate={event_type:'测评截止参考上限',date:'2026-09-15',time:'17:10'},exact={event_type:'测评完成截止',date:'2026-09-14',time:'12:00'};
 assert.equal(rules.timing(unknown).at,'');assert.equal(rules.timing(estimate).kind,'估算截止');assert.deepEqual(rules.sorted([unknown,estimate,exact,{...exact,stage_status:'6'}]),[exact,estimate,unknown]);
});
test('completion preserves original invitation evidence, deadline and stable event without duplicating shared tests',()=>{
 const e={event_id:'e',job_id:'j',date:'2026-09-17',time:'03:06',deadline:'2026-09-17 03:06',event_type:'共享测评截止',notes:'两个岗位共用一次测评',stage:'1',stage_status:'1'};
 const s={tables:{follow_up:[e],job_pool:[{job_id:'j',status:'Submitted',current_stage:'测评待完成',next_action:'完成测评'}]}},p={job_id:'j',event_id:'e',date:'2026-09-12',time:'',outcome:'6',evidence:'本人确认完成'};
 const ops=rules.completion(s,p);assert.equal(ops.length,2);assert.equal(ops[0].type,'event.patch');assert.equal(ops[0].event_id,'e');assert.equal(ops[0].record.stage_status,'6');assert.equal(ops[0].record.deadline,e.deadline);assert.match(ops[0].record.notes,/两个岗位共用/);assert.match(ops[0].record.notes,/本人确认完成/);assert.equal(e.date,'2026-09-17');
 assert.equal(ops[1].patch.current_stage,'测评：已完成，等待结果');assert.equal(ops[1].patch.next_action,'已完成，等待结果');
 assert.throws(()=>rules.completion(s,{...p,evidence:''}));assert.throws(()=>rules.completion(s,{...p,date:'2999-01-01'}));assert.throws(()=>rules.completion(s,{...p,job_id:'other'}));assert.throws(()=>rules.completion({tables:{follow_up:[{...e,status:'Completed'}]}},p));
});

test('completion keeps remaining tasks and later round summaries; reminders do not invent stages',()=>{
 const e={event_id:'e',job_id:'j',date:'2026-09-12',event_type:'测评',stage:'1',stage_status:'1'};
 const job={job_id:'j',status:'Submitted',current_stage:'一面待参加',next_action:'准备一面'};
 const p={job_id:'j',event_id:'e',date:'2026-09-12',outcome:'6',evidence:'本人确认'};
 function patch(extra=[],event=e){return rules.completion({tables:{follow_up:[event,...extra],job_pool:[job]}},p).find(o=>o.type==='job.patch').patch;}
 const later={event_id:'later',job_id:'j',stage:'2',stage_status:'1',event_type:'一面',date:'2026-09-15'};
 assert.equal(patch([later]).current_stage,undefined);assert.equal(patch([later]).next_action,undefined);
 assert.equal(patch([{...later,stage:'1',event_type:'第二项测评'}]).next_action,'处理：第二项测评');
 assert.equal(patch([],{...e,stage:'',event_type:'核对资料'}).current_stage,undefined);
 assert.equal(patch([],{...e,stage:'',event_type:'核对资料'}).next_action,undefined);
 const rejected={tables:{follow_up:[e],job_pool:[{...job,status:'Rejected'}]}};
 assert.equal(rules.completion(rejected,p).length,1);
});
