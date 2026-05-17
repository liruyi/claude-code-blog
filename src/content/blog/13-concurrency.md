---
title: "深入 Claude Code CLI 源码：多 Agent 并发与调度"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 13
readingTime: "19 min"
---

上一篇我们分析了流式响应。今天深入第十个主题：并发与调度。多个 Agent 如何并发执行？资源如何管理？

## 为什么需要并发？

单 Agent 有局限：

- **探索耗时**：大型代码库搜索消耗大量时间
- **任务并行**：研究、实现、验证可以同时进行
- **资源隔离**：每个 Agent 有独立 Token 预算
- **用户响应**：后台 Agent 不阻塞主对话

并发 Agent 是提升效率的关键。

## 并发安全属性

每个工具声明自己的并发属性：

```typescript
type ToolConcurrencyAttributes = {
  isConcurrencySafe(input): boolean  // 是否可并发执行
  isReadOnly(input): boolean          // 是否只读
  isDestructive?(input): boolean      // 是否破坏性
}

// 安全默认值
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,  // 默认不安全
  isReadOnly: () => false,         // 默认写入
  isDestructive: () => false,      // 默认不破坏
}
```

### 工具分类

| 并发安全 | 不安全 |
|----------|--------|
| Read, Glob, Grep | Bash, Edit, Write |
| WebFetch, WebSearch | Agent, Skill |

安全工具并发执行，不安全工具串行。这是关键原则。

## Swarm/Teammate 架构

### Backend 类型

Claude Code 支持三种执行方式：

| Backend | 执行方式 | 通信机制 |
|---------|----------|----------|
| tmux | 独立进程，tmux pane | Mailbox 文件 |
| iTerm2 | 独立进程，iTerm2 pane | Mailbox 文件 |
| in-process | 同进程，AsyncLocalStorage | 内存共享 |

这让我印象深刻——同样的 Agent 概念，三种不同的执行方式。

### Teammate Identity

```typescript
type TeammateIdentity = {
  agentId: string     // agentName@teamName 格式
  agentName: string   // 如 'researcher'
  teamName: string    // 团队名
  color?: string      // UI 显示颜色
}
```

身份解析有优先级：
1. AsyncLocalStorage（in-process teammates）
2. dynamicTeamContext（tmux via CLI args）

这避免了并发覆盖问题——每个 teammate 有独立的上下文。

## Mailbox 消息系统

文件基础的消息传递，使用文件锁保证并发安全：

```typescript
async function writeToMailbox(recipientName: string, message: TeammateMessage) {
  const inboxPath = getInboxPath(recipientName)
  const lockFilePath = `${inboxPath}.lock`

  // 获取锁（重试 10 次，5-100ms 退避）
  const release = await lockfile.lock(inboxPath, {
    lockfilePath: lockFilePath,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
  })

  // 读取、写入、释放锁
  const messages = await readMailbox(recipientName)
  messages.push({ ...message, read: false })
  await writeFile(inboxPath, jsonStringify(messages))
  await release()
}
```

这是经典的文件锁模式——多个进程安全写入同一文件。

### 消息类型

系统定义了多种结构化消息：

- `IdleNotificationMessage` — Agent 空闲通知
- `PermissionRequestMessage` — 权限请求
- `PermissionResponseMessage` — 权限响应
- `ShutdownRequestMessage` — 关闭请求
- `ShutdownApprovedMessage` — 关闭批准
- `TaskAssignmentMessage` — 任务分配

每种消息都有明确的格式和处理逻辑。

## In-Process Teammate

进程内执行使用 AsyncLocalStorage 隔离上下文：

```typescript
const teammateAsyncLocalStorage = new AsyncLocalStorage<TeammateContext>()

function runWithTeammateContext(context: TeammateContext, fn: () => Promise<void>) {
  return teammateAsyncLocalStorage.run(context, fn)
}

function getTeammateContext(): TeammateContext | undefined {
  return teammateAsyncLocalStorage.getStore()
}
```

这是一个巧妙的设计——同一进程内多个 teammate 有独立的上下文，不会互相干扰。

### 工作循环

```typescript
async function runInProcessTeammate(config: InProcessRunnerConfig) {
  while (!abortController.signal.aborted && !shouldExit) {
    // 1. 执行 Agent
    for await (const message of runAgent({ ... })) {
      // 处理消息...
    }

    // 2. 标记空闲
    updateTaskState(taskId, task => ({ ...task, isIdle: true }))

    // 3. 发送空闲通知
    await sendIdleNotification(identity.agentName, ...)

    // 4. 等待下一个提示或关闭请求
    const waitResult = await waitForNextPromptOrShutdown(...)

    // 处理结果...
  }
}
```

