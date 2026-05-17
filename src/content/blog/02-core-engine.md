---
title: "深入 Claude Code CLI 源码：QueryEngine 的设计哲学"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 2
readingTime: "12 min"
---

如果你用过 Claude Code CLI，一定好奇过它是如何管理对话流程的。今天我们来深入分析它的核心引擎——QueryEngine。

## QueryEngine 是什么？

简单说，QueryEngine 是对话生命周期的管理者。它负责：
- 消息状态管理
- API 交互协调
- 工具执行编排
- 权限追踪
- 使用统计

它的核心方法 `submitMessage()` 是一个 AsyncGenerator，支持流式输出、中断、和增量处理。这种设计在 TypeScript 中非常优雅：

```typescript
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean }
): AsyncGenerator<SDKMessage, void, unknown>
```

## 消息提交的完整流程

让我带你走过一次完整的消息提交旅程。

### 第一步：初始化和清理

每次提交新消息时，首先要清理 turn-scoped 的追踪状态：

```typescript
this.discoveredSkillNames.clear()
this.loadedNestedMemoryPaths.clear()
```

然后包装 `canUseTool` 函数，用于追踪权限拒绝：

```typescript
const wrappedCanUseTool: CanUseToolFn = async (...args) => {
  const result = await canUseTool(...args)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({
      tool_name: sdkCompatToolName(tool.name),
      tool_use_id: toolUseID,
      tool_input: input,
    })
  }
  return result
}
```

这个包装很巧妙——它不改变工具权限检查的逻辑，只是默默记录所有的拒绝事件。这些记录最终会出现在 SDK 的返回结果中，让调用者知道哪些操作被拒绝了。

### 第二步：系统提示构建

系统提示不是静态的，而是动态构建的。Claude Code 会根据当前状态组装不同的提示部分：

```typescript
const { defaultSystemPrompt, userContext, systemContext } =
  await fetchSystemPromptParts({
    tools,
    mainLoopModel: initialMainLoopModel,
    mcpClients,
    customSystemPrompt: customPrompt,
  })

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

这里有一个有趣的设计：内存机制的提示是条件注入的。只有在用户覆盖了自动内存路径时，才会加载内存相关的提示。

### 第三步：消息持久化（关键时刻）

在进入查询循环之前，有一个关键的持久化步骤：

```typescript
this.mutableMessages.push(...messagesFromUserInput)

if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  if (isBareMode()) {
    void transcriptPromise  // fire-and-forget
  } else {
    await transcriptPromise
    if (isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH)) {
      await flushSessionStorage()
    }
  }
}
```

为什么要在进入查询循环前持久化？因为如果进程被杀死（比如用户按 Ctrl+C），至少 transcript 里会包含用户刚才输入的内容，而不是只有一堆队列操作记录。

### 第四步：主查询循环

接下来进入 `query()` 函数的主循环。这是一个 `while (true)` 的状态机：

```typescript
while (true) {
  // 准备消息
  let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

  // 应用各种压缩策略
  messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)
  if (feature('HISTORY_SNIP')) {
    const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
    messagesForQuery = snipResult.messages
  }

  // API 调用
  for await (const message of deps.callModel({...})) {
    // 处理流式事件...
  }

  // 工具执行
  const toolUpdates = streamingToolExecutor
    ? streamingToolExecutor.getRemainingResults()
    : runTools(toolUseBlocks, ...)

  // 决定下一个状态或退出
  state = { messages: [...], turnCount: nextTurnCount, ... }
  // 或者
  return { reason: 'completed' }
}
```

## Streaming Tool Execution 的魔法

Claude Code 实现了一个 Streaming Tool Executor，允许工具在 API 流式返回时就开始并行执行：

```typescript
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)
  }
}

// 同时获取已完成的结果
for (const result of streamingToolExecutor.getCompletedResults()) {
  if (result.message) {
    yield result.message
  }
}
```

这大大减少了等待时间。当 API 还在返回后续内容时，前面的工具调用可能已经开始执行了。

## 各种压缩策略

QueryEngine 使用了多层压缩策略来管理 token 预算：

1. **Snip** - 历史剪裁，移除过旧的消息
2. **Microcompact** - 微压缩，保留关键结构
3. **Context Collapse** - 上下文折叠，合并相似内容
4. **Autocompact** - 自动压缩，超过阈值时触发
5. **Reactive Compact** - 响应式压缩，遇到 413 错误时触发

每种策略都有自己的触发条件和保留逻辑，确保重要信息不会丢失。

## Tool 接口的设计

最后说说 Tool 接口，这是 QueryEngine 操作的核心对象：

```typescript
type Tool = {
  name: string
  inputSchema: z.ZodType
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult>
  prompt(options): Promise<string>
  description(input, options): Promise<string>
  isEnabled(): boolean
  isReadOnly(input): boolean
  isConcurrencySafe(input): boolean
  checkPermissions(input, context): Promise<PermissionResult>
  // ... 渲染方法等
}
```

每个工具必须实现这些方法。`isConcurrencySafe` 和 `isReadOnly` 的区分很重要：
- 安全的工具可以并行执行
- 只读工具在 Plan 模式下也能执行

## 总结

QueryEngine 的设计体现了几个重要的工程原则：

1. **AsyncGenerator 模式**：支持流式、可中断、增量处理
2. **状态机设计**：用 while(true) + state 转换，清晰表达循环逻辑
3. **并行工具执行**：Streaming Tool Executor 提升响应速度
4. **多层压缩策略**：适应不同场景的 token 管理
5. **Context 传递模式**：每次迭代更新上下文，保持参数不可变

下一篇我会分享 UI 组件系统，看看 Ink 如何在终端中实现 React 渲染。
