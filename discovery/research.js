'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 隔离校验目录里由本模块自己生成的文件名。证据相对路径不得占用这些名字，
// 否则真实证据会被覆盖、或反过来覆盖校验输入与报告。
const RESERVED_NAMES=new Set(['matching.json','catalog.json','matching-verification.json']);

// 证据路径安全校验：只接受记录目录内的相对路径。
// 拒绝绝对路径、盘符、UNC 与目录逃逸，避免把任意文件复制进校验目录。
function safeRelative(value,label){
 if(typeof value!=='string'||!value.trim())throw Error(`${label} must be a non-empty relative path`);
 const raw=value.trim();
 if(path.isAbsolute(raw)||/^[a-zA-Z]:/.test(raw)||raw.startsWith('\\\\')||raw.startsWith('//'))throw Error(`${label} must be relative, not absolute`);
 const normalized=path.normalize(raw);
 if(normalized==='.'||normalized==='..'||normalized.startsWith('..'+path.sep)||path.isAbsolute(normalized))throw Error(`${label} escapes the record directory`);
 if(!normalized.includes(path.sep)&&RESERVED_NAMES.has(normalized))throw Error(`${label} collides with a reserved verification file: ${normalized}`);
 return normalized;
}

// 收集记录实际声明的全部证据依赖：每个岗位的 JD 正文快照与候选人档案快照。
// 键是记录里的相对路径，因此不同子目录下的同名文件不会互相覆盖（保留相对结构即避免文件名冲突）。
function collectEvidenceDependencies(matching,recordDir){
 const dependencies=new Map();
 const positions=Array.isArray(matching?.positions)?matching.positions:[];
 for(const [index,position] of positions.entries()){
  const id=position&&typeof position.id==='string'&&position.id?position.id:`#${index}`;
  for(const field of ['jd_source','candidate_source']){
   const source=position?.[field];
   if(!source||source.snapshot_file==null)continue;
   const name=`positions[${id}].${field}.snapshot_file`;
   const relative=safeRelative(source.snapshot_file,name);
   const absolute=path.resolve(recordDir,relative);
   const contained=path.relative(recordDir,absolute);
   if(contained.startsWith('..')||path.isAbsolute(contained))throw Error(`${name} escapes the record directory`);
   const existing=dependencies.get(relative);
   if(existing){
    if(existing.absolute!==absolute)throw Error(`${name} conflicts with another evidence path: ${relative}`);
    existing.labels.push(name);
    continue;
   }
   dependencies.set(relative,{absolute,labels:[name]});
  }
 }
 return dependencies;
}

function reportHeaderTemplate(matching){
 return `# ${matching.company} 岗位研究\n\n公司：${matching.company}\n日期：${matching.date}\n`;
}
function inspectReportMetadata(matching,reportText){
 const company_exact=typeof matching?.company==='string'&&matching.company!==''&&String(reportText).includes(matching.company);
 const date_exact=typeof matching?.date==='string'&&matching.date!==''&&String(reportText).includes(matching.date);
 const missing=[];if(!company_exact)missing.push('company');if(!date_exact)missing.push('date');
 return {status:missing.length?'failed':'passed',company_exact,date_exact,expected_company:matching?.company||'',expected_date:matching?.date||'',missing,header_template:reportHeaderTemplate(matching||{})};
}
function inspectResearch(op){
 const {resolveArtifactPath}=require('../lib/artifact-paths');
 op={...op,matching_file:op.matching_file?resolveArtifactPath(op.matching_file):op.matching_file,
  ...(op.research_file?{research_file:resolveArtifactPath(op.research_file)}:{})};
 // matching_file 必填；research_file 在"研究完成"流程必填，但在仅做匹配校验的
 // 登记入口可以省略（由 verifyResearch 单独强制）。
 if(!path.isAbsolute(op.matching_file||''))throw Error('Absolute matching path required');
 if(op.research_file!==undefined&&op.research_file!==null&&op.research_file!==''&&!path.isAbsolute(op.research_file))throw Error('Absolute research path required');
 const matching=JSON.parse(fs.readFileSync(op.matching_file,'utf8'));
 if(!matching.raw_catalog?.file)throw Error('Raw catalog file required');
 const recordDir=path.dirname(op.matching_file);
 const catalog_file=path.resolve(recordDir,matching.raw_catalog.file);
 const files={matching_file:op.matching_file,catalog_file};
 if(op.research_file)files.research_file=op.research_file;
 const dependencies=collectEvidenceDependencies(matching,recordDir);
 // 存在的证据依赖纳入指纹；缺失的不在这里报错，交给校验器按 SOURCE_SNAPSHOT_MISSING 统一诊断，
 // 这样 discovery 与直接校验得到同一份结构化结论。
 const missing=[];
 for(const [relative,dependency] of dependencies){
  if(fs.existsSync(dependency.absolute)&&fs.statSync(dependency.absolute).isFile())files[`evidence:${relative}`]=dependency.absolute;
  else missing.push({path:relative,labels:dependency.labels});
 }
 const hashes=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,hash(file)]));
 const report_metadata=files.research_file?inspectReportMetadata(matching,fs.readFileSync(files.research_file,'utf8')):null;
 return {matching,files,hashes,dependencies,missing,recordDir,report_metadata};
}

