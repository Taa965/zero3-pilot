import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NativeProjects } from './native-projects.mjs'

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-projects-'))
  const script=path.join(home,'cli.mjs')
  fs.writeFileSync(script, String.raw`
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const [provider,...args]=process.argv.slice(2), home=process.env.TEST_PROJECT_HOME;
fs.writeFileSync(path.join(home,'args.json'),JSON.stringify(args));
if(provider==='codex') {
  const lines=readline.createInterface({input:process.stdin});
  lines.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
    let result={};
    if(m.method==='initialize'&&!m.params.capabilities.experimentalApi)process.exit(5);
    if(m.method==='project/create')result={project:{id:'native-id',name:m.params.name}};
    if(m.method==='project/list')result={data:[{id:'native-id',name:'Native',roots:[{path:home}]}],nextCursor:null};
    console.log(JSON.stringify({id:m.id,result}));
  });
} else if(provider==='antigravity') {
  if(!args.includes('--new-project')||!args.includes('--add-dir')||args.includes('--prompt'))process.exit(6);
  const dir=path.join(home,'.gemini','config','projects');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'native.json'),JSON.stringify({id:'agy-native',name:'Native project'}));
  console.log(JSON.stringify({event:'init',conversation_id:'fixture-conversation'}));
  process.stdin.on('data',()=>process.exit(7));process.stdin.resume();
} else {
  if(args.slice(0,4).join(' ')!=='mcp add-json --scope local')process.exit(8);
  JSON.parse(args[5]);
}
`)
  const native=new NativeProjects({home,env:{...process.env,TEST_PROJECT_HOME:home},codexEnv:{...process.env,TEST_PROJECT_HOME:home},resolveCommand:provider=>({command:process.execPath,args:[script,provider==='agy'?'antigravity':provider]})})
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  return {home,native}
}
test('Codex project protocol initializes experimental API and uses returned identity',async t=>{
  const {home,native}=fixture(t)
  assert.equal((await native.create('codex',{id:'zero3',name:'Example',rootPath:home})).id,'native-id')
  assert.equal((await native.list('codex',home))[0].id,'native-id')
})
test('Antigravity creation initializes native CLI without a model prompt and confirms catalog identity',async t=>{
  const {home,native}=fixture(t)
  const result=await native.create('antigravity',{id:'zero3',name:'Example',rootPath:home})
  assert.equal(result.id,'agy-native');assert.equal(result.rootPath,home)
  const args=JSON.parse(fs.readFileSync(path.join(home,'args.json'),'utf8'))
  assert.equal(args[args.indexOf('--add-dir')+1],home)
})
test('Claude uses supported local MCP command and canonical catalog deduplication',async t=>{
  const {home,native}=fixture(t)
  await native.configureClaude(home,{command:'node',args:['/server.mjs'],env:{ZERO3_ACTIVE_PROJECT_ID:'zero3'}})
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({projects:{[home]:{},[home+path.sep]:{},[path.join(home,'missing')]:{}}}))
  assert.equal((await native.list('claude',home)).length,1)
})
