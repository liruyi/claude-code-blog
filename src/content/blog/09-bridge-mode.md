---
title: "深入 Claude Code CLI 源码：Bridge/Remote Control 远程执行"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 9
readingTime: "16 min"
---

Bridge 模式是 Claude Code 最有趣的功能之一——它允许本地 CLI 作为远程执行的终端，被云端后端控制。今天我们来深入分析这个系统。

## Bridge 是什么？

想象一下场景：你在公司的开发机上运行 Claude Code，但想在家里继续工作。Bridge 模式让你可以：

- 本地 CLI 连接到云端后端
- 云端分配任务给本地执行
- WebSocket/SSE 实时通信
- 多会话并行工作

这是'远程控制'的真正含义——你的本地机器是执行者，云端是调度者。

## 核心类型定义

### BridgeConfig

```typescript
type BridgeConfig = {
  dir: string                    // 工作目录
  machineName: string            // 机器名
  branch: string                 // Git 分支
  gitRepoUrl: string | null      // Git 仓库 URL
  maxSessions: number            // 最大会话数
  spawnMode: SpawnMode           // 启动模式
  sandbox: boolean               // 沙盒模式
  bridgeId: string               // Bridge 实例 UUID
  environmentId: string          // 环境 ID
  apiBaseUrl: string             // API 基础 URL
  sessionIngressUrl: string      // Session 入口 URL
}
```

### SpawnMode

三种启动模式：

```typescript
type SpawnMode =
  | 'single-session'  // 单会话，cwd 执行
  | 'worktree'        // 每个会话独立 worktree
  | 'same-dir'        // 持久服务器，共享 cwd
```

`worktree` 模式最有趣——每个会话创建独立的 git worktree，避免多会话间的文件冲突。

### WorkSecret

当云端分配任务时，会发送一个加密的 WorkSecret：

```typescript
type WorkSecret = {
  version: number
  session_ingress_token: string  // JWT
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: {
      repo: string
      ref?: string
      token?: string
    }
  }>
  auth: Array<{
    type: string
    token: string
  }>
  claude_code_args?: Record<string, string>
  mcp_config?: unknown
  environment_variables?: Record<string, string>
}
```

这包含了会话执行所需的全部凭据和配置，使用 base64url 编码传输。

## 启用检查

Bridge 不是默认启用的，需要满足多个条件：

```typescript
async function getBridgeDisabledReason(): Promise<string | null> {
  if (!isClaudeAISubscriber()) {
    return 'Remote Control requires a claude.ai subscription...'
  }
  if (!hasProfileScope()) {
    return 'Remote Control requires a full-scope login token...'
  }
  if (!getOauthAccountInfo()?.organizationUuid) {
    return 'Unable to determine your organization...'
  }
  if (!(await checkGate('tengu_ccr_bridge'))) {
    return 'Remote Control is not yet enabled for your account.'
  }
  return null
}
```

检查顺序：
1. 订阅者身份
2. Token scope
3. 组织归属
4. GrowthBook gate

每一步都有明确的错误消息，帮助用户理解为什么不能使用。

## 主轮询循环

Bridge 的核心是 `runBridgeLoop`：

```typescript
async function runBridgeLoop(config, environmentId, environmentSecret, api, spawner, logger, signal) {
  const activeSessions = new Map<string, SessionHandle>()
  const completedWorkIds = new Set<string>()
  const capacityWake = createCapacityWake(loopSignal)

  while (!loopSignal.aborted) {
    // 轮询工作
    const work = await pollForWorkWithBackoff(...)
    if (work) {
      await handleWork(work)
    }

    // 心跳活跃会话
    await heartbeatActiveSessions()

    // 检查超时
    await checkSessionTimeouts()

    // 等待下一次轮询
    await sleep(pollInterval)
  }

  await cleanupActiveSessions()
}
```

### BackoffConfig

轮询失败时有退避策略：

