# Agent Note: 用可读 bindingId 同时充当映射键和工作目录名

Status: implemented

## Problem

网关需要为每个聊天身份保存“身份三元组 → dsh session”的映射。这个键同时出现在内存 Map、`bindings.json` 和每个身份的工作目录路径中，必须稳定、可人工定位，并且不能因为平台传入的 peerId 而制造路径穿越或键碰撞。原设计草案使用 `sha256(JSON.stringify([channelId, accountId, peerId]))` 的 64 位十六进制值，但实现和人工运维都需要在映射文件中直接看出是哪个平台、哪个机器人账号和哪个用户。

## Decision

bindingId 采用 `<channelId>_<accountId>_<peerId>` 的可读拼接，QQ 下为 `qq_<AppID>_<user_openid>`。channelId 与 accountId 只允许 `[A-Za-z0-9-]`，peerId 允许 `[A-Za-z0-9_-]`，总长不超过 128。加载映射时，每个键必须等于对应身份重新计算的 bindingId；记录中的身份字段也必须与键一致。`channelId`/`accountId` 不含下划线，保证前两段可无歧义拆分；peerId 中的下划线原样保留。

该键同时作为身份工作目录名。创建目录后对 root 与目标目录做 realpath，拒绝 symlink/junction 逃逸；恢复 session 时再校验持久 cwd 与身份目录一致。完整规则与字段见[会话与状态](../../../architecture.md#session-state)。

## Alternatives considered

**保留 64 位十六进制哈希键。** 它能天然避免分隔符碰撞和路径字符问题，但映射文件无法直接人工定位身份，错误消息和日志只能显示不可读摘要；故障排查时需要反查原始身份，而原始身份并不持久化在键里。可读键在严格校验下能提供同等安全性，因此改用可读键。

**不校验原始身份，直接拼接平台字段作为键和目录名。** 平台字段可能包含 `/`、`.`、`..` 或大小写差异，直接拼接会把外部输入变成路径。实现保留了可读形式，但把字符集、长度和 realpath 校验放在身份键生成与目录创建处，拒绝这种直接拼接。

## Consequences

映射、日志和工作目录可以直接读出渠道、机器人和用户，人工重置时不必先做哈希计算。代价是键包含平台身份信息，应按敏感数据保护；peerId 的字符集必须持续受控；Windows 路径不区分大小写，仅大小写不同的 peerId 会落到同一目录，QQ 的十六进制 openid 形态不受影响。若未来接入的渠道使用其他字符集，需要扩展校验规则而不是绕过它。

## Verification

`tests/contracts.test.ts` 覆盖读形态、确定性、身份段区分、下划线规则、路径不安全字符与长度上限；`tests/state-store.test.ts` 覆盖键与身份不匹配、sessionId 重复和旧哈希键拒绝；`tests/session-manager.test.ts` 覆盖目录 realpath 逃逸与非法 bindingId。真实平台 ID 形态和 Windows 大小写冲突未做端到端验证。
