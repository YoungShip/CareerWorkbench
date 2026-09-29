'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

function extractOut(argv){
 const args=[],seen=[];
 for(let i=0;i<argv.length;i++){
  const token=argv[i];
  if(token==='--out'){
   if(i+1>=argv.length||argv[i+1].startsWith('--'))throw Error('--out requires a file path');
   seen.push(argv[++i]);
  }else if(token.startsWith('--out=')){
   seen.push(token.slice(6));
  }else args.push(token);
 }
 if(seen.length>1)throw Error('--out may be provided only once');
 return {args,out:seen.length?path.resolve(seen[0]):''};
}

function encode(value){return JSON.stringify(value,null,2)+'\n';}

function atomicWriteJson(file,value){
 const target=path.resolve(file),text=encode(value);
 fs.mkdirSync(path.dirname(target),{recursive:true});
 const temp=target+'.tmp-'+crypto.randomUUID();
 const backup=target+'.bak-'+crypto.randomUUID();
 fs.writeFileSync(temp,text,{encoding:'utf8',flag:'wx'});
 try{
  JSON.parse(fs.readFileSync(temp,'utf8').replace(/^\uFEFF/,''));
  const existed=fs.existsSync(target);
  if(existed)fs.renameSync(target,backup);
  try{fs.renameSync(temp,target);}catch(error){if(existed&&fs.existsSync(backup))fs.renameSync(backup,target);throw error;}
  const saved=fs.readFileSync(target,'utf8');
  if(saved!==text){
   fs.rmSync(target,{force:true});if(existed&&fs.existsSync(backup))fs.renameSync(backup,target);
   throw Error('JSON output readback mismatch');
  }
  if(fs.existsSync(backup))fs.rmSync(backup,{force:true});
  return {file:target,utf8_bytes:Buffer.byteLength(text,'utf8')};
 }finally{
  if(fs.existsSync(temp))fs.rmSync(temp,{force:true});
 }
}

function emitJson(value,out=''){
 if(out){const info=atomicWriteJson(out,value);process.stdout.write(encode(info));return info;}
 process.stdout.write(encode(value));return null;
}

module.exports={extractOut,atomicWriteJson,emitJson,encode};