---
title: "子 Agent 调度：Fork 模式的独立预算"
description: "name: codebase-analysis"
publishDate: 2024-05-16
order: 9
readingTime: "23 min"
---

复杂任务可以派生子 Agent。本篇分析 Fork 模式如何实现独立上下文和 Token 预算。

## 子 Agent 的必要性

### 场景分析

```
场景1：大量搜索
用户：分析整个代码库的 API 端点
主 Agent：需要读取 100+ 文件
问题：主上下文会被填满

场景2：复杂研究
用户：研究这个 bug 的根因
主 Agent：需要多轮探索
问题：探索过程占用大量 token

场景3：并行任务
用户：同时检查性能和安全
主 Agent：两个任务可以并行
问题：串行执行效率低
```

### 解决方案

```
Fork 模式：
- 创建独立上下文
- 独立 Token 预算
- 完成后只返回结果摘要
- 不污染主上下文
```

## Fork 模式设计

### Fork vs Inline

```typescript
// Inline 模式：子 Agent 共享主上下文
async function inlineAgent(prompt: string): string {
  // 直接在主对话中执行
  const result = await query({
    messages: [...mainMessages, { type: 'user', content: prompt }],
  })

  // 结果进入主上下文
  mainMessages.push(result)
}

// Fork 模式：子 Agent 独立上下文
async function forkAgent(prompt: string): string {
  // 创建新的独立对话
  const result = await query({
    messages: [{ type: 'user', content: prompt }],
    context: 'fork',  // 独立模式
    budget: forkBudget,  // 独立预算
  })

  // 只返回摘要给主上下文
  return result.summary
}
```

### Skill Fork 配置

```markdown
---
name: analyze-api
description: 分析 API 端点
context: fork  # Fork 模式
budget: 50000  # 独立预算 50K
allowedTools: [Read, Glob, Grep]  # 限制工具
---

请分析代码库中的所有 API 端点...
```

## Fork 上下文克隆

### 克隆必要内容

```typescript
function cloneContextForFork(mainContext: ToolContext): ForkContext {
  return {
    // 克隆必要信息
    cwd: mainContext.cwd,
    sessionId: generateForkSessionId(),
    readFileState: new Map(),  // 空的文件缓存

    // 继承配置
    settings: mainContext.settings,
    mcpClients: mainContext.mcpClients,  // 共享 MCP

    // 独立预算
    tokenBudget: mainContext.settings.forkBudget || 50000,

    // 限制工具
    allowedTools: mainContext.settings.forkAllowedTools || ALL_TOOLS,
  }
}
```

### 不克隆的内容

```typescript
// ❌ 不克隆（避免污染）
const dontClone = {
  messages: [],  // 空消息历史
  readFileState: new Map(),  // 空文件缓存
  toolResults: [],  // 空工具结果
}

// ✅ 克隆（必要配置）
const doClone = {
  cwd,  // 工作目录
  settings,  // 配置
  mcpClients,  // MCP 连接（共享）
}
```

## Token 预算管理

### Fork 预算分配

```typescript
const DEFAULT_BUDGETS = {
  main: 200000,  // 主上下文 200K
  fork: 50000,   // Fork 50K
  microFork: 10000,  // 微 Fork 10K
}

function allocateForkBudget(forkType: ForkType): number {
  switch (forkType) {
    case 'explore':
      return 50000  // 探索任务 50K
    case 'research':
      return 100000  // 研究任务 100K
    case 'quick':
      return 10000  // 快速任务 10K
    default:
      return DEFAULT_BUDGETS.fork
  }
}
```

### 预算监控

```typescript
class ForkBudgetMonitor {
  private usedTokens: number = 0
  private budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  checkBeforeRequest(messages: Message[]): boolean {
    const estimated = estimateTokens(messages)

    if (this.usedTokens + estimated > this.budget) {
      // 超预算，触发压缩或结束
      return false
    }

    return true
  }

  recordUsage(tokens: number): void {
    this.usedTokens += tokens

    // 检查是否接近预算
    if (this.usedTokens > this.budget * 0.8) {
      // 80% 预算已用，通知子 Agent
      notifyBudgetWarning(this.usedTokens, this.budget)
    }
  }
}
```

## Fork 执行流程

### 创建 Fork

```typescript
async function createFork(skill: Skill, input: string): ForkResult {
  // 1. 克隆上下文
  const forkContext = cloneContextForFork(mainContext)

  // 2. 设置预算
  forkContext.tokenBudget = skill.budget || DEFAULT_BUDGETS.fork

  // 3. 限制工具
  if (skill.allowedTools) {
    forkContext.allowedTools = skill.allowedTools
  }

  // 4. 创建 Fork 会话
  const forkSessionId = generateForkSessionId()

  // 5. 开始执行
  const result = await executeFork(forkSessionId, skill.prompt, forkContext)

  // 6. 返回摘要
  return {
    sessionId: forkSessionId,
    summary: result.summary,
    findings: result.keyFindings,
  }
}
```

### Fork 执行

