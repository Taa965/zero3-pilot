import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectLinks } from './project-links.mjs'
import { resolveWorkspaceScope } from '../memory-sync-runtime/workspace-scope.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'project-links-'))
  const project = { id: 'project-one', name: 'Test project', rootPath: path.join(root,'workspace') }
  fs.mkdirSync(project.rootPath)
  const stateDir = path.join(root,'state'), calls = []
  const native = { home: root,
    list: async provider => [{ id: provider === 'claude' ? project.rootPath : `${provider}-existing`, name: provider, rootPath: project.rootPath }],
    create: async provider => { calls.push(provider); return { id: provider + '-new', name: provider, rootPath: project.rootPath } },
    configureClaude: async () => {}, codex: async (method,params) => { calls.push({method,params}); return {} }
  }
  const options = { stateDir, native, getProject: async id => ({ ...project, id }), mcp: { command: process.execPath, args: ['/fixture/server.mjs'], env: { ZERO3_SHARED_MEMORY_CONFIG: '/private/config.json' } } }
  const service = new ProjectLinks(options)
  t.after(() => { service.close(); fs.rmSync(root,{recursive:true,force:true}) })
  return {root, project, stateDir, native, calls, service, options}
}
test('three providers independently list native projects and isolate unavailable providers', async t => {
  const {service,native}=fixture(t)
  const list=native.list; native.list=async provider=>{if(provider==='claude')throw new Error('not installed');return list(provider)}
  const rows=await service.list('project-one')
  assert.equal(rows.length,3);assert.equal(rows[1].error,'not installed');assert.equal(rows[0].projects.length,1)
})
test('create and retry use a real native ID, preserve other MCPs, and map future global sessions', async t => {
  const {service,project,stateDir,calls}=fixture(t)
  const prior=resolveWorkspaceScope({cwd:project.rootPath,config:{cacheDir:path.join(stateDir,'cache')}}).projectId
  fs.mkdirSync(path.join(project.rootPath,'.codex'))
  fs.writeFileSync(path.join(project.rootPath,'.codex','config.toml'),'[mcp_servers.other]\ncommand = "other"\n')
  const request={projectId:project.id,provider:'codex',mode:'create'}
  const bound=await service.connect(request)
  assert.equal(bound.externalId,'codex-new');assert.equal(bound.state,'ready')
  await service.connect(request);assert.deepEqual(calls,['codex'])
  const config=fs.readFileSync(path.join(project.rootPath,'.codex','config.toml'),'utf8')
  assert.ok(config.includes('[mcp_servers.other]'));assert.equal(config.match(/BEGIN ZERO3/g).length,1)
  assert.equal(resolveWorkspaceScope({cwd:project.rootPath,config:{cacheDir:path.join(stateDir,'cache'),projectLinksFile:path.join(stateDir,'project-links.sqlite')}}).projectId,project.id)
  assert.equal(resolveWorkspaceScope({cwd:project.rootPath,config:{cacheDir:path.join(stateDir,'cache')}}).projectId,prior,'old automatic identity is retained')
  await assert.rejects(()=>service.connect({...request,projectId:'project-two'}),/另一个/)
  assert.deepEqual(calls,['codex'],'scope conflict rejected before native creation')
})
test('failed setup persists created native identity and retries without duplicate creation',async t=>{
  const {service,native,calls,project,stateDir}=fixture(t)
  native.configureClaude=async()=>{throw new Error('offline')}
  const request={projectId:'project-one',provider:'claude',mode:'create'}
  await assert.rejects(()=>service.connect(request),/offline/)
  assert.equal(service.get('project-one','claude').state,'setup_failed')
  assert.notEqual(resolveWorkspaceScope({cwd:project.rootPath,config:{cacheDir:path.join(stateDir,'cache'),projectLinksFile:path.join(stateDir,'project-links.sqlite')}}).projectId,project.id,'failed setup is not published as an active memory association')
  await assert.rejects(()=>service.resolve('project-one','claude'),/尚未完成/)
  native.configureClaude=async()=>{}
  assert.equal((await service.connect(request)).state,'ready');assert.deepEqual(calls,['claude'])
})
test('unknown native creation outcome cannot be blindly retried; selecting known project recovers',async t=>{
  const {service,native}=fixture(t)
  native.create=async()=>{throw new Error('timeout')}
  const request={projectId:'project-one',provider:'antigravity',mode:'create'}
  await assert.rejects(()=>service.connect(request),/timeout/)
  await assert.rejects(()=>service.connect(request),/结果未确认/)
  const result=await service.connect({...request,mode:'existing',externalId:'antigravity-existing'})
  assert.equal(result.state,'ready')
})

test('a CLI startup failure allows retry after installation without treating it as an unknown creation',async t=>{
  const {service,native}=fixture(t)
  const create=native.create
  native.create=async()=>{throw Object.assign(new Error('not installed'),{noProjectCreated:true})}
  const request={projectId:'project-one',provider:'codex',mode:'create'}
  await assert.rejects(()=>service.connect(request),/not installed/)
  native.create=create
  assert.equal((await service.connect(request)).state,'ready')
})
test('concurrent clicks cannot create twice and project metadata assignment uses selected native ID',async t=>{
  const {service,native,project,calls}=fixture(t)
  let release
  native.create=()=>new Promise(resolve=>{release=()=>resolve({id:'native-project',name:'native',rootPath:project.rootPath})})
  const request={projectId:project.id,provider:'codex',mode:'create'}
  const first=service.connect(request)
  await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(()=>service.connect(request),/正在进行/)
  await assert.rejects(()=>service.connect({...request,projectId:'project-two'}),/另一个/)
  release();await first
  await service.attachCodexThread({projectId:project.id,externalId:'native-project',threadId:'thread-existing'})
  assert.deepEqual(calls[0],{method:'thread/metadata/update',params:{threadId:'thread-existing',projectId:'native-project'}})
  await service.connect({...request,mode:'existing',externalId:'codex-existing'})
  await service.attachCodexThread({projectId:project.id,externalId:'native-project',threadId:'thread-existing'})
  assert.equal(calls[1].params.projectId,'native-project','an existing session retains its previously approved native project')
})
