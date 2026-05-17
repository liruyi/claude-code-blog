---
title: "深入 Claude Code CLI 源码：会话管理与持久化"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 6
readingTime: "13 min"
---

你有没有想过，Claude Code 如何在关闭后还能恢复之前的对话？今天我们来深入分析会话存储系统，这是 CLI 的记忆中枢。

## JSONL 日志格式

会话数据保存在 JSONL (JSON Lines) 文件中，每行一条记录：

```
~/.claude/projects/<project-id>/session-<uuid>.jsonl
```

为什么用 JSONL 而不是普通 JSON？

```typescript
// JSONL 允许逐行追加，不需要读写整个文件
await appendFile(sessionPath, jsonLine + '\n')
```

普通 JSON 需要读取整个数组、追加、再写入——文件越大越慢。JSONL 只追加一行，性能稳定。

## 消息类型与转录

### Entry 类型定义

```typescript
type Entry =
  | UserMessage           // 用户输入
  | AssistantMessage      // AI 响应
  | AttachmentMessage     // 文件附件
  | SystemMessage         // 系统消息
  | ToolUseSummaryMessage // 工具执行摘要
  | ProgressMessage       // 进度状态（UI 临时）
  | TranscriptMessage     // 转录记录
```

### Transcript Message：转录的核心

```typescript
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}
```

注意：`ProgressMessage` 不是转录消息！它是临时 UI 状态，不持久化到 JSONL。这避免了链式关系断裂（曾导致恢复时消息丢失）。

## parentUuid 链式关系

每条消息通过 `parentUuid` 连接到上一条，形成消息链：

```typescript
type Message = {
  uuid: UUID
  parentUuid: UUID | null  // 第一条消息 parentUuid 为 null
  type: string
  // ...
}
```

### 链式插入

```typescript
function insertMessageChain(messages, parentUuid) {
  let currentParent = parentUuid
  for (const msg of messages) {
    msg.uuid = randomUUID()
    msg.parentUuid = currentParent
    currentParent = msg.uuid
  }
}
```

这种设计支持：
- 消息分支（重试时创建分支）
- 历史回溯（顺着 parentUuid 回溯）
- 压缩恢复（压缩后恢复链式关系）

## 会话恢复流程

当你用 `/resume` 或启动时自动恢复：

```typescript
async function loadSession(sessionId: SessionId) {
  // 1. 定位会话文件
  const sessionPath = getSessionPath(sessionId)

  // 2. 解析 JSONL
  const entries = parseJSONL(await readFile(sessionPath))

  // 3. 过滤转录消息
  const transcriptMessages = entries.filter(isTranscriptMessage)

  // 4. 排序（按时间/uuid）
  const sorted = sortLogs(transcriptMessages)

  // 5. 加载到 REPL
  setMessages(sorted)
}
```

### Tombstone 处理

压缩后，被移除的消息用 Tombstone 标记：

```typescript
type TombstoneMessage = {
  type: 'tombstone'
  uuid: UUID
  parentUuid: UUID
  replacesUuids: UUID[]  // 被替换的消息列表
}
```

Tombstone 表示'这条消息已被压缩替代'，恢复时跳过原始消息，使用压缩后的消息。

## 压缩边界

压缩时会插入边界标记：

```typescript
type SystemCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  uuid: UUID
  parentUuid: UUID
  compactedUuids: UUID[]  // 被压缩的消息
  summary: string         // 压缩摘要
}
```

恢复时遇到 `compact_boundary`，就知道之前的消息已被压缩，可以跳过处理。

## 并发会话

Claude Code 支持多个项目独立会话：

```typescript
// 项目目录 → 项目 ID
const projectId = sanitizePath(getOriginalCwd())

// 会话存储路径
const sessionDir = join(
  getClaudeConfigHomeDir(),
  'projects',
  projectId
)
```

不同项目目录的会话分开存储，不会互相干扰。

### 会话命名

```typescript
async function updateSessionName(sessionId: SessionId, name: string) {
  // 名称写入 .session-name 文件
  await writeFile(join(sessionDir, '.session-name'), name)
}
```

用户可以为会话命名，方便识别。

## 性能优化

### 读取尾部优化

大文件读取尾部用特殊方法：

```typescript
// 不读整个文件，只读尾部 N 行
const tail = readFileTailSync(sessionPath, 1000)
```

原理：用 `fstatSync` 获取文件大小，然后从末尾向前读取固定字节数。

### 首次提示提取

恢复时只需要提取第一个用户提示：

```typescript
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

function extractFirstPrompt(entries) {
  // 跳过 IDE context、hook output 等非核心消息
  for (const entry of entries) {
    if (isUserMessage(entry) && !SKIP_FIRST_PROMPT_PATTERN.test(entry.content)) {
      return entry.content
    }
  }
}
```

这避免了加载大量历史消息。

### Tombstone 重写限制

```typescript
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024  // 50MB
```

Tombstone 重写整个文件，超过 50MB 时跳过，防止内存溢出。

## 消息压缩策略

会话文件会越来越大。压缩策略：

```typescript
type ContextCollapseSnapshotEntry = {
  type: 'context_collapse_snapshot'
  uuid: UUID
  parentUuid: UUID
  tokenCount: number
  summary: string
  preservedMessages: UUID[]
}
```

压缩时：
1. 识别低价值消息（大量 Read/Grep 工具调用）
2. 生成摘要替代
3. 插入 `context_collapse_snapshot` 标记
4. 原始消息被 Tombstone 替换

恢复时，压缩摘要作为上下文，避免加载所有原始消息。

## 会话恢复的边界情况

### 链断裂修复

```typescript
// 修复断裂的 parentUuid 链
function repairChain(messages) {
  for (let i = 1; i < messages.length; i++) {
    if (!messages[i].parentUuid) {
      messages[i].parentUuid = messages[i - 1].uuid
    }
  }
}
```

曾出现过 Progress Message 被误加入链导致断裂，现在严格过滤。

### Worktree 会话

```typescript
type PersistedWorktreeSession = {
  type: 'persisted_worktree_session'
  worktreePath: string
  sessionId: SessionId
}
```

Git worktree 有独立的会话，恢复时能正确切换目录。

## 总结

Claude Code 的会话管理系统展示了几个有趣的设计：

1. **JSONL 格式**：追加式写入，性能稳定
2. **链式关系**：parentUuid 构建消息树
3. **类型过滤**：Progress Message 不持久化，避免链断裂
4. **压缩边界**：compact_boundary 标记压缩边界
5. **并发会话**：不同项目独立存储
6. **性能优化**：尾部读取、首次提示提取、重写限制

下一篇我会分享命令系统，看看斜杠命令是如何设计和实现的。
