'use strict';
const fs=require('fs'),path=require('path');
module.exports=function(root){return function(level,message){const dir=path.join(root,'logs');fs.mkdirSync(dir,{recursive:true});const day=new Date().toISOString().slice(0,10);const line='['+new Date().toISOString()+'] ['+level+'] '+String(message).replace(/sk-[A-Za-z0-9_-]+/g,'sk-***')+'\n';try{fs.appendFileSync(path.join(dir,day+'.log'),line);const files=fs.readdirSync(dir).filter(x=>/^\d{4}-\d{2}-\d{2}\.log$/.test(x)).sort();while(files.length>14)fs.unlinkSync(path.join(dir,files.shift()));}catch(_){} };};
