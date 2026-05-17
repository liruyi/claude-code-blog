---
title: "Token 预算管理：200K tokens 如何分配"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 5
readingTime: "20 min"
---

Claude 有 200K token 上下文限制。如何有效利用这个预算，是 AI Agent 的核心挑战。本篇分析 Claude Code 的 Token 管理策略。

## Token 预算的约束

### 200K 是什么意思？

```
200,000 tokens ≈ 150,000 英文字 ≈ 100,000 中文字

实际可用：
- 系统提示：10K-30K
- 工具定义：5K-10K
- 对话历史：50K-100K（压缩前）
- 工具输出：可能 50K-200K（最大来源）
```

### 超限的后果

```
超限请求：
API 返回 413 Payload Too Large

Claude Code 处理：
1. 自动压缩对话
2. 重试请求
3. 如果仍超限，提示用户
```

## Token 预算分配

### 静态分配

| 类别 | 预算 | 说明 |
|------|------|------|
| 系统提示 | 15K | 固定，包含工具定义 |
| 用户消息 | 10K | 单次用户输入限制 |
| AI 响应 | 30K | 单次 AI 输出预算 |
| 工具输出 | 50K | 单次工具输出限制 |
| 历史消息 | 80K | 压缩后的历史 |

### 动态调整

实际分配根据场景调整：

```typescript
function allocateTokenBudget(context: Context): TokenBudget {
  const baseBudget = {
    system: 15000,
    user: 10000,
    assistant: 30000,
    tools: 50000,
    history: 80000,
  }

  // 如果工具输出大，减少历史
  if (context.largeToolOutput) {
    baseBudget.history = 50000
    baseBudget.tools = 100000
  }

  // 如果系统提示大，减少其他
  if (context.largeSystemPrompt) {
    baseBudget.system = 25000
    baseBudget.history = 60000
  }

  return baseBudget
}
```

## 工具输出预算

工具输出是最大的 Token 消耗：

### 输出截断

```typescript
const MAX_TOOL_OUTPUT_TOKENS = 50000

function truncateToolOutput(output: string): string {
  const tokens = estimateTokens(output)

  if (tokens > MAX_TOOL_OUTPUT_TOKENS) {
    // 截断到预算内
    const truncated = output.slice(0, MAX_TOOL_OUTPUT_TOKENS * 4)  // 粗略估计
    return truncated + '\n... [输出已截断]'
  }

  return output
}
```

### 智能截断

不是简单截断，而是保留关键部分：

```typescript
function smartTruncate(output: string, budget: number): string {
  // 1. 识别关键信息
  const keyLines = extractKeyLines(output)

  // 2. 计算关键信息占用的 token
  const keyTokens = estimateTokens(keyLines)

  // 3. 如果关键信息够，只返回关键信息
  if (keyTokens < budget) {
    return keyLines.join('\n')
  }

  // 4. 否则截断关键信息
  return truncate(keyLines, budget)
}

function extractKeyLines(output: string): string[] {
  const lines = output.split('\n')
  const keyLines = []

  for (const line of lines) {
    // 错误行重要
    if (line.includes('error') || line.includes('Error')) {
      keyLines.push(line)
    }

    // 文件路径重要
    if (line.match(/[a-z]+\.ts:[0-9]+/)) {
      keyLines.push(line)
    }

    // 测试结果重要
    if (line.includes('PASS') || line.includes('FAIL')) {
      keyLines.push(line)
    }
  }

  return keyLines
}
```

## 历史消息压缩

历史消息需要压缩以节省 token：

### 压缩触发条件

```typescript
const AUTO_COMPACT_THRESHOLD = 150000  // 150K tokens

function shouldCompact(messages: Message[]): boolean {
  const totalTokens = estimateTokens(messages)

  if (totalTokens > AUTO_COMPACT_THRESHOLD) {
    return true
  }

  return false
}
```

### 压缩策略

Claude Code 有多种压缩策略：

| 策略 | 说明 | Token 效率 |
|------|------|------------|
| Snip | 剪裁过旧消息 | 50-70% |
| Microcompact | 保留结构，精简内容 | 30-50% |
| Context Collapse | 合并相似消息 | 20-40% |
| Autocompact | 自动选择策略 | 30-60% |
| Reactive Compact | 413 错误触发 | 紧急压缩 |

### Snip：历史剪裁

```typescript
function snipCompact(messages: Message[]): Message[] {
  // 只保留最近的 N 条消息
  const KEEP_RECENT = 50

  if (messages.length > KEEP_RECENT) {
    // 剪裁旧消息
    const snipped = messages.slice(messages.length - KEEP_RECENT)

    // 插入剪裁标记
    snipped.unshift({
      type: 'system',
      content: `[${messages.length - KEEP_RECENT} 条消息已剪裁]`,
    })

    return snipped
  }

  return messages
}
```

### Microcompact：结构保留

