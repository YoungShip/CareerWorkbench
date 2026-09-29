#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createDiscoveryStore,names,mentions}=require('./store');
const {queryDiscovery,buildDiscoveryNext}=require('./view');
const {inspectResearch,verifyResearch}=require('./research');
const {extractOut,emitJson}=require('../lib/json-output');
const project=path.resolve(process.env.JOBHUNT_PROJECT_DIR||path.resolve(__dirname,'..'));
const workspace=path.resolve(process.env.JOBHUNT_WORKSPACE_DIR||path.dirname(project));
const discoveryRoot=path.resolve(process.env.JOBHUNT_DISCOVERY_DIR||path.join(project,'data','company-discovery'));
const dashboardRoot=path.resolve(process.env.JOBHUNT_DATA_DIR||path.join(project,'dashboard'));
const runtime={python:process.env.JOBHUNT_PYTHON||path.join(osHome(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),verifier:process.env.JOBHUNT_VERIFIER||path.resolve(workspace,'.agents/skills/campus-recruitment/scripts/verify-matching.py')};
function osHome(){return require('node:os').homedir();}
function context(){
 const docs=['求职档案.md','公司调研占用表.md','后续公司优先池.md'].map(n=>path.join(workspace,'lapis-cv','秋招',n));
 const records=docs.flatMap(file=>fs.readFileSync(file,'utf8').split(/\r?\n/).map((text,i)=>({source:file,line:i+1,text})));
 const snap=require('../dashboard/store').createStore(dashboardRoot).snapshot();
 records.push(...snap.tables.job_pool.map(j=>({source:'CareerWorkbench/job_pool',job_id:j.job_id,text:j.company})));
 const researchDir=path.join(workspace,'lapis-cv','秋招');
 records.push(...fs.readdirSync(researchDir).filter(n=>/岗位比较|岗位复核/.test(n)).map(text=>({source:'lapis-cv/秋招/research-file',text})));
 return lead=>records.map(r=>({...r,matched_names:names(lead).filter(n=>n.length>=2&&mentions(r.text,n))})).filter(r=>r.matched_names.length).map(({source,line,job_id,matched_names})=>({source,line,job_id,matched_names}));
}
function readStore(write=false){return createDiscoveryStore(discoveryRoot,write?{knownMatches:context(),researchValidator:(op,lead)=>verifyResearch(op,lead,runtime)}:{});}
function parseViewArgs(argv){
 const options={lead_ids:[],states:[],fields:[]};
 for(let i=0;i<argv.length;i++){
  const token=argv[i];if(!token.startsWith('--'))throw Error('Unexpected argument: '+token);
  let key=token.slice(2),value;const eq=key.indexOf('=');
  if(eq>=0){value=key.slice(eq+1);key=key.slice(0,eq);}else if(argv[i+1]!==undefined&&!argv[i+1].startsWith('--'))value=argv[++i];
  if(key==='lead_id')options.lead_ids.push(value);
  else if(key==='lead_ids')options.lead_ids.push(...String(value).split(',').map(x=>x.trim()).filter(Boolean));
  else if(key==='state')options.states.push(value);
  else if(key==='states')options.states.push(...String(value).split(',').map(x=>x.trim()).filter(Boolean));
  else if(key==='fields')options.fields.push(...String(value).split(',').map(x=>x.trim()).filter(Boolean));
  else if(key==='company')options.company=value;
  else if(key==='limit'||key==='horizon_hours')options[key==='horizon_hours'?'horizonHours':'limit']=Number(value);
  else throw Error('Unknown discovery option: --'+key);
 }
 return options;
}
try{
 const parsed=extractOut(process.argv.slice(2)),args=parsed.args,out=parsed.out;
 const [command,file,...rest]=args;let result,inspectFailed=false;
 if(command==='snapshot'||command==='validate')result=readStore().snapshot();
 else if(command==='query')result=queryDiscovery(readStore().snapshot(),parseViewArgs([file,...rest].filter(x=>x!==undefined)));
 else if(command==='next'){
  const options=parseViewArgs([file,...rest].filter(x=>x!==undefined));
  result=buildDiscoveryNext(readStore().snapshot(),{limit:options.limit||8,horizonHours:options.horizonHours||168});
 }else if(command==='research-inspect'){
  if(!file)throw Error('research-inspect requires an input JSON file');
  const op=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),evidence=inspectResearch(op);
  result={company:evidence.matching.company,date:evidence.matching.date,files:evidence.files,expected_hashes:evidence.hashes,report_metadata:evidence.report_metadata,ready_for_plan:!evidence.report_metadata||evidence.report_metadata.status==='passed'};
  inspectFailed=result.ready_for_plan===false;
 }else if(command==='run-export'){
  const snap=readStore().snapshot(),run=snap.runs.at(-1);if(!run||!file)throw Error('Run and export path required');
  fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,JSON.stringify({derived_from:'leads.json/runs',revision:snap.revision,run},null,2)+'\n','utf8');result={run_id:run.run_id,file:path.resolve(file)};
 }else if(command==='preview'||command==='apply'){
  if(!file)throw Error(command+' requires a plan JSON file');
  result=readStore(true).execute(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),command==='preview');
 }else throw Error('Usage: node discovery/cli.js snapshot|validate|query [--lead_id=X] [--state=X] [--company=X] [--fields=a,b] [--limit=N]|next [--limit=N] [--horizon_hours=N]|research-inspect files.json|preview plan.json|apply plan.json|run-export receipt.json [--out=file.json]');
 emitJson(result,out);if(inspectFailed)process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}