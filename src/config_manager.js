'use strict';
const fs=require('fs'),path=require('path');
module.exports=function(root){const file=path.join(root,'config/config.json');function read(){return JSON.parse(fs.readFileSync(file,'utf8'))}function write(v){fs.writeFileSync(file,JSON.stringify(v,null,2));return v}return {read,write,file};};
