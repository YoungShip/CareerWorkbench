'use strict';
const ACTIVE_STATES=new Set(['discovered','blocked']);
const DEADLINE_CONFIDENCE=new Set(['official','cross_source','third_party','unknown']);
const DEFAULT_FIELDS=['lead_id','company','state','official_url','source_urls','deadline','deadline_source_url','deadline_confidence','last_checked_at','evidence_summary','open_questions'];

function validDateParts(y,m,d){
 const probe=new Date(Date.UTC(y,m-1,d));
 return probe.getUTCFullYear()===y&&probe.getUTCMonth()===m-1&&probe.getUTCDate()===d;
}
function parseDeadline(value){
 if(typeof value!=='string'||!value.trim())return null;
 const raw=value.trim();
 const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/);
 if(!m)return null;
 const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
 if(!validDateParts(y,mo,d))return null;
 if(m[4]===undefined){
  const at=new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:00+08:00`);
  return {raw,at,precision:'date',assumed_time:true};
 }
 const h=Number(m[4]),mi=Number(m[5]),s=Number(m[6]||0);
 if(h>23||mi>59||s>59)return null;
 const zone=m[7]||'+08:00';
 const at=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2,'0')}${zone}`);
 if(Number.isNaN(at.getTime()))return null;
 return {raw,at,precision:m[6]===undefined?'minute':'second',assumed_time:false};
}

function candidateFromText(lead){
 const text=[lead.evidence_summary,...(Array.isArray(lead.open_questions)?lead.open_questions:[])].filter(Boolean).join('\n');
 const re=/(?:截止(?:时间)?|截至|网申(?:截止|至)|投递(?:截止|至)|报名(?:截止|至)|申请(?:截止|至)|第二批(?:投递)?至)[^\d]{0,16}(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})(?:日)?(?:\s*(\d{1,2})(?:[:时](\d{2})?)?)?/g;
 const found=[];let match;
 while((match=re.exec(text))){
  if(/未核|待核|未知|不明|未公开/.test(match[0]))continue;
  const y=match[1],mo=String(Number(match[2])).padStart(2,'0'),d=String(Number(match[3])).padStart(2,'0');
  const raw=match[4]!==undefined?`${y}-${mo}-${d} ${String(Number(match[4])).padStart(2,'0')}:${String(Number(match[5]||0)).padStart(2,'0')}`:`${y}-${mo}-${d}`;
  const parsed=parseDeadline(raw);if(parsed)found.push({...parsed,excerpt:match[0]});
 }
 found.sort((a,b)=>a.at-b.at);
 return found[0]||null;
}

function deadlineForLead(lead){
 const structured=parseDeadline(lead?.deadline);
 if(structured)return {...structured,source:'structured',confirmed:true,confidence:DEADLINE_CONFIDENCE.has(lead.deadline_confidence)?lead.deadline_confidence:'unknown',source_url:lead.deadline_source_url||''};
 const candidate=candidateFromText(lead||{});
 return candidate?{...candidate,source:'text_candidate',confirmed:false,confidence:'unknown',source_url:''}:null;
}
function grouped(rows,limit){return {total:rows.length,items:rows.slice(0,limit),truncated:rows.length>limit};}
function stateCounts(leads){return leads.reduce((out,lead)=>(out[lead.state]=(out[lead.state]||0)+1,out),{});}

