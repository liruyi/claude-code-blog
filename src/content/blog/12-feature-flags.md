---
title: "深入 Claude Code CLI 源码：Feature Flags 与编译时 DCE"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 12
readingTime: "12 min"
---

今天我们来聊聊 Claude Code 的 Feature Flags 系统。这是一个编译时特性开关，使用了 Bun 的独特能力。

## Bun Bundle Feature Flags

如果你看到这样的代码：

```typescript
import { feature } from 'bun:bundle'

if (feature('BRIDGE_MODE')) {
  await bridgeMain(args)
}
```

这不是普通的运行时检查。`feature()` 是 Bun 的编译时函数，返回值在构建时就确定了。

## DCE：死代码消除

DCE（Dead Code Elimination）是关键概念：

```typescript
// 源代码
if (feature('BRIDGE_MODE')) {
  console.log('Bridge mode')
  await bridgeMain()
}

// 构建 A (BRIDGE_MODE=true) 输出：
console.log('Bridge mode')
await bridgeMain()

// 构建 B (BRIDGE_MODE=false) 输出：
// (空 - 代码被完全删除)
```

这意味着：
- 未启用的功能代码**不会**出现在最终产物中
- 用户下载的 CLI 包更小
- 没有'隐藏功能'可以通过修改运行时启用

## 已识别的 Feature Flags

### 核心功能

| Flag | 说明 |
|------|------|
| `BRIDGE_MODE` | 远程控制/桥接模式 |
| `DAEMON` | 后台守护进程 |
| `BG_SESSIONS` | 后台会话管理 |
| `KAIROS` | 助手/主动模式 |
| `COORDINATOR_MODE` | 多 Agent 协调 |
| `BUDDY` | Companion 功能 |
| `AWAY_SUMMARY` | 离线摘要 |

### 数据处理

| Flag | 说明 |
|------|------|
| `HISTORY_SNIP` | Snip 压缩策略 |
| `TRANSCRIPT_CLASSIFIER` | Transcript 分类器 |
| `TEAMMEM` | Team Memory 系统 |
| `TEAMMEM_SYNC` | Team Memory 同步 |

### 工具与扩展

| Flag | 说明 |
|------|------|
| `TEMPLATES` | 模板 Jobs |
| `AGENT_TRIGGERS` | 定时任务触发器 |
| `VOICE_MODE` | 语音输入 |
| `MCP_ADVANCED` | MCP 高级特性 |

### 网络与安全

| Flag | 说明 |
|------|------|
| `CCR_AUTO_CONNECT` | CCR 自动连接 |
| `CHICAGO_MCP` | Computer Use MCP |
| `CLAUDE_IN_CHROME` | Claude in Chrome |

## 使用模式

### 条件代码块

```typescript
if (feature('DAEMON') && args[0] === 'daemon') {
  enableConfigs()
  await daemonMain(args.slice(1))
  return
}
```

### 条件导入

```typescript
const teamMemPaths = feature('TEAMMEM')
  ? require('../memdir/teamMemPaths.js')
  : null

// 使用时检查
if (feature('TEAMMEM') && teamMemPaths) {
  return teamMemPaths.getTeamMemEntrypoint()
}
```

### 条件 Hook

```typescript
if (feature('AWAY_SUMMARY')) {
  // biome-ignore lint/correctness/useHookAtTopLevel
  useAwaySummary(messages, setMessages)
}
```

这里需要 biome-ignore，因为 Biome lint 要求 hooks 在顶层调用。但 `feature()` 是编译时常量，条件分支不影响 hooks 规则。

## 构建变体

不同的 feature flags 组合创建不同的构建：

| 构建 | 启用的 Flags |
|------|-------------|
| Standard CLI | 基础功能 |
| Bridge Build | BRIDGE_MODE, CCR_AUTO_CONNECT |
| Daemon Build | DAEMON, BG_SESSIONS |
| Enterprise | TEAMMEM, TEAMMEM_SYNC |

每种构建有不同的用途和大小。

## 与运行时 Flags 的区别

Claude Code 还有运行时 feature flags（GrowthBook）：

```typescript
// 编译时 DCE
if (feature('BRIDGE_MODE')) {
  // 代码可能被删除
}

// 运行时检查（GrowthBook）
if (isFeatureEnabled('fast_mode')) {
  // 代码保留，运行时判断
}
```

区别：
- `feature()` → 编译时，代码可能被删除
- `isFeatureEnabled()` → 运行时，代码保留但运行时判断

运行时 flags 用于灰度发布、A/B 测试等场景。

## TypeScript 条件类型

Feature flags 甚至影响类型定义：

```typescript
type MemoryType =
  | 'User'
  | 'Local'
  | 'Project'
  | 'Managed'
  | 'AutoMem'
  | (feature('TEAMMEM') extends true ? 'TeamMem' : never)
```

如果 `TEAMMEM` 未启用，`TeamMem` 类型根本不存在。

## ANT-ONLY 内部 Flags

某些 flags 只在 Anthropic 内部使用：

| Flag | 说明 |
|------|------|
| `DUMP_SYSTEM_PROMPT` | 导出系统提示 |
| `ABLATION_BASELINE` | Ablation 测试 |
| `COWORKER_TYPE_TELEMETRY` | Coworker 遥测 |

这些 flags 的代码在公开构建中会被删除。

## 环境变量补充

有些特性使用环境变量做运行时检测：

```typescript
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // CCR 环境
}

if (process.env.USER_TYPE === 'ant') {
  // ANT-ONLY 功能
}
```

这是 feature flags 的补充，用于必须运行时判断的场景。

## 入口路径分流

`cli.tsx` 中大量使用 feature flags 分流：

```typescript
if (feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' || args[0] === 'rc')) {
  enableConfigs()
  // Auth 检查
  // GrowthBook 检查
  // Policy 检查
  await bridgeMain(args.slice(1))
  return
}

if (feature('BG_SESSIONS') && args[0] === 'ps') {
  // 处理后台会话列表
  return
}
```

这确保未启用功能的入口代码不会出现在构建中。

## 最佳实践

### 1. 避免复杂嵌套

```typescript
// ❌ 避免
if (feature('A')) {
  if (feature('B')) {
    if (feature('C')) { ... }
  }
}

// ✅ 推荐
if (feature('A') && feature('B') && feature('C')) { ... }
```

### 2. 条件导入用 require

```typescript
// ✅ 正确
const module = feature('X') ? require('./module.js') : null

// ❌ 错误 - 静态 import 不会被删除
import module from './module.js'
if (feature('X')) { use(module) }
```

### 3. 文档说明

```typescript
// biome-ignore lint/correctness/useHookAtTopLevel: feature() is compile-time constant
```

明确告诉 lint 工具为什么违反规则。

## 总结

Feature Flags 系统展示了编译时特性开关的设计：

1. **编译时 DCE**：未启用代码被删除
2. **多种 Flags**：核心、数据、扩展、安全等分类
3. **条件导入**：使用 require 避免静态导入
4. **类型影响**：条件类型定义
5. **运行时补充**：环境变量 + GrowthBook
6. **构建变体**：不同组合创建不同产物
7. **ANT-ONLY**：内部 flags 在公开构建删除

这就是为什么你在公开版本的 Claude Code CLI 中看不到 `/bridge` 或 `/ultraplan` 命令——它们的代码根本不在你下载的包里。
