# Project Rules

## Team Git Workflow (auto-commit)

本仓库遵循团队并行开发规则：多个 AI 端并行开发，GitHub 为同步真相源。
- 每完成一个任务自动 stage + commit（message 描述清楚改动），随后立即 push。
- 开工前先 pull + 查 git status；冲突时停下来报告，不静默解决。
- 只 stage 与任务相关的文件，排除缓存/凭证/运行时状态。
- 禁止 force-push、重写历史、改 remote。
- 完整规则（含仓库清单）：见 C:/Users/aaaa/Documents/.zero3-team-git-rules.md

## Windows 验证通道（外部指挥官）

网页端 GPT 等外部 AI 无法直连本机，但可通过 GitHub 邮箱仓库
`Taa965/zero3-commander-bridge` 的 `windows-verify/` 通道，在 Windows 开发机上
真实执行本项目的 `cargo` 构建/测试并回读结果。

用法、命令信封、可用工具链与结果读取见 [`docs/WINDOWS-VERIFY.md`](docs/WINDOWS-VERIFY.md)。
