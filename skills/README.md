# skills/

Zero3 Pilot does **not** maintain a second Skill store. Open-source Codex Native Skills are the authoritative Skill system.

- User/system/repository Skills are discovered by Codex (`skills/list`).
- An isolated Zero3 `CODEX_HOME` mounts the user's normal `~/.codex/skills` with `skills/extraRoots/set`; files are not copied.
- Enable/disable goes through `skills/config/write`.
- Installation delegates to Codex's built-in `skill-installer`.
- Invocation uses the upstream `UserInput::Skill { name, path }` item.

This repository directory contains only project-owned Skill source that may itself be installed/discovered by Codex, such as `zero3-web-worker/`. It is not a Zero3 Skill Registry.
