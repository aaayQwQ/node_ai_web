'use strict';
const fs=require('fs'),path=require('path'),https=require('https'),http=require('http');
const ROOT=__dirname;
for(const d of ['config','logs','src','public','plugins/sys-prompt-injector','scripts']) fs.mkdirSync(path.join(ROOT,d),{recursive:true});
const cfg=path.join(ROOT,'config/config.json');
if(!fs.existsSync(cfg)) fs.writeFileSync(cfg,JSON.stringify({host:'127.0.0.1',port:3001,baseURL:'https://api.deepseek.com',apiKey:'',model:'deepseek-chat',systemPrompt:'You are a helpful assistant.',webPassword:'',temperature:0.7,enabledPlugins:['sys-prompt-injector']},null,2));
if(!fs.existsSync(path.join(ROOT,'config/history.json'))) fs.writeFileSync(path.join(ROOT,'config/history.json'),'[]');
if(process.argv.includes('--check')){
  let c;try{c=JSON.parse(fs.readFileSync(cfg,'utf8'));console.log('Config JSON: OK')}catch(e){console.error('Config JSON: FAIL - '+e.message);process.exit(1)}
  const major=Number(process.versions.node.split('.')[0]);console.log('Node.js: '+process.version+(major>=12?' (supported)':' (old; Node 12+ recommended)'));
  if(!c.baseURL){console.log('Upstream URL: not configured');process.exit(0)}
  try{const u=new URL(c.baseURL);const lib=u.protocol==='http:'?http:https;const req=lib.request({hostname:u.hostname,port:u.port||undefined,path:(u.pathname.replace(/\/$/,'')||'')+'/v1/models',method:'GET',timeout:8000,headers:c.apiKey?{Authorization:'Bearer '+c.apiKey}:{}},res=>{console.log('Upstream HTTP: '+res.statusCode);res.resume();process.exitCode=res.statusCode<500?0:1});req.on('timeout',()=>{console.error('Upstream check timed out');req.destroy();process.exitCode=1});req.on('error',e=>{console.error('Upstream check failed: '+e.message);process.exitCode=1});req.end()}catch(e){console.error('Upstream URL invalid: '+e.message);process.exit(1)}
}else require('./src/server').start(ROOT);