function buildDiscoveryNext(snapshot,{now=new Date(),limit=8,horizonHours=168}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('limit must be an integer from 1 to 100');
 if(!Number.isFinite(horizonHours)||horizonHours<1||horizonHours>24*60)throw Error('horizonHours must be between 1 and 1440');
 const leads=Array.isArray(snapshot.leads)?snapshot.leads:[],nowMs=new Date(now).getTime(),horizon=horizonHours*3600000;
 const deadlineRows=[];
 for(const lead of leads){
  if(!ACTIVE_STATES.has(lead.state))continue;
  const info=deadlineForLead(lead);if(!info)continue;
  const remaining=info.at.getTime()-nowMs;
  if(remaining>horizon||remaining<(-30*86400000))continue;
  deadlineRows.push({lead_id:lead.lead_id,company:lead.company,state:lead.state,deadline:info.raw,deadline_at:info.at.toISOString(),remaining_ms:remaining,diffH:Math.round(remaining/360000)/10,source:info.source,confirmed:info.confirmed,confidence:info.confidence,source_url:info.source_url,excerpt:info.excerpt||'',official_url:lead.official_url||'',open_questions:lead.open_questions||[]});
 }
 deadlineRows.sort((a,b)=>a.remaining_ms-b.remaining_ms||a.company.localeCompare(b.company,'zh-CN'));
 const queued=leads.filter(lead=>ACTIVE_STATES.has(lead.state)).map(lead=>({lead_id:lead.lead_id,company:lead.company,state:lead.state,last_checked_at:lead.last_checked_at||'',official_url:lead.official_url||'',open_questions:lead.open_questions||[]})).sort((a,b)=>{
  const ad=deadlineRows.find(x=>x.lead_id===a.lead_id),bd=deadlineRows.find(x=>x.lead_id===b.lead_id);
  if(ad||bd)return ad&&!bd?-1:!ad&&bd?1:ad.remaining_ms-bd.remaining_ms;
  if(a.state!==b.state)return a.state==='discovered'?-1:1;
  return String(a.last_checked_at).localeCompare(String(b.last_checked_at));
 });
 const active=Array.isArray(snapshot.runs)?snapshot.runs.find(run=>run.run_id===snapshot.active_run_id):null;
 return {revision:snapshot.revision,read_only:true,generated_at:new Date(nowMs).toISOString(),counts:{leads:leads.length,states:stateCounts(leads)},active_run:active?{run_id:active.run_id,status:active.status,checkpoint:active.checkpoint||'',next_steps:active.next_steps||[],updated_at:active.updated_at||''}:null,deadline_attention:grouped(deadlineRows,limit),queue:grouped(queued,limit),requires_confirmation:deadlineRows.some(row=>!row.confirmed)};
}

function queryDiscovery(snapshot,options={}){
 const all=Array.isArray(snapshot.leads)?snapshot.leads:[];
 const ids=Array.isArray(options.lead_ids)?options.lead_ids.filter(Boolean):[];
 const states=Array.isArray(options.states)?options.states.filter(Boolean):[];
 const company=String(options.company||'').normalize('NFKC').toLowerCase();
 const limit=options.limit===undefined?50:Number(options.limit);
 if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('limit must be an integer from 1 to 500');
 let leads=all.filter(lead=>(!ids.length||ids.includes(lead.lead_id))&&(!states.length||states.includes(lead.state))&&(!company||String(lead.company).normalize('NFKC').toLowerCase().includes(company)));
 const allowed=new Set([...DEFAULT_FIELDS,'deadline_info',...all.flatMap(lead=>Object.keys(lead))]);
 const fields=Array.isArray(options.fields)&&options.fields.length?options.fields:DEFAULT_FIELDS;
 for(const field of fields)if(!allowed.has(field))throw Error('Unknown lead field: '+field);
 const total=leads.length;leads=leads.slice(0,limit).map(lead=>Object.fromEntries(fields.map(field=>[field,field==='deadline_info'?deadlineForLead(lead):lead[field]])));
 const payload={revision:snapshot.revision,active_run_id:snapshot.active_run_id||'',counts:{matched:total,total:all.length,states:stateCounts(all)},leads,meta:{fields,limit,truncated:total>leads.length}};
 payload.meta.utf8_bytes=Buffer.byteLength(JSON.stringify(payload),'utf8');
 return payload;
}

module.exports={parseDeadline,deadlineForLead,buildDiscoveryNext,queryDiscovery,DEFAULT_FIELDS,DEADLINE_CONFIDENCE};