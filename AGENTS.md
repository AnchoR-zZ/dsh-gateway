# AGENTS.md

## 项目定位

dsh-gateway：连接 dsh（DeepSeek Harness）与 聊天应用 的 channel 网关，把 聊天应用 私聊/群聊作为 dsh agent 的消息通道。

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

聊天平台机器人凭证（如 QQ 的 AppID/AppSecret）、模型 API key 等不入库，统一放 `.env`（保持 git 忽略）并按环境变量读取。

## 技术栈（待补充）

<!-- 项目初始化后在此说明语言、框架、包管理器、运行时版本等 -->

## 常用命令（待补充）

<!-- 项目初始化后在此列出安装、构建、测试、运行命令 -->
