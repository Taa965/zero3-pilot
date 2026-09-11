import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createExecutionDesktopRuntime } from '../execution-runtime/desktop/desktop-runtime.ts'
import { makeStep, makeTask } from '../ui-v2/tasks/task-model.ts'

// Run after installing the pinned Hermes workspace dependencies.
// An isolated, real execution store is used; no user tasks or sessions are touched.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dependencies = process.env.ZERO3_UI_TEST_DEPENDENCIES || path.join(repo, 'upstream/hermes-agent')
const require = createRequire(path.join(dependencies, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')
const { compile } = require('@tailwindcss/node')
const ui = path.join(repo, 'apps/zero3-desktop/ui-v2/tasks')
const temp = await mkdtemp(path.join(tmpdir(), 'zero3-task-browser-'))
const output = path.join(repo, 'output/task-workspace')
fs.mkdirSync(output, { recursive: true })
const desktop = createExecutionDesktopRuntime(path.join(temp, 'execution'), {
  reporterClientPath: path.join(repo, 'apps/zero3-desktop/execution-runtime/zero3-exec.mjs'), reporterClientKind: 'node',
  skillCapabilityProvider: {
    matrix: async () => ({ agents: [{ executor: 'CODEX', adapterMode: 'native', available: true }] }),
    preflight: async (_task, step) => ({
      state: 'not_required', executor: 'CODEX', adapterMode: 'native',
      requiredSkills: [...(step.requiredSkills ?? [])], optionalSkills: [...(step.optionalSkills ?? [])],
      availableRequiredSkills: [...(step.requiredSkills ?? [])], availableOptionalSkills: [...(step.optionalSkills ?? [])],
      missingRequiredSkills: [], missingOptionalSkills: [], checkedAt: new Date().toISOString()
    })
  }
})
let browser
let server
try {
  const result = await build({ stdin: { contents: `
    import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
    import { TaskProvider } from ${JSON.stringify(path.join(ui,'TaskContext.tsx'))};
    import { TaskList } from ${JSON.stringify(path.join(ui,'TaskList.tsx'))};
    import { TaskWorkspace } from ${JSON.stringify(path.join(ui,'TaskWorkspace.tsx'))};
    createRoot(document.getElementById('root')).render(<StrictMode><TaskProvider active={true}><div style={{height:'100vh',display:'flex'}}><aside style={{width:288,flexShrink:0,borderRight:'1px solid #ddd'}}><TaskList/></aside><main style={{flex:1,minWidth:0}}><TaskWorkspace/></main></div></TaskProvider></StrictMode>);
  `, resolveDir: dependencies, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', nodePaths: [path.join(dependencies,'node_modules')], format: 'iife' })
  const source = fs.readdirSync(ui).filter(file=>/tsx?$/.test(file)).map(file=>fs.readFileSync(path.join(ui,file),'utf8')).join('\n')
  const compiler = await compile('@import "tailwindcss"; @theme { --color-background: #ffffff; --color-foreground: #172033; }', { base: dependencies, onDependency() {} })
  const css = compiler.build(source.split(/[\s"'`{}]+/)) + '\n:root {--ui-border:#dce0e7;--ui-text-secondary:#556174;--ui-text-tertiary:#687489;--ui-pane-background:#f6f8fb;--ui-control-active-background:#eaf0fc;--ui-control-hover-background:#eef2f7;font-family:system-ui,sans-serif} body{margin:0}'
  server = http.createServer((request,response) => {
    if(request.url==='/bundle.js') { response.setHeader('Content-Type','text/javascript'); response.end(result.outputFiles[0].text) }
    else if(request.url==='/style.css') {response.setHeader('Content-Type','text/css');response.end(css)}
    else { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>') }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser = await chromium.launch({headless:true,channel:process.env.ZERO3_TEST_BROWSER_CHANNEL || 'chrome'})
  const page = await browser.newPage({ viewport:{width:1280,height:900} })
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const methods=['listTasks','setTaskArchived','deleteTask','listTaskWorkflows','createWorkflowTask','createTask','addSteps','createAssignment','createRoutedAssignment','refreshSkillPreflight','bindSession','transitionStep','gatePassed','gateFailed']
  await page.exposeFunction('taskRpc',async(method,args)=>{
    if(!methods.includes(method)) throw new Error('unsupported test operation')
    return desktop[method](...args)
  })
  await page.addInitScript(methods=>{ window.zero3Execution=Object.fromEntries(methods.map(method=>[method,(...args)=>window.taskRpc(method,args)])) },methods)
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('暂无任务，点击“新建任务”开始。').waitFor()
  await page.getByRole('button',{name:'＋ 新建任务',exact:true}).click()
  await page.getByLabel('任务名称',{exact:true}).fill('任务板块端到端验收')
  await page.getByLabel('任务说明').fill('验证工作流生成、真实持久化、审核与依赖释放')
  await page.getByLabel('工作流',{exact:true}).selectOption({ label: '软件开发工作流' })
  await page.getByRole('button',{name:'创建任务',exact:true}).click()
  await page.getByRole('heading',{name:'任务板块端到端验收'}).waitFor()
  let [snapshot]=await desktop.listTasks()
  const id=snapshot.definition.task.taskId
  const [first,second]=snapshot.definition.steps
  await page.getByRole('button',{name:'执行过程',exact:true}).click()
  await page.getByRole('button',{name:'自动路由并分配',exact:true}).click()
  await page.getByLabel('方案与影响分析会话编号').fill('test-codex-session')
  await page.getByRole('button',{name:'绑定会话',exact:true}).click()
  await page.getByText('会话：test-codex-session · active').waitFor()
  await desktop.runtime.transitionStep(id,first.stepId,'running')
  await desktop.runtime.recordProgress(id,first.stepId,0.6,'页面与数据接通')
  await desktop.runtime.recordArtifact(id,first.stepId,{logicalName:'task-ui.patch',kind:'diff',diff:'- demo\n+ persistent tasks',artifactId:'test-patch'})
  await desktop.runtime.requestCompletion(id,first.stepId)
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.getByRole('button',{name:'审核',exact:true}).click()
  await page.getByRole('button',{name:'通过',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'通过',exact:true}).isDisabled(),true)
  await page.getByLabel('方案与影响分析处理说明').fill('请补充验证证据')
  await page.getByRole('button',{name:'要求修改',exact:true}).click()
  await page.getByText('需要修改 · 95%',{exact:true}).waitFor()
  await desktop.runtime.requestCompletion(id,first.stepId)
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.getByLabel('方案与影响分析处理说明').fill('已核对差异和测试记录')
  await page.getByRole('button',{name:'通过',exact:true}).click()
  await page.getByText('已完成 · 100%',{exact:true}).waitFor()
  assert.equal((await desktop.runtime.snapshot(id)).runtime.steps[1].status,'ready')
  for(const name of ['总览','执行过程','代码变更','产物','验证','审核','时间轴']) {
    await page.getByRole('button',{name,exact:true}).click()
    assert.equal(await page.getByText(/视图建设中|UI2-GEMINI-001|npm typecheck/).count(),0)
  }
  await page.getByRole('button',{name:'代码变更',exact:true}).click()
  await page.getByText('- demo\n+ persistent tasks', {exact:true}).waitFor()
  await page.getByLabel('搜索任务').fill('不存在的任务')
  await page.getByText('没有符合筛选条件的任务。').waitFor()
  await page.getByLabel('搜索任务').fill('')
  await page.reload()
  await page.getByRole('heading',{name:'任务板块端到端验收'}).waitFor()
  await page.getByRole('button',{name:'执行过程',exact:true}).click()
  await page.getByLabel('实现变更处理说明').fill('转交人工确认')
  const secondCard=page.locator('article').filter({has:page.getByRole('heading',{name:'实现变更',exact:true})})
  await secondCard.getByRole('button',{name:'转人工',exact:true}).click()
  await page.getByText('等待人工 · 0%',{exact:true}).waitFor()
  await page.getByRole('button',{name:'待审核',exact:true}).click()
  assert.equal(await page.locator('aside').getByText('任务板块端到端验收',{exact:true}).count(),1)
  await page.getByLabel('实现变更处理说明').fill('等待补充材料')
  await secondCard.getByRole('button',{name:'标记阻塞',exact:true}).click()
  await page.getByText('阻塞 · 0%',{exact:true}).waitFor()
  await page.getByRole('button',{name:'异常',exact:true}).click()
  assert.equal(await page.locator('aside').getByText('任务板块端到端验收',{exact:true}).count(),1)
  await page.getByRole('button',{name:'总览',exact:true}).click()
  await page.screenshot({path:path.join(output,'task-overview.png'),fullPage:true})
  await page.getByRole('button',{name:'审核',exact:true}).click()
  await page.screenshot({path:path.join(output,'task-review.png'),fullPage:true})
  const cancelledFirst=makeStep('前置准备','CODEX'), cancelledNext=makeStep('后续执行','CODEX',[cancelledFirst.stepId])
  const cancelledInput=makeTask('前置取消验收','验证前置取消提示',null,[cancelledFirst,cancelledNext])
  await desktop.createTask(cancelledInput)
  await desktop.transitionStep(cancelledInput.task.taskId,cancelledFirst.stepId,'cancelled','不再需要')
  await page.getByRole('button',{name:'全部',exact:true}).click()
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.locator('aside').getByText('前置取消验收',{exact:true}).click()
  await page.getByRole('button',{name:'执行过程',exact:true}).click()
  await page.getByText('前置步骤已取消，此步骤无法开始；如不再需要，请填写说明后取消此步骤。',{exact:true}).waitFor()
  const nextCard=page.locator('article').filter({has:page.getByRole('heading',{name:'后续执行',exact:true})})
  assert.equal(await nextCard.getByRole('button',{name:'恢复待执行',exact:true}).count(),0)
  await page.getByLabel('后续执行处理说明').fill('前置已取消')
  await nextCard.getByRole('button',{name:'取消步骤',exact:true}).click()
  await page.locator('header').getByText(/^已取消 · \d+%$/).waitFor()
  assert.equal((await desktop.runtime.snapshot(cancelledInput.task.taskId)).runtime.task.status,'cancelled')
  // Right-click archive / unarchive / delete.
  const aside=page.locator('aside')
  const cancelledTitle=aside.getByText('前置取消验收',{exact:true})
  await cancelledTitle.click({button:'right'})
  await page.getByRole('menu',{name:'任务操作'}).waitFor()
  await page.getByRole('menuitem',{name:'归档任务',exact:true}).click()
  await page.getByRole('button',{name:'归档',exact:true}).click()
  await aside.getByText('前置取消验收',{exact:true}).waitFor()
  await aside.getByText('已归档',{exact:true}).waitFor()
  assert.equal((await desktop.runtime.snapshot(cancelledInput.task.taskId)).archived,true)
  await page.getByRole('button',{name:'全部',exact:true}).click()
  assert.equal(await aside.getByText('前置取消验收',{exact:true}).count(),0)
  assert.equal(await aside.getByText('任务板块端到端验收',{exact:true}).count(),1)
  await page.getByRole('button',{name:'归档',exact:true}).click()
  await aside.getByText('前置取消验收',{exact:true}).click({button:'right'})
  await page.getByRole('menuitem',{name:'取消归档',exact:true}).click()
  await page.getByRole('button',{name:'全部',exact:true}).click()
  await aside.getByText('前置取消验收',{exact:true}).waitFor()
  assert.equal((await desktop.runtime.snapshot(cancelledInput.task.taskId)).archived,false)
  await aside.getByText('前置取消验收',{exact:true}).click({button:'right'})
  await page.getByRole('menuitem',{name:'删除任务',exact:true}).click()
  await page.getByRole('dialog',{name:'删除任务确认'}).getByRole('button',{name:'确认删除',exact:true}).click()
  await aside.getByText('前置取消验收',{exact:true}).waitFor({state:'detached'})
  assert.equal(await aside.getByText('前置取消验收',{exact:true}).count(),0)
  assert.equal((await desktop.listTasks()).length,1)
  await page.evaluate(()=>{window.zero3Execution.listTasks=async()=>{throw new Error('测试断连')}})
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.getByRole('alert').getByText('测试断连').waitFor()
  assert.equal((await desktop.runtime.snapshot(id)).runtime.steps[1].status,'blocked')
  assert.deepEqual(errors,[])
  console.log('Task browser acceptance passed: create, persist/reload, assign/bind, progress/artifact, reject/approve, dependency release, seven tabs, search/filters, human/block, cancelled dependency, right-click archive/unarchive/delete, disconnect.')
} finally {
  await browser?.close()
  if(server) await new Promise(resolve=>server.close(resolve))
  await desktop.stop()
  if(path.dirname(temp)!==tmpdir() || !path.basename(temp).startsWith('zero3-task-browser-')) throw new Error('unexpected fixture cleanup path')
  await rm(temp,{recursive:true,force:true})
}
