# Codex Native Skills support audit

Pinned Codex source: `upstream/codex` (the repository pin remains the implementation authority).

| Capability | Native source / Zero3 seam | Zero3 status | Authority |
| --- | --- | --- | --- |
| Discover/list | `skills/list` | implemented | Codex |
| Refresh/watch | `forceReload` + `skills/changed` | implemented | Codex |
| Enable/disable | `skills/config/write` | implemented | Codex |
| Additional shared roots | `skills/extraRoots/set` | implemented; mounts normal `~/.codex/skills` into isolated Zero3 CODEX_HOME | Codex |
| Native invocation | `UserInput::Skill { name, path }` | implemented for local Tasks and Web Skill RPC | Codex |
| Install standalone Skill | built-in system `skill-installer` | implemented by invoking the native Skill; no Zero3 installer | Codex |
| Read/detail | Codex-discovered `SkillMetadata.path` | Zero3 purpose-specific bounded read; only paths returned by `skills/list` are accepted | Codex file is source; Zero3 is presentation only |
| Agent/Workflow binding | not a Codex package-management concept | implemented as Zero3 relation-only store | Zero3 organization layer |
| Task routing | not a Codex package-management concept | explicit selector + Binding + deterministic Top-N router | Zero3 orchestration layer |
| Usage ledger | not a Codex package-management concept | task-scoped selection/outcome/latency log | Zero3 orchestration layer |
| Web GPT instruction use | external ChatGPT cannot read local disk | `/mcp/skills` `get_skill`, bounded transient transport | Codex file remains source |
| Web GPT executable use | external ChatGPT cannot execute local Codex runtime | `/mcp/skills` `invoke_skill` -> local allow-listed Zero3 -> native Codex Turn | Codex |
| Claude/Gemini use | no shared native Skill runtime | Task-scoped bounded context is read from the same Codex Skill file at dispatch time | Codex file remains source |
| Hermes use | Hermes is Zero3's UI shell, not an Agent Kernel / Task target | no fake Hermes Skill runtime is created | architecture constitution |
| Standalone Skill delete | no reviewed native `skills/*` delete API in the pinned app-server | **not implemented** | do not reimplement filesystem deletion |
| Standalone Skill update | no reviewed native standalone update API in the pinned app-server; installer behavior owns installation | **not exposed as a fake Zero3 update API** | Codex |
| Plugin uninstall/upgrade | separate Codex plugin/marketplace APIs | outside standalone Skill P0-P7 scope | Codex |

## Non-negotiable rule

A Zero3 relationship record may reference a native Skill by name/path, but it never copies the Skill body. A task may transiently read the original Skill document to adapt instructions for an external Agent; that transient context is not a second Skill registry or package.
