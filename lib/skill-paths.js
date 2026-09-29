'use strict';
const fs=require('node:fs'),path=require('node:path');

// 检查本工作区的技能文件位置；文件可读不表示客户端已加载。
function targetSkillsRoot(workspace,client){
 const configured=path.join(workspace,'.'+client,'skills');
 if(client==='codex'&&!fs.existsSync(configured)){
  return {root:path.join(workspace,'.agents','skills'),basis:'canonical_workspace_files',runtime_loading:'unverified'};
 }
 return {root:configured,basis:'client_skills_directory',runtime_loading:'unverified'};
}
module.exports={targetSkillsRoot};
