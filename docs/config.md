# 配置与固定常量

本页描述网关的运行配置：`<workspace>/gateway.config.json` 的 v2 字段、校验与默认值，v1 的自动迁移，热生效范围与写冲突规则，workspace 的解析与派生路径，以及 `GATEWAY_LIMITS` 固定行为常量；映射文件格式见 [映射文件](subsystems/session-state.md#bindings-file)，健康与日志见 [健康探针](observability.md#readiness) 与 [日志事件](observability.md#log-events)，channel 管理路由见 [channel 管理](subsystems/channel-admin.md) 与 [README](../README.md#channel-admin-api)，部署命令见 [README](../README.md)。源码：[`src/config/schema.ts`](../src/config/schema.ts)、[`src/config/store.ts`](../src/config/store.ts) 与 [`src/contracts.ts`](../src/contracts.ts)。

<a id="config-fields"></a>

## 配置文件

网关配置固定为 `<workspace>/gateway.config.json`（`GATEWAY_CONFIG_FILENAME`），UTF-8 JSON；它是网关唯一自有的持久配置来源。插件 config 无字段（`Config` 是空 schema，`apply` 不读取第二个参数）；除 `DSH_GATEWAY_WORKSPACE` 与 dsh home 路径外，全部网关配置都来自该文件。

文件在插件组装期（`apply` 返回前，由 runtime 同步）读取一次；channel 实例的添加、启用与凭证变更经本机管理路由热生效（见 [热生效范围](#hot-reload-scope)），其余字段修改需要重启进程；`debug` 在创建日志器时固定，同样需要重启。

加载顺序固定为：workspace 与 dsh home 的绝对路径校验 → 重叠校验 → 递归创建 workspace 目录 → 读取或创建配置文件 → 剥离 UTF-8 BOM 后 `JSON.parse` → v1 检测（见 [v1 迁移](#v1-migration)）→ v2 严格校验 → 派生路径。任一步失败都抛 `GatewayConfigError`，插件加载失败、dsh 终止启动；错误消息指明文件路径、字段名（或环境变量名）与原因，且不回显 `appSecret` 的值。

字段如下；`stateDir` 与 `workspaceRoot` 不是配置字段，由 workspace 派生。队列容量与拒绝判定见 [准入与入队](subsystems/scheduling.md#ingress-admission)，缓存上限与回收见 [缓存与回收](subsystems/session-state.md#lru-recycle)。

| 字段 | 必需 / 默认 | 校验与运行时语义 |
|---|---|---|
| `schemaVersion` | 必需，只能为 `2` | 缺失报 `is required`；其他版本或类型报 `must be 2; unsupported version <值>`；`1` 走自动迁移 |
| `channels` | 可选，默认 `{"qq":[]}` | 必须是对象；只允许 `qq` 与 `weixin` 键，其他键报 `unknown channel type "<键>"` |
| `channels.qq` | 可选，默认 `[]` | QQ 实例数组，可为空（未配置任何 bot）；元素字段见下表；同数组内 `appId` 不得重复 |
| `channels.weixin` | 可选，默认无实例 | 微信实例数组，可为空；字段与校验见下文，`botId` 不区分大小写不得重复 |
| `debug` | 可选，默认 `false` | 布尔值；日志器的正文输出开关，创建日志器时固定 |
| `maxConcurrent` | 可选，默认 `4` | 正安全整数；core 最大并行任务数（全部实例共享），包含 `prepare`、清理、turn 与最终发送 |
| `maxPendingPerPeer` | 可选，默认 `3` | 正安全整数；每用户（渠道实例 × 对端）最大等待消息数，不含活动任务 |
| `maxPendingTotal` | 可选，默认 `100` | 正安全整数；全局最大等待消息数 |
| `maxPendingBytes` | 可选，默认 `8388608` | 正安全整数；等待正文的 UTF-8 总字节上限 |
| `idleAgentTtlMs` | 可选，默认 `900000` | 正安全整数；空闲 handle 的回收时间，不删除映射与会话历史 |
| `maxLiveAgents` | 可选，默认 `32` | 正安全整数且不小于 `maxConcurrent`；`prepare` 按当前缓存条目检查容量，满载且无可逐出空闲条目时阻塞等待；并发准备可能使缓存超过该值，见[缓存与回收](subsystems/session-state.md#lru-recycle) |

`channels.qq` 数组元素的字段（实例标识为 `appId`，启用与凭证分层）：

| 实例字段 | 必需 / 默认 | 校验与运行时语义 |
|---|---|---|
| `appId` | 必需 | `trim` 后非空字符串且 ≤128 字符、仅含 `[A-Za-z0-9-]`；QQ 渠道的 accountId，也是健康表与管理路由的实例标识 |
| `appSecret` | 必需 | `trim` 后非空字符串且 ≤256 字符；配置加载失败的错误消息与日志不含其值，管理路由的失败响应例外见[凭证在线校验](subsystems/channel-admin.md#credential-check) |
| `enabled` | 可选，默认 `true` | 布尔值；冷启动跳过 `false` 实例，未注册时健康表显示 `disabled` 且不影响就绪；管理请求更新该实例时的例外见[热生效范围](#hot-reload-scope) |

`channels.weixin` 元素包含必需的 `botId`、`userId`、`botToken`、`baseUrl` 和可选的 `enabled`（默认 `true`）。`botId` 与 `userId` 必须能组成合法身份键，`botToken` 必须非空且不超过 4096 字符；`baseUrl` 先经 `URL` 解析，再要求解析结果同时满足 `https:` 协议、无用户名与密码、无端口、主机为 `qq.com` 或其子域、路径为 `/`、无查询内容与无片段内容。保存时先 `trim` 再移除末尾一个斜杠；拼接 API 路径时只移除末尾一个斜杠、不经 `trim`，`trim` 由调用方负责——配置值在加载时已 `trim`，[微信扫码管理](subsystems/channel-admin.md#weixin-management)返回的 `baseurl` 经 `required()` 先 `trim` 且空串视为缺失；两者都基于原始字符串而非解析后的 origin；原串里的显式 `:443` 与可归一化为 `/` 的点段路径因解析归一化而通过校验，对拼接出的请求地址没有影响；末尾空 `?` 或空 `#` 同样通过校验并被保留，拼接后 API 路径落入查询或片段，请求打到错误 URL。这些字段由[微信扫码管理](subsystems/channel-admin.md#weixin-management)写入，凭证不得提交。

`maxConcurrent`、`maxPendingPerPeer`、`maxPendingTotal`、`maxPendingBytes`、`idleAgentTtlMs` 与 `maxLiveAgents` 这 6 个数值字段必须是正安全整数：类型为 number、`Number.isSafeInteger` 为真且大于 `0`。`0`、负数、小数、`NaN`、`Infinity`、超出安全整数范围的值、字符串、`null`、布尔、对象与数组都报 `must be a positive integer`，不会回落默认值。

`maxLiveAgents` 还必须不小于 `maxConcurrent`，否则报 `maxLiveAgents must be >= maxConcurrent`；默认组合是 `maxConcurrent` 4 与 `maxLiveAgents` 32，因此只把 `maxConcurrent` 提到 32 以上会失败，必须同时提高 `maxLiveAgents`。

可选字段只有省略时才取默认值：出现上述之外的顶层键（包括 `qqAppId`、`qqAppSecret` 这类 v1 名或 `stateDir`、`workspaceRoot`、`dshHome` 派生名）报 `unknown field "<键名>"`；实例对象出现 `appId`/`appSecret`/`enabled` 之外的键报 `channels.qq[<下标>] unknown field "<键名>"`；`null`、类型错误和无效值同样拒绝，不静默采用默认值。根节点必须是 JSON 对象，否则报 `root must be an object`。

读入时 `appId` 与 `appSecret` 会 `trim`，`enabled` 缺省取 `true`；校验通过的文件对象被冻结；运行期配置只含派生路径与文件字段（含 `qqInstances` 实例清单），不含 dsh home。

配置文件不存在时，网关先递归创建 workspace 目录，再以 `wx` 独占方式写入 v2 模板：`schemaVersion` 为 `2`、`channels.qq` 为空数组、其余字段为默认值，2 空格缩进、结尾换行、不含 BOM。模板可直接加载，进程以零渠道实例正常启动（`/readyz` 200、`channels` 含 `"qq": "not_configured"`），日志记一条 `config_template_created` 指引通过管理路由添加机器人；并发启动时另一方已创建会得到 `EEXIST`，本次按已存在文件继续读取且不计为创建者。

已有文件绝不覆盖或自动修复：损坏的 JSON、未知字段、无效实例在校验失败后保持原字节不变（v1 迁移是唯一例外，见下节）。读取只剥离文件开头的 UTF-8 BOM（Windows 编辑器常见），字符串字面量之外出现 BOM 仍是非法 JSON；workspace 目录与本次新建的模板在校验失败后保留。

<a id="v1-migration"></a>

## v1 迁移

检测到 `schemaVersion` 为 `1` 的旧文档时，加载器先按 v1 规则校验（未知字段拒绝、数值字段同 v2 规则、`qqAppId` 满足 `[A-Za-z0-9-]` 字符集），通过后转换为 v2——`qqAppId`/`qqAppSecret` 变为 `channels.qq[0]`（`enabled: true`），其余字段沿用——并原子写回（同目录临时文件 + rename），随后以 v2 继续校验；加载成功时日志记一条 `config_migrated`。v1 校验不检查凭证长度，超长 `qqAppId` 或 `qqAppSecret` 会先写成 v2，再因 v2 长度校验失败而拒绝启动，文件保留迁移后的内容。迁移一次性、单向；迁移后的文件再用旧版代码启动需手工改回 v1 形态。

凭证双空例外：`qqAppId` 与 `qqAppSecret` 双双为 `trim` 后的空串（旧版首启模板形态）时视为无凭证可迁，迁移产物为 `channels.qq: []`（零实例），其余字段照常携带，写回后以零实例正常启动。恰好一个为空、一个非空属真实配置错误，迁移不发生、文件保持原字节、启动失败并报 `qqAppId must be a non-empty string` 或 `qqAppSecret must be a non-empty string`；凭证字段缺失或非字符串、非法字符、未知字段、数值越界等其他非法 v1 文档同样迁移不发生、文件保持原字节、启动失败。

<a id="hot-reload-scope"></a>

## 热生效范围与写冲突

channel 实例的添加（含重复 `add` 更新 secret）、启用与凭证变更经本机 HTTP 管理路由（管理服务）热生效，不重启进程（路由契约见 [channel 管理](subsystems/channel-admin.md)）；QQ 的 `add` 或扫码绑定更新已禁用实例时保留 `enabled: false`，但仍会启动该实例。其余字段（`debug`、`maxConcurrent` 等 limits 与回收参数）不在热生效范围，修改走重启。冷启动路径保留：重启后按已保存配置自动上线全部 `enabled` 实例；停机期间已保存的实例配置保留但不启动，等下一次启动生效。

进程是配置文件唯一在线写者：加载时记录"最后已知文件内容"快照，每次管理写入前由 store 重读磁盘，双方移除开头的 BOM 后比较；其余内容与快照不一致时拒绝写入并返回 409。仅增删开头 BOM 不会触发漂移拒绝，后续写回会覆盖这一外部改动。漂移的处置方式是重启 dsh 或把文件改回快照内容。写回一律走同目录临时文件 + rename 的原子替换，成功后更新快照，不残留 `.tmp` 文件。手工编辑配置后重启 dsh 仍是合法的冷路径；移除 bot 本期无命令，同样走手工编辑 + 重启。

配置文件含明文 `appSecret`，网关不做文件权限检查或加密；把 workspace 放在仓库外、限制 ACL 与不得提交的要求见 [README](../README.md)。

`debug` 只控制日志器的正文输出：它为 `true` 时 `debugBody` 输出 `debug_body`。当前消息路径没有调用 `debugBody` 的生产代码，因此开启后不会产生正文日志；`error` 与 `reason` 的脱敏始终生效，见 [脱敏与敏感数据](observability.md#redaction)。

<a id="workspace-derivation"></a>

## workspace 与派生路径

网关只读取一个环境变量 `DSH_GATEWAY_WORKSPACE`：未设置或 `trim` 后为空时，workspace 为 `<os home>/.dsh-gateway`（`DEFAULT_GATEWAY_WORKSPACE_DIRNAME`，Windows 上是 `%USERPROFILE%\.dsh-gateway`）；其他环境变量（含 `DSH_HOME` 与旧的 `DSH_GATEWAY_*` 名称）都不影响解析。

显式值先 `trim`，再要求 `path.isAbsolute`，通过后由 `resolve()` 归一化（折叠 `.`、`..` 与多余分隔符）；相对路径报 `DSH_GATEWAY_WORKSPACE must be an absolute path`，不会按进程 cwd 解析；`~` 不展开，`~`、`~/gateway`、`~user/gateway` 都按相对路径拒绝。

dsh home 不来自环境变量，而是启动时从 dsh 根上下文的 `dshHomePath()` 取得；服务缺失或返回值非法时启动失败，报 `dshHomePath service is unavailable` 或 `dshHomePath returned an invalid path`。workspace 与 dsh home 都必须是绝对路径。

两者相同、workspace 位于 dsh home 内、dsh home 位于 workspace 内都拒绝启动，报 `must not overlap with dsh home`；判定基于 `path.resolve` 与 `path.relative` 归一化后的字符串（Windows 大小写不敏感），跨盘符视为不重叠，前缀相似的兄弟目录不重叠，以 `..` 开头的子目录名（如 `..ws`）仍按嵌套处理。重叠校验在创建目录之前完成，被拒绝时不会创建 workspace；目录创建失败同样抛 `GatewayConfigError`。

`stateDir` 与 `workspaceRoot` 由 workspace 派生为 `<workspace>/state` 与 `<workspace>/users`，是运行期字段而不是配置字段。`stateDir` 存放映射文件 `bindings.json`（schema 见 [映射文件](subsystems/session-state.md#bindings-file)）；`workspaceRoot` 下每个身份以 `<workspaceRoot>/<bindingId>` 作为 agent 工作目录，见 [会话准备](subsystems/session-state.md#prepare)。运行期配置不含 dsh home。

`DSH_GATEWAY_WORKSPACE` 属于 `DSH_*`，dsh 自动发现的宿主 `.env` 会拒绝它，需要由进程环境注入（如 Node 的 `--env-file` 或服务管理器）；具体部署命令见 [README](../README.md)。

<a id="gateway-limits"></a>

## 固定行为常量

以下常量集中在 [`src/contracts.ts`](../src/contracts.ts) 的 `GATEWAY_LIMITS`，是行为契约：没有对应的配置字段或环境变量覆盖，runtime 总装时注入各组件（见 [运行组合](architecture.md#composition)），改动需要修改源码并重启进程。

| 常量 | 值 | 用途 |
|---|---|---|
| `TURN_DEADLINE_MS` | 600000 ms | 单个 turn 的执行截止，从取得全局执行槽、开始准备会话时计时；覆盖准备与模型/工具执行，不含排队与 QQ 发送 |
| `MAP_WRITE_TIMEOUT_MS` | 5000 ms | 单次映射写事务的总期限 |
| `SESSION_FLUSH_TIMEOUT_MS` | 5000 ms | 单次 session flush 的等待上限 |
| `QQ_OUTBOUND_CALL_TIMEOUT_MS` | 35000 ms | 单次 QQ 出站调用总期限，涵盖取 token 与读取响应体 |
| `QQ_PASSIVE_REPLY_WINDOW_MS` | 3600000 ms | QQ 被动回复有效期，以平台入站时间为起点 |
| `QQ_OUTBOUND_MARGIN_MS` | 180000 ms | 有效期内为出站预留的余量，参与 `queue-expired` 判定 |
| `QQ_MAX_MESSAGES_PER_INBOUND` | 4 条 | 每条入站的最大发送条数，正文、提示与截断说明共享 |
| `QQ_MESSAGE_MAX_LENGTH` | 4000 UTF-16 code units | 单条 markdown 消息的长度上限，按 UTF-16 code units 保守计数 |
| `BUSY_NOTICE_SLOTS` | 4 个 | `busy`、`stopping` 与 `unavailable` 拒绝提示的独立并发发送槽；无等待队列，槽满只记日志 |
| `CANCEL_SETTLE_WAIT_MS` | 5000 ms | 取消后等待 agent 停稳的时间上限 |
| `DISPOSE_WAIT_MS` | 5000 ms | dispose 的等待时间上限 |
| `CANCEL_CLEANUP_BUDGET_MS` | 10000 ms | 取消清理总预算，停稳、flush 与 dispose 共用，不按步骤追加 |
| `STOP_NATURAL_COMPLETION_WAIT_MS` | 5000 ms | 正常停止时等待运行中 `execute` 自然结束的窗口，超时才中断 |
| `CORE_SHUTDOWN_BUDGET_MS` | 25000 ms | runtime 停机总预算：并行等待管理在途操作、core 停止与全部实例停止的上限；core 停止协调器内部也以同一值约束各步骤。任一侧超限记录 `manual_restart_required` 并结束有界等待 |

触发条件与后果见 [回复窗口与时间](subsystems/inbound.md#reply-window)、[调度](subsystems/scheduling.md#scheduler)、[超时、取消与清理](subsystems/scheduling.md#cancellation)、[写事务与故障](subsystems/session-state.md#write-transaction) 与 [投递](subsystems/outbound.md#reply-port)。

<a id="known-gaps"></a>

## 已知缺口

- `isPathOverlapping` 只比较 `path.resolve`/`path.relative` 归一化后的路径字符串，不解析符号链接或 junction；经这类别名指向 dsh home 的 workspace 不会被判为重叠。
- 漂移比较剥离两侧开头 BOM 后比文本，纯 BOM 增删因此不触发 409（见[热生效范围](#hot-reload-scope)），该分支没有自动化用例覆盖：`tests/` 未构造带开头 BOM 的配置文件，也没有纯 BOM 增删的漂移用例。