// 汇总新版报告的 checks/readiness，供调用方按验证结论（而不是退出码）判断能否标记研究完成。
function summarizeValidation(validation){
 const checks=validation?.checks||{};
 const readiness=validation?.readiness||{};
 const failedChecks=Object.entries(checks)
  .filter(([,value])=>!['passed','verified','not_applicable'].includes(value))
  .map(([key,value])=>`${key}=${value}`);
 const unresolved=Array.isArray(readiness.unresolved)?readiness.unresolved:[];
 return {
  passed:validation?.passed===true,
  mechanical_passed:validation?.mechanical_passed===true,
  overall_status:validation?.overall_status||'unknown',
  checks,readiness,failedChecks,unresolved,
 };
}

// 在隔离目录里对"已组装的 matching 记录"运行受信任校验器。
// discovery 与主表登记共用同一实现，避免两处各写一套判断。
// 返回 {validation, summary, files, hashes, missing}；校验未通过时抛错并附结构化结论。
function validateMatchingArtifact(op,{python,verifier}={}){
 if(!python||!verifier)throw Error('Python and verifier paths are required for matching validation');
 const {matching,files,hashes,missing}=inspectResearch(op);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'jobhunt-verify-'));
 try{
  for(const [key,absolute] of Object.entries(files)){
   if(!key.startsWith('evidence:'))continue;
   const target=path.join(temp,key.slice('evidence:'.length));
   fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.copyFileSync(absolute,target);
  }
  const copy=JSON.parse(JSON.stringify(matching));copy.raw_catalog.file=path.join(temp,'catalog.json');
  fs.copyFileSync(files.catalog_file,copy.raw_catalog.file);
  const input=path.join(temp,'matching.json');fs.writeFileSync(input,JSON.stringify(copy));
  const result=spawnSync(python,['-X','utf8',verifier,input],{encoding:'utf8',timeout:30000,windowsHide:true});
  // 即使退出码非零也要读报告：非全量结果仍可读，且要按 checks/readiness 报出真实阻塞原因。
  const reportPath=path.join(temp,'matching-verification.json');
  if(!fs.existsSync(reportPath))throw Error('Matching validation failed: '+(result.error?.message||result.stdout||result.stderr||'validator produced no report'));
  const validation=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  if(!Object.keys(hashes).every(k=>hash(files[k])===hashes[k]))throw Error('Research artifacts changed during validation');
  const summary=summarizeValidation(validation);
  if(!summary.passed){
   const detail=[...summary.failedChecks,...summary.unresolved].join(', ')||'unknown';
   const error=Error(`Matching validation failed: readiness=${summary.readiness.status||'unknown'} (${detail})`);
   error.validation=validation;error.validation_summary=summary;
   throw error;
  }
  return {validation,summary,files,hashes,missing};
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}

function verifyResearch(op,lead,{python,verifier}){
 if(!op.research_file)throw Error('Absolute research path required');
 const {matching,files,hashes,missing,report_metadata}=inspectResearch(op);
 const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s·（）()]/g,'');
 if(![lead.company,...lead.aliases].map(normalize).includes(normalize(matching.company)))throw Error('Research company does not match lead');
 if(!Object.keys(hashes).every(k=>op.expected_hashes?.[k]===hashes[k]))throw Error('Research artifacts changed; prepare a new plan');
 if(!report_metadata||report_metadata.status!=='passed'){
  const missing=report_metadata?.missing?.join(', ')||'company, date';
  throw Error(`Report metadata mismatch: missing ${missing}. Expected header:\n${report_metadata?.header_template||reportHeaderTemplate(matching)}`);
 }
 // Run the trusted validator against isolated copies: preview never modifies research files.
 const {validation,summary}=validateMatchingArtifact(op,{python,verifier});
 return {files,hashes,validation,validation_summary:summary,readiness:summary.readiness,missing_evidence:missing};
}
// 受信任校验器的默认运行时位置。允许用环境变量覆盖，便于测试与不同机器。
function defaultRuntime(){
 return {
  python:process.env.JOBHUNT_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
  verifier:process.env.JOBHUNT_VERIFIER||path.resolve(__dirname,'../../.agents/skills/campus-recruitment/scripts/verify-matching.py'),
 };
}

module.exports={inspectResearch,inspectReportMetadata,reportHeaderTemplate,verifyResearch,validateMatchingArtifact,summarizeValidation,safeRelative,collectEvidenceDependencies,defaultRuntime};