```typescript
type BackoffConfig = {
  connInitialMs: number      // 连接退避初始延迟 (2000ms)
  connCapMs: number          // 连接退避上限 (120000ms)
  connGiveUpMs: number       // 连接放弃时间 (600000ms)
  generalInitialMs: number   // 通用退避初始延迟 (500ms)
  generalCapMs: number       // 通用退避上限 (30000ms)
}
```

如果网络不稳定，轮询间隔会从 2 秒逐渐增加到最多 2 分钟，超过 10 分钟无响应则放弃。

### 会话心跳

活跃会话需要定期心跳，告诉云端'我还活着'：

```typescript
async function heartbeatActiveSessions() {
  for (const [sessionId, handle] of activeSessions) {
    const result = await api.heartbeatWork(environmentId, workId, sessionToken)
    if (!result.lease_extended) {
      // 会话被云端终止
      handle.kill()
    }
  }
}
```

心跳失败意味着云端认为这个会话应该终止。

## SessionHandle

每个会话有一个 SessionHandle 来管理：

```typescript
type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>
  kill(): void                   // 优雅终止
  forceKill(): void              // 强制终止
  activities: SessionActivity[]  // 活动环形缓冲
  currentActivity: SessionActivity | null
  accessToken: string
  writeStdin(data: string): void // 直接写入 stdin
}
```

环形缓冲记录最近的活动，用于调试和状态显示。

## JWT Token 管理

会话使用 JWT token 认证：

```typescript
type SessionIngressToken = {
  header: {
    alg: 'HS256'
    typ: 'JWT'
  }
  payload: {
    session_id: string
    environment_id: string
    exp: number        // 过期时间
    iat: number        // 签发时间
  }
  signature: string
}
```

Token 会过期，需要定期刷新：

```typescript
function updateAccessToken(token: string): void {
  // 解析新 token
  // 更新 API 客户端配置
  // 通知相关组件
}
```

## Bridge Logger

Bridge 模式有专门的日志界面：

```typescript
type BridgeLogger = {
  printBanner(config: BridgeConfig, environmentId: string): void
  logStatus(message: string): void
  logSessionStart(sessionId: string, prompt: string): void
  logSessionComplete(sessionId: string, durationMs: number): void
  updateSessionActivity(sessionId: string, activity: SessionActivity): void
  setSessionTitle(sessionId: string, title: string): void
  updateSessionCount(active: number, max: number, mode: SpawnMode): void
  toggleQr(): void    // 显示/隐藏 QR 码
}
```

多会话模式下，Logger 会显示一个漂亮的会话列表，每个会话有状态、活动、标题。

## Trusted Device

Bridge 有一个 trusted device 机制，用于识别可信设备：

```typescript
type TrustedDevice = {
  device_id: string
  device_name: string
  trusted_at: number
}
```

可信设备可以跳过某些安全检查，比如自动接受某些权限请求。

## Flush Gate

有一个 flush gate 机制，控制会话状态的同步：

```typescript
type FlushGate = {
  pendingFlush: boolean
  flushInterval: number
  lastFlush: number
}

async function flushSessionState() {
  if (!pendingFlush || Date.now() - lastFlush < flushInterval) return
  // 同步状态到云端
  pendingFlush = false
  lastFlush = Date.now()
}
```

避免频繁同步，减少网络负载。

## 总结

Bridge/Remote Control 系统展示了远程执行的复杂设计：

1. **多条件启用检查**：订阅、scope、组织、gate
2. **三种 Spawn 模式**：单会话/worktree/共享目录
3. **WorkSecret 凭据传递**：加密的任务配置
4. **轮询+心跳机制**：保持会话活跃
5. **JWT Token 管理**：安全认证和刷新
6. **退避策略**：网络不稳定时的优雅降级
7. **多会话管理**：并行执行和状态显示

下一篇我会分享 Skills 和 Memory 系统，看看 Claude Code 如何实现可扩展行为和持久记忆。
