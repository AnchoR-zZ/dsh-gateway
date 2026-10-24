# AGENTS.md

## 项目定位

本项目是聊天应用与 dsh（DeepSeek Harness）之间的 channel 网关；项目说明与开发入口见 [README.md](README.md)。

## 目录布局

- `../reference/` 存放只读参考代码，不属于本项目：
  - `../reference/deepseek-harness/` — dsh 源码参考。
  - `../reference/openclaw-qqbot/` — OpenClaw 的 QQ 渠道插件源码参考。

## 参考代码规则

- `../reference/` 严格只读，禁止一切写入性操作，包括但不限于：
  - 源码改动：编辑、格式化、随手修复、依赖升级；
  - 安装依赖：`pnpm install` / `npm install` 等会写入 `node_modules` 和 lock 文件；
  - 构建与产物生成：构建、测试缓存、快照等任何会落盘的命令；
  - git 写操作：commit、checkout、pull、stash、分支操作等。
- 需要实验性改动或验证想法时，把相关文件复制到本项目目录（或临时目录）再进行。

## 凭证安全

聊天平台机器人凭证（如 QQ 的 AppID/AppSecret）放 `<DSH_GATEWAY_WORKSPACE>/gateway.config.json`，默认 workspace `~/.dsh-gateway` 位于仓库外；模型 API key 等放 `.env`（保持 git 忽略）并按环境变量读取。两类凭证均不入库，也不得提交；部署方需限制配置文件与 `.env` 的访问权限。

## 开发与验证

- 开发环境与命令见 [README.md](README.md)；修改运行时行为或模块结构前先读 [架构文档](docs/architecture.md)。
- 选择覆盖本次变更的最小验证范围，验证可观察行为与相关失败路径；报告实际运行的命令、结果及未验证项。文档改动检查链接、标题锚点与排版。

## 文档约定

- 项目定位、环境与命令放 [README](README.md)，当前职责、消息流与契约放 [architecture](docs/architecture.md)，重要取舍的依据与结论放 [Notes](docs/notes/README.md)，正文骨架放独立的 [模板](docs/notes/TEMPLATE.md)。
- 实现前的详细设计、拟定接口与配置、部署草案放 `tmp/`；`docs/architecture.md` 作为当前架构地图，随代码落地同步运行组合、职责、消息流与扩展入口。
- 每条事实只有一个主出处，其他位置用摘要与链接引用。行为、配置或边界变化时，在同次修改中更新所属文档；文档随实际内容增长再拆分。
- 新增文档类型前，先确认 README、architecture 与 Notes 是否已能容纳；现有位置放不下时再新增。
- 只为代码、测试和现有文档不能充分解释的长期取舍写 Note；重要提议可以先记录为 proposed，普通想法、待办和初始化整理无需逐项记录。分类与维护遵守 Notes 约定。
- 使用中文，代码标识符与固定字段保留英文；直接说明行为、失败方式、时序、所有权与限制，避免代码复述和实现过程流水账。
- 操作说明写清先决条件、命令与成功表现，未验证内容明确标注。正文每段一个物理行，文件以一个换行结束，使用有效的相对 Markdown 链接。
