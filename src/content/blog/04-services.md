---
title: "深入 Claude Code CLI 源码：服务层的架构设计"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 4
readingTime: "24 min"
---

今天我们来聊聊 Claude Code 的服务层。这是 CLI 的核心能力支撑——API 调用、MCP 集成、对话压缩、遥测分析、LSP 集成等。每个服务都是独立的子系统，但它们共同支撑了 CLI 的完整功能。

## API 服务：多平台支持

### 四种 API 平台

```typescript
export async function getAnthropicClient({ apiKey, model, ... }) {
  // 1. AWS Bedrock
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    return new AnthropicBedrock({ awsRegion, awsAccessKey, ... })
  }

  // 2. Azure Foundry
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    return new AnthropicFoundry({ azureADTokenProvider, ... })
  }

  // 3. Google Vertex AI
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    return new AnthropicVertex({ region, googleAuth, ... })
  }

  // 4. Direct Anthropic API
  return new Anthropic({
    apiKey: isClaudeAISubscriber() ? null : apiKey,
    authToken: isClaudeAISubscriber() ? getClaudeAIOAuthTokens()?.accessToken : undefined,
  })
}
```

四种平台，一套代码。用户只需要设置环境变量切换。

### 自定义 Headers

```typescript
// ANTHROPIC_CUSTOM_HEADERS: 多行 'Name: Value' 格式
const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS
const headerStrings = customHeadersEnv.split(/\n|\r\n/)
for (const headerString of headerStrings) {
  const colonIdx = headerString.indexOf(':')
  const name = headerString.slice(0, colonIdx).trim()
  const value = headerString.slice(colonIdx + 1).trim()
  customHeaders[name] = value
}
```

企业代理场景：多行 header 配置，简单解析。

### Client Request ID

```typescript
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(fetchOverride, source) {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    return inner(input, { ...init, headers })
  }
}
```

每个请求一个 UUID——超时请求可以关联日志。

## MCP 服务：模型上下文协议

MCP 是 Anthropic 的开放协议，让外部工具可以接入 Claude。

### 五种传输协议

```typescript
type Transport =
  | 'stdio'    // 标准输入输出（本地进程）
  | 'sse'      // Server-Sent Events
  | 'sse-ide'  // IDE SSE
  | 'http'     // HTTP
  | 'ws'       // WebSocket
  | 'sdk'      // SDK 内部
```

本地 MCP server 用 stdio，远程用 SSE/HTTP/WebSocket。

### 连接状态

```typescript
type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: { name: string, version: string }
  instructions?: string
}

type FailedMCPServer = {
  name: string
  type: 'failed'
  error?: string
}

type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
}
```

五种状态：connected, failed, needs-auth, pending, disabled。UI 可以显示每种状态。

### Cross-App Access (XAA)

XAA 是 SEP-990 规范的实现，MCP servers 通过 IdP 认证访问跨应用资源：

```typescript
// XAA 配置在 Server 级别只是一个布尔标志
const McpXaaConfigSchema = z.boolean()

// IdP 连接详情来自 settings.xaaIdp — 一次配置，共享所有 XAA-enabled servers
type XaaIdpConfig = {
  issuer: string
  clientId: string
  callbackPort: number
}
```

一次 IdP 配置，所有 XAA server 共享。

## Compact 服务：对话压缩

当对话太长时，需要压缩历史以节省 token。

### 压缩流程

```typescript
async function compactConversation(messages, context, ...) {
  // 1. Pre-compact token 计数
  const preCompactTokenCount = tokenCountWithEstimation(messages)

  // 2. 执行 PreCompact hooks
  await executePreCompactHooks({ trigger: isAutoCompact ? 'auto' : 'manual' })

  // 3. 获取压缩提示
  const compactPrompt = getCompactPrompt(customInstructions)

  // 4. PTL 重试循环（如果压缩请求本身太长）
  for (;;) {
    summaryResponse = await streamCompactSummary(...)
    if (!summary?.startsWith('prompt is too long')) break
    messagesToSummarize = truncateHeadForPTLRetry(messagesToSummarize)
  }

  // 5. 清除文件状态缓存
  context.readFileState.clear()

  // 6. 创建 post-compact attachments
  const [fileAttachments, asyncAgentAttachments] = await Promise.all([
    createPostCompactFileAttachments(preCompactReadFileState, context, 5),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])

  // 7. 执行 PostCompact hooks
  await executePostCompactHooks({ trigger, compactSummary: summary })
}
```

### Token 常量

```typescript
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
```

压缩后恢复最多 5 个文件，每个文件最多 5000 token。

### 图片剥离

```typescript
function stripImagesFromMessages(messages): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    const newContent = content.flatMap(block => {
      if (block.type === 'image') return [{ type: 'text', text: '[image]' }]
      if (block.type === 'document') return [{ type: 'text', text: '[document]' }]
      return [block]
    })
    return { ...message, message: { ...message.message, content: newContent } }
  })
}
```

图片被替换为 `[image]` 文本——压缩时不需要图片内容。

## Analytics 服务：遥测与 Feature Flags

### GrowthBook Feature Flags

```typescript
type GrowthBookUserAttributes = {
  id: string              // Device ID
  sessionId: string       // Session ID
  platform: 'win32' | 'darwin' | 'linux'
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
}
```

基于用户属性的 feature flags。

### 缓存优先策略

