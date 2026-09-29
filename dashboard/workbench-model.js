'use strict';
(function(root){
 const labels={Submitted:'已投递',Pending:'待投递',Deferred:'暂缓',Blocked:'待处理','Needs user':'待确认',Offer:'已获 Offer',Rejected:'被拒',Ended:'已结束',Skipped:'已跳过'};
 const closed=new Set(['Offer','Rejected','Ended','Skipped']),waiting=new Set(['Pending','Deferred','Blocked','Needs user']);
 function group(job){return job.status==='Submitted'?'active':closed.has(job.status)?'closed':waiting.has(job.status)?'waiting':'other';}
 function filter(jobs,{query='',status='all',family='',city=''}={}){
  const q=query.trim().toLocaleLowerCase();
  return jobs.filter(j=>(status==='all'||group(j)===status||j.status===status)&&(!family||j.role_family===family)&&(!city||j.location===city)&&(!q||[j.company,j.job_title,j.location,j.next_action].join(' ').toLocaleLowerCase().includes(q)));
 }
 function safeLink(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}}
 function submittedDate(job,logs){return logs.filter(l=>l.job_id===job.job_id&&l.attempt_date).map(l=>l.attempt_date).sort().at(-1)||job.application_date||'';}
 function counts(jobs){const result={all:jobs.length,active:0,waiting:0,closed:0,other:0};for(const job of jobs)result[group(job)]++;return result;}
 function timingParts(at){
  if(!at)return {day:'',clock:''};
  if(/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/i.test(at)){
   const date=new Date(at);
   if(Number.isFinite(date.getTime()))return {day:date.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),clock:date.toLocaleTimeString('en-GB',{timeZone:'Asia/Shanghai',hour12:false,hour:'2-digit',minute:'2-digit'})};
  }
  return {day:String(at).slice(0,10),clock:String(at).match(/[T ](\d{2}:\d{2})/)?.[1]||''};
 }
 const api={labels,group,filter,safeLink,submittedDate,counts,timingParts};
 if(typeof module!=='undefined')module.exports=api;else root.WorkbenchModel=api;
})(typeof window==='undefined'?globalThis:window);