```typescript
async function executeFork(
  sessionId: string,
  prompt: string,
  context: ForkContext
): ForkExecutionResult {
  const budgetMonitor = new ForkBudgetMonitor(context.tokenBudget)

  let messages: Message[] = [{ type: 'user', content: prompt }]
  let iterations = 0
  const maxIterations = 20

  while (iterations < maxIterations) {
    // 检查预算
    if (!budgetMonitor.checkBeforeRequest(messages)) {
      // 超预算，生成摘要并结束
      const summary = await generateSummary(messages)
      return { summary, keyFindings: extractKeyFindings(messages) }
    }

    // API 请求
    const response = await streamApiRequest(messages, context)
    messages.push(response)

    // 记录 token 使用
    budgetMonitor.recordUsage(estimateTokens(response))

    // 检查是否完成
    if (response.stop_reason === 'end_turn') {
      // 任务完成
      const summary = await generateSummary(messages)
      return { summary, keyFindings: extractKeyFindings(messages) }
    }

    // 执行工具
    if (response.toolUses) {
      const toolResults = await executeTools(response.toolUses, context)
      messages.push(...toolResults)

      budgetMonitor.recordUsage(estimateTokens(toolResults))
    }

    iterations++
  }

  // 超过最大迭代
  return { summary: '任务超过最大迭代次数', keyFindings: [] }
}
```

## 结果返回主上下文

### 摘要生成

```typescript
async function generateSummary(forkMessages: Message[]): string {
  // 使用快速模型生成摘要
  const summaryPrompt = `
请生成以下对话的简洁摘要（100-200 tokens）：

${formatMessages(forkMessages)}

摘要格式：
1. 任务目标
2. 主要发现
3. 关键结论
`

  const summary = await quickApi(summaryPrompt, { model: 'haiku' })

  return summary
}
```

### 关键发现提取

```typescript
function extractKeyFindings(messages: Message[]): string[] {
  const findings: string[] = []

  // 提取重要信息
  for (const msg of messages) {
    if (msg.type === 'tool_result') {
      // 工具结果中的重要信息
      if (msg.tool === 'Grep' && msg.matches.length > 0) {
        findings.push(`找到 ${msg.matches.length} 个匹配`)
      }

      if (msg.tool === 'Read' && msg.keyLines) {
        findings.push(`关键代码: ${msg.keyLines.join(', ')}`)
      }
    }
  }

  return findings.slice(0, 10)  // 最多 10 个发现
}
```

### 返回主上下文

```typescript
function returnToMainContext(forkResult: ForkResult): void {
  // 只添加摘要消息
  mainMessages.push({
    type: 'assistant',
    content: `
Fork Agent 完成:

摘要: ${forkResult.summary}

关键发现:
${forkResult.findings.map(f => `- ${f}`).join('\n')}
`,
    fork_id: forkResult.sessionId,
  })

  // Fork 详细历史不进入主上下文
  // 用户可以通过 /fork-history 查看
}
```

## 并行 Fork

### 多 Fork 并行

```typescript
async function parallelForks(tasks: ForkTask[]): ForkResult[] {
  // 创建多个并行 Fork
  const forks = tasks.map(task => createFork(task.skill, task.input))

  // 并行执行
  const results = await Promise.all(forks)

  return results
}
```

### 资源限制

```typescript
const MAX_PARALLEL_FORKS = 3

async function parallelForks(tasks: ForkTask[]): ForkResult[] {
  // 分批执行
  const batches = chunk(tasks, MAX_PARALLEL_FORKS)

  const results: ForkResult[] = []

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(task => createFork(task.skill, task.input))
    )
    results.push(...batchResults)
  }

  return results
}
```

### 效果对比

```
❌ 串行执行
任务1: 30s → 任务2: 30s → 任务3: 30s
总时间: 90s

✅ 并行 Fork
任务1 ───►
任务2 ───► ───► 完成
任务3 ───►
总时间: 30s（节省 67%）
```

## Fork 状态通知

### 完成通知

```typescript
function notifyForkComplete(forkResult: ForkResult): void {
  // 通知主 Agent
  mainContext.notifications.push({
    type: 'fork_complete',
    sessionId: forkResult.sessionId,
    summary: forkResult.summary,
  })
}
```

### 进度通知

```typescript
function notifyForkProgress(sessionId: string, progress: number): void {
  mainContext.notifications.push({
    type: 'fork_progress',
    sessionId,
    progress,
    message: `Fork ${sessionId} 进度 ${progress}%`,
  })
}
```

### UI 显示

```
主界面：
┌────────────────────────────────────────────────────────────┐
│ Fork Agent 运行中                                           │
│                                                            │
│ [Fork-abc] 分析 API 端点... 45%                            │
│ [Fork-def] 检查性能问题... 30%                             │
│                                                            │
│ 主对话继续...                                               │
└────────────────────────────────────────────────────────────┘
```

## Fork 模式选择

### 选择标准

| 任务特征 | 推荐模式 | 原因 |
|----------|----------|------|
| 大量搜索 | Fork | 避免填满主上下文 |
| 多轮探索 | Fork | 探索过程不污染主对话 |
| 快速查询 | Inline | 结果直接进入主对话 |
| 需要用户交互 | Inline | Fork 不支持交互 |
| 并行任务 | Fork | 可同时执行 |

### Skill 配置

```markdown
---
# Fork 模式 Skill
name: codebase-analysis
context: fork
budget: 100000
allowedTools: [Read, Glob, Grep]
---

---
# Inline 模式 Skill
name: quick-fix
context: inline
allowedTools: [Read, Edit]
---

---
# 自动判断 Skill
name: smart-task
# 不指定 context，让 AI 根据任务判断
---
```

## Fork 原则总结

### 1. 独立上下文

```
克隆必要配置，空消息历史
```

### 2. 独立预算

```
Fork 50K，不占用主预算
```

### 3. 限制工具

```
allowedTools 限制可用工具
```

### 4. 返回摘要

```
只返回摘要给主上下文
```

### 5. 并行执行

```
多 Fork 可同时运行（限制 3 个）
```

## 下篇预告

下一篇，我们将深入内存管理——看看大文件和消息生命周期如何管理。