```typescript
function getFeatureValue_CACHED_MAY_BE_STALE<T>(feature, defaultValue): T {
  // 1. Env var overrides (eval harnesses)
  // 2. Config overrides (/config Gates tab)
  // 3. In-memory payload
  // 4. Disk cache fallback
}
```

'缓存优先，阻塞备用'——避免每次 API 调用都等待 feature flag。

### 刷新机制

```typescript
// Ant: 20 分钟刷新
// External: 6 小时刷新
const GROWTHBOOK_REFRESH_INTERVAL_MS =
  process.env.USER_TYPE !== 'ant'
    ? 6 * 60 * 60 * 1000
    : 20 * 60 * 1000
```

内部用户更频繁刷新，外部用户降低负载。

### Env Override（Eval Harness）

```typescript
// CLAUDE_INTERNAL_FC_OVERRIDES='{'my_feature': true}'
// 仅 USER_TYPE === 'ant' 时生效
let envOverrides: Record<string, unknown> | null = null

function getEnvOverrides() {
  if (process.env.USER_TYPE === 'ant') {
    const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
    if (raw) envOverrides = JSON.parse(raw)
  }
  return envOverrides
}
```

内部测试时，可以绕过远程 eval 和 disk cache。

## LSP 服务：语言服务器协议

### 异步初始化

```typescript
let lspManagerInstance: LSPServerManager | undefined
let initializationState: 'not-started' | 'pending' | 'success' | 'failed'

export function initializeLspServerManager() {
  // --bare 模式跳过 LSP
  if (isBareMode()) return

  // 创建实例
  lspManagerInstance = createLSPServerManager()
  initializationState = 'pending'

  // 异步初始化
  initializationPromise = lspManagerInstance.initialize()
    .then(() => { initializationState = 'success' })
    .catch(() => { initializationState = 'failed'; lspManagerInstance = undefined })
}
```

LSP 不阻塞启动——失败就降级，不影响主功能。

### 插件刷新后重新初始化

```typescript
export function reinitializeLspServerManager() {
  // 插件刷新后重新初始化以加载新的 LSP servers
  if (lspManagerInstance) {
    void lspManagerInstance.shutdown().catch(...)
  }
  lspManagerInstance = undefined
  initializationState = 'not-started'
  initializeLspServerManager()
}
```

插件可能提供新的 LSP servers，刷新后需要重新初始化。

## OAuth 服务：认证流程

```typescript
// 1. 生成授权 URL
const authUrl = generateAuthUrl({
  clientId,
  redirectUri: `http://localhost:${callbackPort}/callback`,
  scope: 'openid profile email',
})

// 2. 启动本地监听器
const listener = createAuthCodeListener(callbackPort)

// 3. 用户浏览器打开授权 URL
// 4. 授权后重定向到本地
// 5. 获取 access token
const tokens = await exchangeCodeForTokens(code)

// 6. 存储 tokens
saveOAuthTokens(tokens)
```

本地回调端口 + 浏览器授权 = 标准 OAuth 流程。

## 初始化顺序

`init.ts` 的初始化流程有严格的顺序：

```typescript
export const init = memoize(async () => {
  // 1. Configs
  enableConfigs()

  // 2. Safe env vars
  applySafeConfigEnvironmentVariables()

  // 3. Graceful shutdown
  setupGracefulShutdown()

  // 4. 1P Event logging (async)
  void initialize1PEventLogging()

  // 5. OAuth account info (async)
  void populateOAuthAccountInfoIfNeeded()

  // 6. IDE detection (async)
  void initJetBrainsDetection()
  void detectCurrentRepository()

  // 7. Remote managed settings (async)
  void initializeRemoteManagedSettingsLoadingPromise()
  void initializePolicyLimitsLoadingPromise()

  // 8. mTLS config
  configureGlobalMTLS()

  // 9. HTTP proxy
  configureGlobalAgents()

  // 10. API preconnect
  preconnectAnthropicApi()

  // 11. Upstream proxy (CCR)
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    await initUpstreamProxy()
  }

  // 12. Cleanup hooks
  registerCleanup(shutdownLspServerManager)
  registerCleanup(cleanupSessionTeams)
})
```

关键点：
- 配置优先
- 网络/认证配置在 API preconnect 前
- 清理 hook 注册在最后

## 其他重要服务

| 服务 | 用途 |
|------|------|
| `SessionMemory` | 持久化会话记忆 |
| `AgentSummary` | Agent 执行摘要 |
| `PromptSuggestion` | 提示建议 |
| `AutoDream` | 自动会话总结 |
| `ExtractMemories` | 记忆提取 |
| `Plugins` | 插件管理 |
| `PolicyLimits` | 企业策略限制 |
| `MagicDocs` | 文档处理 |
| `Notifier` | 系统通知（iTerm2, Kitty） |

## 总结

服务层展示了模块化架构：

1. **API 服务**：四种平台支持，自定义 headers
2. **MCP 服务**：五种传输协议，XAA 跨应用访问
3. **Compact 服务**：PTL 重试，post-compact attachments
4. **Analytics**：缓存优先，Env override，分级刷新
5. **LSP 服务**：异步初始化，失败降级
6. **OAuth 服务**：标准流程，本地回调
7. **初始化顺序**：配置→网络→API→清理

下一篇我会分享权限系统的设计——看看多层安全如何工作。
