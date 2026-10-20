# Agent Note 模板

记录的命名、主题分类和生命周期见 [Notes 约定](README.md)。

## 文件格式

文件开头使用下述固定格式，标题正文使用中文，`Status:` 与目录的生命周期一致。

```markdown
# Agent Note: 标题

Status: proposed
```

活动状态为 `proposed`、`implemented` 或 `rejected — 一行否决理由`。日期由文件名承载。正文以 `## Problem` 开始；以下标题与字段沿用 dsh 格式，说明文字使用中文。

每篇必须包含 `## Alternatives considered`。每个实际考虑过的替代方案使用加粗开头的段落或 `### Why not <方案>?` 小节，说明为何未采用；不编造替代方案。

### proposed 模板

```markdown
# Agent Note: 标题

Status: proposed

## Problem

说明问题与约束，先独立讲清动机。

## Proposal

说明拟采用的方案；必要时增加专门的技术章节。

## Alternatives considered

列出实际考虑过的替代方案及其未被选择的理由。

## Acceptance criteria

说明哪些可观察结果代表方案完成。

## Risks

说明可能出错的地方、已接受的代价与限制。
```

### implemented 模板

```markdown
# Agent Note: 标题

Status: implemented

## Problem

说明问题与约束。

## Decision

用现在时概述实际采用的决定及关键约束，并链接所属文档中的当前契约。

## Alternatives considered

保留实际考虑过的替代方案及取舍理由。

## Consequences

说明获得的收益与接受的代价。
```

必要时增加 `## Verification` 等章节，记录实际执行的验证、结果与仍存在的覆盖缺口。

已被新决定取代的记录按 [维护约定](README.md#维护) 标注适用范围与后继记录。

### rejected 模板

保留被否决时的方案正文和章节，将状态改为 `Status: rejected — 一行否决理由`。仍以 `## Problem` 开始，包含 `## Proposal` 和 `## Alternatives considered`。

下方按完整提案骨架展示被否决的记录；已有记录沿用否决时的章节，不为套用模板而重写历史正文。

```markdown
# Agent Note: 标题

Status: rejected — 一行否决理由

## Problem

保留提出方案时的问题与约束。

## Proposal

保留当时考虑的方案。

## Alternatives considered

保留实际考虑过的替代方案及取舍理由。

## Acceptance criteria

保留提案中已有的验收条件。

## Risks

保留当时识别的风险与代价。
```
