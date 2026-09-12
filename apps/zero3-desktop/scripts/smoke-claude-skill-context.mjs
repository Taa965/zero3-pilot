// End-to-end smoke: Zero3's instruction adapter renders a Codex SKILL.md as
// bounded prompt context (renderZero3SkillContext, the exact function the
// Claude task adapter dispatches with) and the real Claude CLI must answer
// from that injected context alone.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { renderZero3SkillContext } from '../skill-runtime/skill-catalog.ts'
import { resolveCodexHome } from './config.mjs'

const defaultSkill = path.join(resolveCodexHome(), 'skills', '.system', 'review-agent', 'SKILL.md')
const skillPath = process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : defaultSkill
if (!fs.existsSync(skillPath)) throw new Error(`skill document not found: ${skillPath}`)

const document = fs.readFileSync(skillPath, 'utf8')
const name = /^name:\s*(.+)$/m.exec(document)?.[1]?.trim() || path.basename(path.dirname(skillPath))
const description = /^description:\s*(.+)$/m.exec(document)?.[1]?.trim()
if (!description) throw new Error(`no description frontmatter in ${skillPath}`)

const context = await renderZero3SkillContext([{ name, path: skillPath, enabled: true }])
if (!context.includes('[ZERO3 CODEX NATIVE SKILL:')) throw new Error('skill context renderer produced no block')

const prompt = context
  + '\n\n---\n以上是唯一资料来源。严格只依据该技能文档回答，不要使用任何外部知识：'
  + '这个技能的 name 和 frontmatter description 字段的值分别是什么？用两行回答，每行格式为 key: value。'

const timeoutMs = 240_000
const child = spawn('claude', ['-p', '--output-format', 'text'], {
  shell: true,
  cwd: path.resolve(import.meta.dirname, '../../..'),
  env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7897', HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7897' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += String(chunk) })
child.stderr.on('data', chunk => { stderr += String(chunk) })
const timer = setTimeout(() => child.kill(), timeoutMs)
child.stdin.end(prompt)

child.on('exit', code => {
  clearTimeout(timer)
  const output = stdout.trim()
  console.log(`skill: ${name} (${skillPath})`)
  console.log(`claude exit=${code}, output bytes=${output.length}`)
  if (code !== 0 || !output) {
    console.error('SMOKE FAIL: claude cli produced no answer')
    if (stderr.trim()) console.error('stderr: ' + stderr.trim().slice(0, 500))
    console.error('stdout: ' + output.slice(0, 500))
    process.exit(1)
  }
  console.log('--- claude output ---')
  console.log(output.slice(0, 600))
  const normalized = output.replace(/\s+/g, ' ').toLowerCase()
  const expected = description.replace(/\s+/g, ' ').toLowerCase()
  if (!normalized.includes(expected.slice(0, Math.min(60, expected.length)))) {
    console.error('SMOKE FAIL: answer does not contain the skill frontmatter description')
    process.exit(1)
  }
  console.log('SMOKE PASS: Claude answered from the injected Zero3 skill context')
})
