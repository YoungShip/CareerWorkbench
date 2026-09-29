'use strict';
// tracker-cli 与 MCP server 共用的只读入口：路径解析、rules、brief、validate 只在这里实现一份。
const fs=require('node:fs'),path=require('node:path');
const {createStore}=require('../dashboard/store');

function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}

function createTrackerService(options={}){
 const project=path.resolve(options.projectDir||path.resolve(__dirname,'..'));
 const workspace=path.resolve(options.workspaceDir||path.dirname(project));
 const dataDir=path.resolve(options.dataDir||process.env.JOBHUNT_DATA_DIR||path.join(project,'dashboard'));
 const discoveryRoot=path.resolve(options.discoveryDir||process.env.JOBHUNT_DISCOVERY_DIR||path.join(project,'data','company-discovery'));
 const policyFile=path.resolve(options.policyFile||path.join(project,'data','private','policy-review.json'));
 const rulesFile=path.resolve(options.rulesFile||path.join(workspace,'lapis-cv','秋招','求职档案.md'));
 const store=options.store||createStore(dataDir);

 function policyText(){try{return fs.readFileSync(rulesFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;return '';}}
 function rules(){
  const {currentSection}=require('../dashboard/brief'),text=policyText();
  if(!text)throw Error('Current rules source is missing');
  return {source:'lapis-cv/秋招/求职档案.md',read_only:true,selection_rules:currentSection(text,'选岗规则'),evidence_boundaries:currentSection(text,'经历与表述边界'),note:'只提取当前规则与经历边界；公司历史和个人字段按需另读，不以本输出证明任何岗位在招。'};
 }
 function brief({limit=8}={}){
  const {buildBrief}=require('../dashboard/brief');
  let policy;
  try{policy=readJson(policyFile);}catch(e){if(e.code!=='ENOENT')policy={invalid:true};}
  let discovery=null;const extraWarnings=[];
  try{
   const {createDiscoveryStore}=require('../discovery/store'),{buildDiscoveryNext}=require('../discovery/view');
   discovery=buildDiscoveryNext(createDiscoveryStore(discoveryRoot).snapshot(),{limit,now:new Date()});
  }catch(error){extraWarnings.push('Discovery summary unavailable: '+error.message);}
  return buildBrief(store.snapshot(),{policy,policyText:policyText(),limit,discovery,extraWarnings});
 }
 function validate(){
  const snap=store.snapshot();
  return {revision:snap.revision,counts:Object.fromEntries(Object.entries(snap.tables).map(([k,v])=>[k,v.length])),warnings:snap.warnings};
 }
 return {store,rules,brief,validate,paths:{project,workspace,dataDir,discoveryRoot}};
}

module.exports={createTrackerService,readJson};
