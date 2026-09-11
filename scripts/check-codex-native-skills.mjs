import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const overlay = read('apps/zero3-desktop/scripts/apply-codex-skills.mjs')
const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const gateway = read('apps/web/src/worker_gateway.rs')
const skillRpc = read('apps/zero3-desktop/host-runtime/remote-skill-rpc.ts')
const remoteNode = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const remoteConfig = read('apps/zero3-desktop/host-runtime/remote-config.ts')
const ui = read('apps/zero3-desktop/ui-v2/skills/SkillWorkspace.tsx')
const router = read('apps/zero3-desktop/skill-runtime/skill-router.ts')
const bindings = read('apps/zero3-desktop/skill-runtime/skill-binding-store.ts')
const orchestrator = read('apps/zero3-desktop/agent-routing-runtime/agent-runtime-orchestrator.ts')
const codexTask = read('apps/zero3-desktop/agent-routing-runtime/codex-task-adapter.ts')
const remoteRunner = read('apps/zero3-desktop/host-runtime/remote-task-runner.ts')

for (const method of ['skills/list', 'skills/extraRoots/set', 'skills/config/write']) requireText(overlay, method, `Codex native Skill overlay missing ${method}`)
requireText(overlay, "name: 'skill-installer'", 'Skill install must delegate to Codex skill-installer.')
requireText(overlay, "type: 'skill'", 'Skill invocation must use native Codex skill UserInput.')
requireText(prepare, 'applyZero3CodexStructuredInput()\napplyZero3CodexSkills()', 'Native Skill overlay must run after structured Turn input.')
for (const forbidden of ['SkillRegistry', 'skill_packages', 'skill-registry']) forbidText(overlay, forbidden, `Zero3 must not create a second Skill authority: ${forbidden}`)

requireText(gateway, '.route("/mcp/skills", post(skill_mcp_handler))', 'Web Skill MCP must have an independent route.')
requireText(gateway, 'ZERO3_SKILL_MCP_TOKEN_FILE', 'Web Skill MCP must have an independent bearer secret.')
requireText(gateway, 'SKILL_TOOLS: [&str; 4] = ["list_skills", "search_skills", "get_skill", "invoke_skill"]', 'Web Skill MCP tool catalog must stay bounded.')
requireText(gateway, 'assert!(!worker.contains("invoke_skill"))', 'Worker protocol regression must prove Skill invocation is absent.')
requireText(skillRpc, 'skills.map(publicSkill)', 'Web list results must project metadata instead of raw Skill paths.')
requireText(skillRpc, "{ type: 'skill', name: skill.name, path: skill.path }", 'Local invocation must resolve a native Skill path immediately before execution.')
requireText(remoteNode, 'zero3RemoteWorkspaceAllowed(this.config, requested)', 'Web Skill invocation cwd must be allow-listed locally.')
requireText(remoteConfig, '(enabled || skillTunnelEnabled) && allowedWorkspaces.length === 0', 'Skill tunnel must fail closed without an allow-listed workspace.')
requireText(read('apps/zero3-desktop/ui-v2/skills/SkillInstallPanel.tsx'), 'Codex 原生 skill-installer', 'Skills UI must identify Codex as installer authority.')
requireText(ui, 'Skill Detail / Binding', 'Skills UI must expose native detail and relation-only Binding management.')
requireText(bindings, 'class Zero3SkillBindingStore', 'Zero3 Binding must be a relation-only store.')
forbidText(bindings, 'SKILL.md', 'Binding store must never copy Skill body content.')
requireText(router, 'class Zero3SkillRouter', 'Task Skill Router is missing.')
requireText(router, 'MAX_ROUTED_SKILLS = 3', 'Task Skill Router must have a bounded Top-N.')
requireText(orchestrator, 'taskStore.setSkills', 'Task Ledger must record resolved Skill references.')
requireText(orchestrator, "recordSkillUsage(task, route.target", 'Task Runtime must record Skill usage outcomes.')
requireText(codexTask, 'native_skills', 'Codex Task adapter must carry native Skill references.')
requireText(remoteRunner, "type: 'skill'", 'Codex Remote Task runner must convert resolved Skills into native Skill UserInput.')

console.log('Codex Native Skills architecture guard passed: one Codex Skill source -> desktop management/bindings -> Task Router/Ledger -> native/adapted Agent execution -> isolated Web Skill MCP.')
