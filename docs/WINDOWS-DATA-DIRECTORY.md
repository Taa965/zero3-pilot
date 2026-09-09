# Zero3 Windows 配置目录

Windows 版固定使用 `%USERPROFILE%\Documents\Zero3 Pilot`。
本机实际路径为 `C:\Users\Laaa\Documents\Zero3 Pilot`。
Electron 启动入口与开发启动脚本使用相同规则，不再随 Claude、Codex、终端等启动来源的 AppData 隔离目录变化。
Windows 上继承的 `HERMES_DESKTOP_USER_DATA_DIR`、`ZERO3_HERMES_HOME`、`ZERO3_CODEX_HOME` 会被固定目录规则替换。

- 根目录：Electron 浏览器配置、GPT/Gemini 登录、窗口与界面状态。
- `zero3/`：Zero3 项目、会话、任务及相关应用配置。
- `hermes/`：Zero3 使用的 Hermes 兼容运行时配置。
- `codex/`：Zero3 使用的隔离 Codex 运行时配置。

外部软件自己的配置目录（例如用户独立安装的 Codex CLI 的 `.codex`）不属于此次迁移。
配置中可能包含凭证，不能加入 Git。

迁移需先退出 Zero3，再复制原 Electron userData 目录到新根目录，复制原 Zero3 Hermes/Codex 目录到对应子目录，并核对文件哈希。
保留旧目录作为备份；新版本只从固定目录运行。无需清除浏览器 Cookie 或重新绑定项目。
未安装本次修复的旧版本仍可能使用旧目录，应使用更新后的 Zero3 启动入口。