循环执行：工作→空闲→等待→工作。Teammate 不是一次性执行，而是持续等待任务。

## Coordinator Mode

协调器模式是并发设计的核心——编排多个 Worker：

```typescript
// Coordinator 系统提示关键部分
`
## Concurrency

**Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible.**

Manage concurrency:
- Read-only tasks (research) — run in parallel freely
- Write-heavy tasks (implementation) — one at a time per file set
- Verification — can run alongside implementation on different areas
`
```

Coordinator 的职责：
1. **理解问题** — 综合研究发现
2. **合成规范** — 写具体的实现指令（不能说 '基于你的发现'）
3. **编排 Worker** — 并行启动研究，串行实现

### 工作流示例

```
用户请求 → Coordinator
                │
                ├─► Worker A (研究 auth) ──┐
                ├─► Worker B (研究 tests) ──┼── 并行
                │                            │
                ◄── Worker A 完成            │
                ◄── Worker B 完成            │
                │                            │
                Coordinator 综合             │
                │                            │
                └─► Worker C (实现)          ── 串行
                    │
                    └─► Worker D (验证)      ── 可并行
```

### Worker 通知

Worker 结果作为 `<task-notification>` XML：

```xml
<task-notification>
  <task-id>agent-a1b</task-id>
  <status>completed</status>
  <summary>Agent 'Investigate auth bug' completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42...</result>
</task-notification>
```

Coordinator 需要区分 task-notification 和真实用户消息。

## Task List 任务抢占

```typescript
function findAvailableTask(tasks: Task[]): Task | undefined {
  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    // 检查阻塞依赖都已解决
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

async function tryClaimNextTask(taskListId: string, agentName: string) {
  const tasks = await listTasks(taskListId)
  const availableTask = findAvailableTask(tasks)
  if (!availableTask) return undefined

  await claimTask(taskListId, availableTask.id, agentName)
  await updateTask(taskListId, availableTask.id, { status: 'in_progress' })

  return formatTaskAsPrompt(availableTask)
}
```

Worker 空闲时会自动抢占无主任务。这是另一个巧妙的设计——任务驱动，而不是指令驱动。

## Permission Sync

Worker 权限请求通过 Mailbox 同步到 Leader：

```typescript
// Worker 发送权限请求
await writeToMailbox(TEAM_LEAD_NAME, {
  from: workerId,
  text: jsonStringify({
    type: 'permission_request',
    request_id: requestId,
    tool_name: toolName,
    input: input,
    permission_suggestions: suggestions,
  }),
})

// Worker 轮询响应（500ms）
const pollInterval = setInterval(async () => {
  const messages = await readMailbox(workerName)
  for (const msg of messages) {
    if (!msg.read && isPermissionResponse(msg.text)) {
      // 处理响应...
    }
  }
}, 500)
```

权限决策在 Leader 端，Worker 轮询等待结果。

## Shutdown 管理

关闭请求是协议化的：

```typescript
// Leader 发送关闭请求
await sendShutdownRequestToMailbox(targetName, { reason: '...' })

// Worker 收到后可以选择批准或拒绝
if (shutdownRequest.reason === '...') {
  await writeToMailbox(TEAM_LEAD_NAME, {
    from: agentName,
    text: jsonStringify({
      type: 'shutdown_approved',
      requestId: shutdownRequest.requestId,
    }),
  })
}
```

Worker 有权拒绝关闭——这是 Agent 自主性的体现。

## 清理机制

```typescript
async function cleanupSessionTeams() {
  // 先杀 panes
  await Promise.allSettled(teams.map(name => killOrphanedTeammatePanes(name)))

  // 再删目录（团队目录 + 任务目录 + worktrees）
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
}
```

会话结束时完整清理——panes、目录、worktrees。

## 总结

并发与调度展示了多 Agent 协调的核心设计：

1. **并发安全属性** — isConcurrencySafe 明确声明
2. **Backend 抽象** — tmux/iTerm2/in-process 三种方式
3. **Mailbox 通信** — 文件锁保证安全
4. **AsyncLocalStorage** — 进程内上下文隔离
5. **Coordinator 编排** — '并行是超能力'
6. **Task List** — 任务抢占机制
7. **Permission Sync** — Mailbox 权限请求/响应
8. **Shutdown 协议** — Request/Approved/Rejected

这个设计让我想到一句话：**并发不只是技术问题，更是协调问题**。Claude Code 用 Mailbox + Protocol 解决了协调，用 isConcurrencySafe 解决了技术。

至此，Agent 设计模式系列完结。从生命周期到并发调度，我们完整分析了 Claude Code CLI 的架构设计。这些模式对构建生产级 AI Agent 系统都有借鉴价值。
