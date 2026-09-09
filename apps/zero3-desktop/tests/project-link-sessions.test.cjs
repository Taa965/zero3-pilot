const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const os=require('node:os')
const vm=require('node:vm')
const {createRequire}=require('node:module')
const {EventEmitter}=require('node:events')
const {PassThrough}=require('node:stream')
const root=path.resolve(__dirname,'..')
const desktopRequire=createRequire(path.resolve(root,'../../upstream/hermes-agent/apps/desktop/package.json'))
const ts=desktopRequire('typescript')
function load(relative,overrides={},globals={}) {
  const file=path.join(root,relative), exports={}
  const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const localRequire=name=>Object.hasOwn(overrides,name)?overrides[name]:name.startsWith('.')?load(path.relative(root,path.resolve(path.dirname(file),name+'.ts')),overrides,globals):require(name)
  vm.runInNewContext(compiled,{exports,require:localRequire,process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,URL,...globals},{filename:file})
  return exports
}
test('provider association is an immutable session snapshot across edits and reloads',()=>{
  const storage=new Map(), window={localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},dispatchEvent(){}}
  const globals={window,crypto:require('node:crypto').webcrypto,CustomEvent:class{}}
  const adapter=load('ui-v2/adapters/LocalSessionAdapter.ts',{},globals).LocalSessionAdapter
  const binding={provider:'codex',externalId:'native-old',rootPath:'C:\\original',revision:1}
  const created=adapter.create('codex','zero3',null,{projectBinding:binding})
  binding.externalId='native-new';binding.rootPath='C:\\new'
  adapter.setRuntimeId(created.id,'thread-one');adapter.markNativeProjectAttached(created.id)
  const reopened=load('ui-v2/adapters/LocalSessionAdapter.ts',{},globals).LocalSessionAdapter.get(created.id)
  assert.equal(reopened.projectBinding.externalId,'native-old');assert.equal(reopened.projectBinding.rootPath,'C:\\original');assert.equal(reopened.nativeProjectAttached,true)
  assert.equal(adapter.create('claude',null).projectBinding,null)
})
test('Antigravity launches selected native project and directory, resumes same conversation, rejects switching',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-link-session-')), calls=[]
  const childProcess={...require('node:child_process'),spawn:(_bin,args)=>{
    calls.push(args)
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,exitCode:null,kill(){this.killed=true}})
    setTimeout(()=>child.stdout.write(JSON.stringify({event:'init',conversation_id:'conversation-native'})+'\n'),10)
    return child
  }}
  const Adapter=load('antigravity-runtime/antigravity-adapter.ts',{'node:child_process':childProcess}).Zero3AntigravityAdapter
  const adapter=new Adapter(path.join(dir,'sessions.json'));adapter.resolveBinary=()=>process.execPath
  try {
    const first=await adapter.ensureRuntime('local-one',dir,'zero3',null,null,'native-selected')
    assert.equal(calls[0][calls[0].indexOf('--project')+1],'native-selected')
    assert.equal(calls[0][calls[0].indexOf('--add-dir')+1],dir)
    await assert.rejects(()=>adapter.ensureRuntime('local-one',dir,'zero3',null,null,'other'),/关联已改变/)
    first.child.killed=true
    await adapter.ensureRuntime('local-one',dir,'zero3',null,null,'native-selected')
    assert.equal(calls[1][calls[1].indexOf('--conversation')+1],'conversation-native')
    assert.equal(calls[1].includes('--project'),false)
  } finally {
    for(const handle of adapter.handles.values())handle.child.kill()
    await new Promise(resolve=>setTimeout(resolve,50))
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