```typescript
function microcompact(messages: Message[]): Message[] {
  const compacted = []

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      // 工具调用：只保留名称和关键参数
      compacted.push({
        type: 'tool_use_summary',
        tool_name: msg.tool_name,
        key_params: extractKeyParams(msg.input),
      })
    } else if (msg.type === 'tool_result') {
      // 工具结果：只保留摘要
      compacted.push({
        type: 'tool_result_summary',
        success: msg.success,
        summary: summarizeResult(msg.output),
      })
    } else {
      // 其他消息：精简内容
      compacted.push(compactMessage(msg))
    }
  }

  return compacted
}
```

### Context Collapse：相似合并

```typescript
function contextCollapse(messages: Message[]): Message[] {
  // 识别连续的相似消息
  const groups = groupSimilarMessages(messages)

  const collapsed = []

  for (const group of groups) {
    if (group.type === 'read_sequence') {
      // 连续 Read：合并为一次摘要
      collapsed.push({
        type: 'collapsed_read',
        files: group.messages.map(m => m.file_path),
        summary: '读取了多个文件',
      })
    } else if (group.type === 'grep_sequence') {
      // 连续 Grep：合并搜索结果
      collapsed.push({
        type: 'collapsed_grep',
        queries: group.messages.map(m => m.pattern),
        summary: '搜索了多个模式',
      })
    } else {
      // 不相似的保持原样
      collapsed.push(...group.messages)
    }
  }

  return collapsed
}
```

## 压缩边界标记

压缩时插入边界标记：

```typescript
type CompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  compacted_uuids: string[]  // 被压缩的消息 ID
  summary: string            // 压缩摘要
}
```

**作用**：
- 恢复时知道哪些消息被压缩
- 可以选择是否恢复压缩消息

## 优先级保留

某些消息优先保留：

```typescript
const PRESERVE_PRIORITY = {
  user: 1,           // 用户消息最高
  assistant: 2,      // AI 响应其次
  system: 3,         // 系统消息
  tool_use: 4,       // 工具调用
  tool_result: 5,    // 工具结果（最低）
}

function prioritizePreserve(messages: Message[]): Message[] {
  // 按优先级排序
  const sorted = messages.sort((a, b) => {
    return PRESERVE_PRIORITY[a.type] - PRESERVE_PRIORITY[b.type]
  })

  // 从高优先级开始保留
  let budget = CONTEXT_LIMIT
  const preserved = []

  for (const msg of sorted) {
    const tokens = estimateTokens(msg)

    if (budget >= tokens) {
      preserved.push(msg)
      budget -= tokens
    } else {
      // 预算不足，压缩这条消息
      preserved.push(compactMessage(msg))
      budget = 0
    }
  }

  return preserved
}
```

## 系统提示优化

系统提示也需要优化：

### 工具定义精简

```typescript
// 不好的做法：完整 JSON Schema
const toolDef = {
  name: 'Bash',
  description: '...',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '...' },
      timeout: { type: 'number', description: '...' },
      ...  // 很多属性
    }
  }
}

// 好的做法：精简定义
const toolDef = {
  name: 'Bash',
  description: 'Execute bash command',
  parameters: 'command: string, timeout?: number'
}
```

### 动态工具列表

不是所有工具都包含在系统提示：

```typescript
function prepareToolsList(context: Context): Tool[] {
  // 只包含可能用到的工具
  const relevantTools = []

  // 根据当前任务推断需要的工具
  if (context.taskType === 'code_edit') {
    relevantTools.push(Read, Edit, Write, Bash)
  } else if (context.taskType === 'research') {
    relevantTools.push(Read, Grep, Glob, WebFetch)
  } else {
    // 默认：核心工具
    relevantTools.push(Read, Edit, Bash, Agent)
  }

  return relevantTools
}
```

## Token 计算优化

### 粗略估计

快速估计 token 数：

```typescript
// 粗略估计：每 4 字符 ≈ 1 token（英文）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// 中文更准确估计
function estimateTokensChinese(text: string): number {
  // 中文字符 ≈ 1.5 tokens
  const chineseChars = text.match(/[^\x00-\xff]/g)?.length || 0
  const englishChars = text.length - chineseChars

  return Math.ceil(chineseChars * 1.5 + englishChars / 4)
}
```

### 精确计算

需要精确时使用 tiktoken：

```typescript
import { encode } from 'tiktoken'

function exactTokens(text: string): number {
  const tokens = encode(text)
  return tokens.length
}
```

## Token 预算原则

### 1. 预算优先级

```
用户消息 > AI 响应 > 工具调用 > 工具结果
```

### 2. 工具输出控制

```
单次输出限制 50K tokens
截断保留关键信息
```

### 3. 历史压缩策略

```
超 150K → 自动压缩
多种策略：Snip、Microcompact、Context Collapse
```

### 4. 系统提示精简

```
工具定义简化
动态工具列表
```

### 5. 增量处理

```
不一次性加载所有历史
按需加载压缩摘要
```

## 下篇预告

下一篇，我们将深入对话压缩策略——看看 4 种压缩如何选择，信息如何保留。
