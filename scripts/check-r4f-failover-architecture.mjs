import fs from 'node:fs'
const file = fs.readFileSync('apps/zero3-desktop/executor-runtime/router/failover-controller.ts', 'utf8')
const requireText = (text, message) => { if (!file.includes(text)) throw new Error(message) }
const forbidText = (text, message) => { if (file.includes(text)) throw new Error(message) }
for (const code of ['quota_exhausted', 'rate_limited', 'provider_overloaded', 'provider_error', 'transport_lost', 'process_crash', 'context_lost', 'context_exhausted', 'auth_required', 'user_stopped']) requireText(code, `missing explicit R4F handling: ${code}`)
requireText('failurePolicyFor(code)', 'R4F safety must consume Zero3-owned frozen failure policy')
requireText('maxRetries', 'bounded retry missing')
requireText('cooldownUntilMs', 'provider cooldown missing')
requireText('circuitOpenUntilMs', 'circuit breaker missing')
requireText('commitVerifiedSwitch', 'switch must wait for verified handoff commit')
requireText('switch already pending handoff verification', 'recursive failover guard missing')
requireText("version: 'zero3.pilot.failover.v1'", 'restart snapshot version missing')
for (const forbidden of ['allowFailover', '@agentclientprotocol', 'acpx', 'Zero3CodexAppServer', 'child_process', 'ipcRenderer', 'http://', 'https://']) forbidText(forbidden, `R4F authority leak: ${forbidden}`)
console.log('Zero3 Pilot R4F failover architecture guard passed.')
