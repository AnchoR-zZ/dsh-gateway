# dsh-gateway

以 dsh cordis 插件形式运行的 channel 网关。它把聊天平台的私聊文本接入 dsh agent，并把该轮最终回复发回原聊天。首个渠道是 QQ 官方机器人 WebSocket，当前只处理 C2C 纯文本。

网关运行在专用的 base-backed `gateway` profile 中，与 dsh 同进程。dsh 提供模型、工具、会话、sandbox 与审批能力；网关负责渠道接入、身份到 session 的映射、排队、turn 控制、回复规划与发送。进程托管、自动重启、服务化和自动监控不在本包范围内。

<a id="project-stage"></a>

## 项目阶段

当前是初版 MVP 实现，范围是 QQ 官方机器人 C2C 纯文本到 dsh agent 的闭环。MVP 之后仍可能对模块边界、渠道抽象、配置字段、状态 schema 和部署方式做较大调整，暂不承诺向后兼容；README 与架构文档描述的是当前实现，不是最终架构。

<a id="doc-navigation"></a>

## 文档导航

- [架构地图](docs/architecture.md)：运行组合、宿主接入、职责边界、消息流与扩展入口
- [入站与 QQ 连接](docs/subsystems/inbound.md)：连接生命周期、渠道状态映射、入站过滤与回复窗口
- [channel 管理](docs/subsystems/channel-admin.md)：实例管理器、管理服务与 HTTP 路由、错误码、凭证校验
- [调度与 turn 控制](docs/subsystems/scheduling.md)：准入、排队、执行槽、turn 结果与超时
- [会话与持久状态](docs/subsystems/session-state.md)：身份键、映射文件、写事务、会话准备与回收
- [回复规划与投递](docs/subsystems/outbound.md)：切分与预算、提示顺序、投递状态与出站隔离
- [配置与固定常量](docs/config.md)：配置文件字段、v1 迁移、热生效范围与 `GATEWAY_LIMITS`
- [健康、状态与日志](docs/observability.md)：本机 HTTP 监听与探针、管理路由、状态机、日志事件与脱敏

<a id="environment"></a>

## 环境

Node.js 24 及以上，依赖用 pnpm 管理，`packageManager` 固定 `pnpm@12.11.2`。dsh 是外部宿主，本包不在 `dependencies` 中携带 dsh；插件加载不受 `engines.dsh` 限制，dsh 宿主版本由部署环境自行选择（开发与自动测试基于 0.2.1-rc.2 的服务包类型）。与宿主共享的 cordis 与 dsh 服务包在 `peerDependencies` 声明（dsh 服务包为 `*`，不限宿主版本，由宿主提供），开发基线锁在 `devDependencies`（0.2.1-rc.2），均不打进构建产物。QQ 渠道使用官方 `@tencent-connect/qqbot-nodejs@1.0.5`；机器人须已获 C2C 与 Markdown 发送权限。

`../reference/` 只存放只读参考源码，不参与本项目的安装、构建或测试。

<a id="commands"></a>

## 命令

以下命令在仓库根目录执行；先决条件是 PATH 中有可用的 Node 与 pnpm，并已完成依赖安装。

| 命令 | 作用 | 成功表现 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 按依赖锁安装 | 安装完成且不更新依赖锁 |
| `pnpm typecheck` | `tsc --noEmit` | 类型检查通过，不生成 JavaScript |
| `pnpm lint` | `oxlint src tests scripts tsdown.config.ts vitest.config.ts` | 无未解决的检查错误 |
| `pnpm test` | `vitest run` | `tests/**/*.test.ts` 全部通过；以命令输出为准 |
| `pnpm build` | `tsdown` 构建插件入口 | 生成 `dist/index.js` 与 `dist/index.d.ts` |
| `pnpm dev` | `tsdown --watch` | 源码变化后重新构建；不启动 dsh |

普通测试使用替身隔离真实 dsh 宿主、QQ 网络和模型，不要求 QQ 或模型凭证，也不需要先构建 `dist/`。测试会绑定回环随机端口并写入系统临时目录；`tests/qq-channel.test.ts` 加载真实 QQ SDK 模块，但不建立连接。真实 QQ WebSocket、token 校验端点、模型认证与回复、dsh profile 加载、固定 `17890` 端口和终端 Ctrl+C 路径不在自动测试覆盖内。

提交或联调前依次完成 typecheck、lint、test 和 build，任一步失败先修复再继续。

