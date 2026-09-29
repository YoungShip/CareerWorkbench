'use strict';
const fs=require('node:fs'),path=require('node:path');
// Read old frozen references without rewriting their contents or hashes.
function resolveArtifactPath(value,project=path.resolve(__dirname,'..')){
 if(typeof value!=='string'||!path.isAbsolute(value))return value;
 const absolute=path.resolve(value);
 if(fs.existsSync(absolute)||path.basename(project)!=='CareerWorkbench')return absolute;
 const legacy=path.join(path.dirname(project),'JobHuntBot');
 const rel=path.relative(legacy,absolute);
 if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return absolute;
 const candidate=path.join(project,rel);
 return fs.existsSync(candidate)?candidate:absolute;
}
module.exports={resolveArtifactPath};
