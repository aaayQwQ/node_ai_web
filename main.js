'use strict';
const fs=require('fs'),path=require('path');
const ROOT=__dirname;
for(const d of ['config','logs','src','public','plugins/sys-prompt-injector','scripts']) fs.mkdirSync(path.join(ROOT,d),{recursive:true});
const cfg=path.join(ROOT,'config/config.json');
if(!fs.existsSync(cfg)) fs.writeFileSync(cfg,JSON.stringify({host:'127.0.0.1',port:3001,baseURL:'https://api.deepseek.com',apiKey:'',model:'deepseek-chat',systemPrompt:'You are a helpful assistant.',webPassword:'',temperature:0.7,enabledPlugins:['sys-prompt-injector']},null,2));
if(!fs.existsSync(path.join(ROOT,'config/history.json'))) fs.writeFileSync(path.join(ROOT,'config/history.json'),'[]');
require('./src/server').start(ROOT);