<a id="channel-admin-api"></a>

## channel 管理路由

网关进程内自带两条仅本机、无鉴权的 POST 管理路由（默认 `http://127.0.0.1:17890`），用于在网关运行时添加与启用 QQ 机器人实例，不需要重启进程；网关未运行时只能修改配置文件后重启。

| 路由 | 请求 body | 作用 |
|---|---|---|
| `POST /channels/qq` | `{"appId","appSecret","force"?}` | 添加/更新实例：在线校验凭证（`force: true` 跳过）、保存配置并启动实例 |
| `POST /channels/qq/enable` | `{"appId"?}` | 置 `enabled: true` 并拉起未在线实例（`manual_restart_required` 的重试入口）；省略 `appId` 时仅当配置中恰好一个实例合法 |

```bash
curl -X POST http://127.0.0.1:17890/channels/qq \
  -H 'content-type: application/json' \
  -d '{"appId":"<AppID>","appSecret":"<AppSecret>"}'
# {"ok":true,"channel":"qq:<AppID>","state":"online"}
```

成功响应固定为 `{"ok":true,"channel":"qq:<appId>","state":...}`；启动失败时 `state` 为 `blocked` 并附 `detail`（凭证已保存）。失败响应为 `{"error":{"code","message"}}` 加对应 HTTP 状态码；完整契约（错误码、重复 add、漂移拒绝、停机窗口）见 [channel 管理](docs/subsystems/channel-admin.md#admin-routes)。

Windows PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名，需写 `curl.exe` 或改用 `Invoke-RestMethod`。`appSecret` 会进入 shell 历史与本机进程参数，脚本场景应从环境变量或文件读取；管理响应、日志与错误信息都不回显 `appSecret`。

<a id="local-dev"></a>

## 本地联调

[`scripts/gateway.mjs`](scripts/gateway.mjs) 是开发期包装器：每次启动前先执行 `pnpm build`，再用固定开发数据根启动 `gateway` profile。它只服务本地联调，不参与发布和部署。

| 命令 | 作用 | 成功判据 |
|---|---|---|
| `pnpm dev:gateway` | 构建插件并启动 `dsh --profile gateway` | 构建输出后 dsh 持续运行；`127.0.0.1:17890/livez` 返回 200，零实例时 `/readyz` 200 且 `channels` 含 `"qq": "not_configured"`；用 [channel 管理路由](#channel-admin-api) 添加实例后 `/readyz` 显示 `qq:<AppID>: online` |

先决条件：已完成依赖安装；`dsh` 命令在 `PATH` 上（宿主版本自选，本包不设兼容约束）；`tmp/local-test/dsh-home` 下已初始化 `gateway` profile（首次执行 `dsh plugin --profile gateway add <repo>`）。QQ 凭证经 [channel 管理路由](#channel-admin-api) 写入 `tmp/local-test/gateway-workspace/gateway.config.json`（也可直接编辑该文件后重启），无凭证也可先启动（零实例）。模型 API key 可由调用者环境或 `tmp/local-test/dsh-home/.env` 提供；该 `.env` 不得包含 `DSH_*` 变量。

开发数据根固定为 `tmp/local-test`（已被 git 忽略），启动器不提供覆盖方式：`dsh-home/` 作为 `DSH_HOME`，`gateway-workspace/` 作为 `DSH_GATEWAY_WORKSPACE`。启动器固定设置 `DSH_TELEMETRY_DISABLED=1`，`dsh` 直接取自 `PATH`；启动器不通过环境变量或配置文件选择它，命令缺失时由启动过程报错。Windows 上构建和 `dsh` 启动都经 shell 执行；启动器吞掉第一次 Ctrl+C，等待 dsh 自行退出，第二次 Ctrl+C 才直接结束启动器。

启动器不创建 profile，也不检查 `gateway.config.json`；相关缺失由 dsh 与插件报错。

<a id="runtime-config"></a>

## 运行时配置

网关配置分两部分：唯一环境变量 `DSH_GATEWAY_WORKSPACE` 决定 workspace 根，其余网关配置从 workspace 内的 `gateway.config.json`（schema v2）读取；dsh 自身仍由 dsh 的环境变量配置。插件 config 无字段。除 channel 实例的添加/启用/凭证变更经管理路由热生效外，其余配置在启动时一次性解析，变更走重启。

### 网关环境变量

| 环境变量 | 必需 / 默认 | 读取者与含义 |
|---|---|---|
| `DSH_GATEWAY_WORKSPACE` | 可选；未设置或空白时默认 `~/.dsh-gateway`（Windows 为 `%USERPROFILE%\.dsh-gateway`） | 网关 workspace 根；显式值必须是绝对路径，不展开 `~`，相对路径拒绝启动 |

`DSH_GATEWAY_WORKSPACE` 属于 `DSH_*`。dsh 自动发现的宿主 `.env` 会拒绝它，部署时用 Node 的 `--env-file` 或服务管理器把它注入进程环境。网关不直接读取 `DSH_HOME`，而是启动时通过 dsh 根上下文的 `dshHomePath()` 取得 dsh home，并校验 workspace 与 dsh home 不重叠；取不到 `dshHomePath` 时启动失败。旧版网关环境变量（状态目录、workspace 根、QQ 凭证、`DEBUG` 和并行/队列/回收上限）不再读取，上述配置只认 `<workspace>/gateway.config.json`。

### 网关配置文件

配置文件固定为 `<workspace>/gateway.config.json`，UTF-8 JSON，当前 schema 版本为 2。完整示例：

```json
{
  "schemaVersion": 2,
  "channels": {
    "qq": [
      { "appId": "your-qq-app-id", "appSecret": "your-qq-app-secret", "enabled": true }
    ]
  },
  "debug": false,
  "maxConcurrent": 4,
  "maxPendingPerPeer": 3,
  "maxPendingTotal": 100,
  "maxPendingBytes": 8388608,
  "idleAgentTtlMs": 900000,
  "maxLiveAgents": 32
}
```

`channels.qq` 是实例数组（`enabled` 缺省为 `true`），可为空；字段校验、v1 自动迁移、热生效范围与单写者/漂移拒绝规则见 [配置契约](docs/config.md#config-fields)，本页不复述完整表。首次启动时若文件不存在，网关会创建含空 `channels.qq` 的 v2 模板并以零实例正常运行（不再失败退出），日志记 `config_template_created` 指引通过 [channel 管理路由](#channel-admin-api) 添加机器人；已有文件绝不覆盖或自动修复，未知字段、`null`、类型错误和无效值一律拒绝启动。

配置文件包含明文 QQ AppSecret，当前不做文件权限检查或加密。部署方应把 workspace 放在仓库外（默认值已满足），并通过文件系统 ACL 限制为服务账号与管理员可读；`gateway.config.json` 已加入 `.gitignore`，不得提交。

### dsh 环境变量

| 环境变量 | 必需 / 默认 | 读取者与含义 |
|---|---|---|
| `DSH_HOME` | 部署必需（专用），绝对路径 | dsh 专用 home；未设置时 dsh 自身会回退 `~/.dsh`，本项目要求独立 home；会话历史在 `<DSH_HOME>/sessions` |
| `DEEPSEEK_API_KEY` | 使用默认 provider 时必需 | dsh 模型 provider 按凭证引用读取；其他 provider 按 dsh 配置 |
| `DSH_TELEMETRY_DISABLED` | 部署固定为 `1` | 禁止 dsh 会话遥测外发；bundle 同时禁用遥测插件 |

模型选择由 `<DSH_HOME>/profiles/gateway/cordis.patch.yml` 中的 `agent-default-model` 行决定。网关启动时读取一次 `ctx.agentDefaultModel.currentSelection()`，所有新建和恢复的 agent 共用该选择；不提供按用户选模。启动摘要会记录实际 provider 与 model。超时、回复条数与消息长度属于固定行为契约，不提供配置项绕过；对应常量集中在 [`GATEWAY_LIMITS`](docs/config.md#gateway-limits)。

<a id="deployment"></a>

## 部署与启动

以下命令用于正式部署。部署方需先安装 dsh（版本自选，本包不设兼容约束），并在同一台机器上准备 Node、pnpm、受限 `.env` 与 QQ 机器人凭证；安装、检查与正式启动必须使用相同的 `.env`、`DSH_HOME` 和 workspace。自动测试不覆盖真实 dsh 宿主、QQ 网络与模型认证，这些命令也不在自动测试覆盖内；实际结果以运行输出为准。

`.env` 只保存 dsh 变量和可选的 `DSH_GATEWAY_WORKSPACE`，例如：

```dotenv
DSH_HOME=D:/dsh-gateway/data/dsh
DEEPSEEK_API_KEY=replace-with-your-key
DSH_TELEMETRY_DISABLED=1
# 可选；不设置时使用 ~/.dsh-gateway（Windows 为 %USERPROFILE%\.dsh-gateway）
DSH_GATEWAY_WORKSPACE=D:/dsh-gateway/data/gateway
```

QQ 的 AppID/AppSecret 不写入 `.env`，而是写进 `<workspace>/gateway.config.json`：首次启动前手工编辑（之后重启生效），或在网关启动后调用 [channel 管理路由](#channel-admin-api) 热添加。首次正式启动时若该文件不存在，网关会创建 v2 模板并以零实例正常启动，随后在线添加机器人即可，无需重启；若沿用旧版 v1 配置文件，启动时会自动迁移为 v2 并写回，旧版首启生成的双空凭证模板同样迁移为 v2 零实例并正常启动（见 [v1 迁移](docs/config.md#v1-migration)）。以 Windows PowerShell 为例，全局安装 dsh 后直接调用它的 Node 入口，以便用 `--env-file` 注入外部 `.env`：

```powershell
npm install --global @deepseek-ai/dsh  # 版本自选，示例与开发基线基于 0.2.1-rc 系列
$dshBin = Join-Path (npm root -g) '@deepseek-ai/dsh/lib/bin.js'
pnpm install --frozen-lockfile
pnpm build
node --env-file="D:/dsh-gateway/secrets/.env" $dshBin plugin --profile gateway add .
node --env-file="D:/dsh-gateway/secrets/.env" $dshBin --profile gateway --dump-config
node --env-file="D:/dsh-gateway/secrets/.env" $dshBin --profile gateway
```

如果 dsh 由桌面版或其他安装方式提供，`dshBin` 指向该安装的实际 Node 入口；也可以把 `.env` 注入服务进程环境后直接运行 `dsh`。不要依赖 PATH 上的 `.cmd` shim 透传 `--env-file`，并在启动前清理冲突的 `DSH_*` 与 `DEEPSEEK_API_KEY` 环境变量。

预期成功表现：`--dump-config` 显示 base 宿主插件与一个指向 `dsh-gateway` 根入口的插件行，HMR 与遥测关闭；运行日志出现 `startup_summary`，本机探针 `127.0.0.1:17890` 的 `/livez` 返回 200；等待 `/readyz` 返回 200，并确认正文 JSON 的 `coreState` 为 `ready`。`channels` 表按实例展开：已配置并在线的实例为 `"qq:<AppID>": "online"`，未配置任何实例时为 `"qq": "not_configured"`（同样判就绪），`enabled: false` 的实例为 `disabled`（不影响就绪）；已启用实例处于 `connecting`/`blocked` 等状态时整体 503。发送一条合格 C2C 文本后收到最终 Markdown 回复。`--dump-config` 只验证组合，不能证明模型认证、SDK 连接和工具权限正常。

### 本机目录布局

```text
安装目录/                          # 本仓库构建产物与 node_modules，只由运维升级
secrets/.env                       # dsh 变量与可选 workspace 路径，不入库
<DSH_HOME>/
  profiles/gateway/                # base-backed profile 与本机 patch
  sessions/                        # dsh 管理的完整会话历史
<workspace>/                       # DSH_GATEWAY_WORKSPACE；默认 ~/.dsh-gateway
  gateway.config.json              # 网关配置与 QQ 凭证（含 AppSecret）
  state/
    bindings.json                  # 网关映射
    bindings.json.bak              # 上一份已提交映射，只作人工恢复
  users/
    <bindingId>/                   # 一个私聊身份的工具工作目录，如 qq_<AppID>_<user_openid>
```

`<workspace>` 不得与 `<DSH_HOME>` 重叠；配置、state 与用户工作目录均固定在 workspace 内。dsh 会话历史仍由 dsh 管理在 `<DSH_HOME>/sessions`，网关不读写 session 文件。

<a id="operations"></a>

## 运维

### 停止与重启

正常停止在运行终端按 Ctrl+C 并等待原进程结束；停止期间在 HTTP 监听关闭前本机探针仍可访问，新的管理写入按 503 `gateway_stopping` 拒绝（已保存的配置保留、等下次启动生效），监听最后关闭（见[健康探针与管理路由](docs/observability.md#readiness)）。修改非 channel 配置（limits、`debug` 等）或升级后用相同 `.env`、`DSH_HOME` 与 workspace 手动重新启动。channel 实例的添加、启用与凭证变更不需要重启：日志或 `/readyz` 出现 `blocked` 等需要人工介入的状态时，先按 `manual_restart_required` 的 `reason` 修复原因（例如更正凭证），再调用 `POST /channels/qq/enable` 拉起新实例；调用失败时重启进程仍是兜底路径。触发点、failed 吸收态与处置边界见[健康与日志](docs/observability.md#state-machines)。

配置文件在启动后被外部修改时，管理路由拒绝写入（409 `config_modified_externally`），不静默覆盖；处置方式是重启 dsh 或把文件改回后重试。手工编辑配置（含移除实例）后重启 dsh 是合法的冷路径。

映射文件损坏或版本不支持时停止进程、保留现场修复或从备份恢复，不以空状态目录覆盖启动。`.bak` 只用于停止进程后的人工恢复；恢复前核对 revision 与对应 session 记录，避免静默复活已替换映射。网关不提供自动迁移，升级 schema 需要显式迁移。

### 清空单个用户上下文

先决条件：确认目标 `user_openid` 对应的 `bindingId`（QQ 下为 `qq_<AppID>_<user_openid>`），停止 dsh 并确认旧进程退出，备份 `<workspace>/state/bindings.json`、其 `.bak` 与必要的 `<DSH_HOME>/sessions`。聊天侧没有 `/new` 或重置命令；只删除目标映射记录，下次输入才会创建新 session ID。

1. 在运行终端按 Ctrl+C 停止 dsh，确认原进程已退出，再编辑状态文件。
2. 在 `<workspace>/state/bindings.json` 中按 `channelId`、`accountId`、`peerId` 定位唯一条目，只删除 `bindings["qq_<AppID>_<user_openid>"]`，保留其他用户，并把文件级 `revision` 加一，不改 `schemaVersion`；不要用文本替换匹配相似 ID。字段规则见 [映射文件](docs/subsystems/session-state.md#bindings-file)。
3. 保存后用 JSON 解析检查文件，例如：

```powershell
Get-Content -LiteralPath '<workspace>/state/bindings.json' -Encoding utf8 -Raw | ConvertFrom-Json | Out-Null
```

4. 使用相同 `.env`、`DSH_HOME` 与 workspace 重启。目标用户下次发消息时应出现新 session ID，其他用户继续恢复原 ID。

加一是为了保持后续写入的递增语义；字段与校验规则见[映射文件](docs/subsystems/session-state.md#bindings-file)。旧 dsh 会话历史、旧网关日志和该用户工作目录均保留；不删除、改名或手写 session 文件。该操作只清空未来模型上下文，不清除工具生成文件或已经发生的外部副作用，也不补发宕机期间的旧消息。

<a id="security-boundaries"></a>

## 安全与已知边界

- 不设用户白名单。任何能向机器人发私聊的用户都能驱动本机 agent；机器人被公开或分享前应视为不可信入口。
- 插件与 dsh 同进程，拥有 dsh 进程权限。插件或渠道异常可能影响 dsh，不能单独重启 gateway；插件崩溃后需要重新启动 dsh。单个 QQ 实例的启动失败不再影响进程与其他实例。
- channel 管理路由仅绑定回环地址、本期无鉴权：同机任意本地进程都可添加或启用实例。`appSecret` 只写不读——管理响应、日志与错误信息一律不回显；调用方仍需避免它进入 shell 历史与本机进程参数。
- 队列、运行中的 handle、出站计划和发送计数都在内存中。进程崩溃会丢失未处理消息和未发送回复，不重放、不补发。
- 没有 exactly-once 或端到端 at-least-once 保证。SDK 默认去重窗口之外的重复推送可能再次执行；QQ 发送结果未知时不会重试，可能丢回复或出现迟到回复。
- 映射持久化失败会使 core 进入 failed 并停止准入；dispose 未收敛、出站隔离或停机预算耗尽需要人工介入（重跑 enable 或重启）。
- `workspace-write` 主要约束写入目录，不构成对宿主文件读取、网络或进程权限的完整租户隔离。默认审批策略为 `never`，需要审批的操作直接拒绝，不提供聊天侧审批。
- `gateway.config.json` 以明文保存 AppSecret；`.env` 保存模型凭证。两者都不得入库，部署方需限制文件 ACL 并避免进入 agent 可写目录。
- 当前不提供聊天侧取消、上下文重置或模型选择；这些操作只能通过停止进程、修改配置/映射并重启完成。
