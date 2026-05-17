---
title: "MCP 协议安全：外部工具接入风险"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 8
readingTime: "28 min"
---

MCP (Model Context Protocol) 允许接入外部工具。本篇分析 MCP 的安全边界设计。

## MCP 安全挑战

### 外部工具风险

```
MCP Server 是第三方工具：
- 不受 Claude Code 直接控制
- 可能有恶意实现
- 可能泄露数据
- 可能执行危险操作

风险场景：
1. 恶意 MCP Server 收集用户数据
2. MCP Server 执行危险系统命令
3. MCP Server 泄露对话内容到外部
4. MCP Server 注入恶意指令
```

### 协议层面风险

```
MCP 协议暴露：
- tools/list: 工具列表
- tools/call: 执行工具
- resources/list: 资源列表
- prompts/list: 提示模板

每个接口都可能被滥用：
- tools/call 执行任意操作
- resources/read 读取敏感数据
- prompts/get 注入恶意提示
```

## MCP 白名单机制

### Server 白名单

```typescript
// 企业配置：只允许特定 MCP Server
const ALLOWED_MCP_SERVERS = [
  'filesystem-mcp-server',
  'postgres-mcp-server',
  'github-mcp-server',
]

const DENIED_MCP_SERVERS = [
  'unknown-mcp-server',
  'suspicious-mcp-server',
]

function isMCPServerAllowed(serverName: string): boolean {
  // 黑名单优先
  if (DENIED_MCP_SERVERS.includes(serverName)) {
    return false
  }

  // 企业白名单
  if (ALLOWED_MCP_SERVERS.length > 0) {
    return ALLOWED_MCP_SERVERS.includes(serverName)
  }

  // 无企业策略，默认需要用户确认
  return false  // 默认拒绝，需要确认
}
```

### 工具白名单

```typescript
// MCP 工具也需要白名单
function filterMCPTools(serverName: string, tools: MCPTool[]): MCPTool[] {
  const allowedTools = getMCPToolWhitelist(serverName)

  return tools.filter(tool => {
    // 检查工具是否在白名单
    if (allowedTools.length > 0) {
      return allowedTools.includes(tool.name)
    }

    // 无白名单，检查工具风险等级
    const riskLevel = assessMCPToolRisk(tool)

    if (riskLevel === 'high' || riskLevel === 'critical') {
      return false  // 高风险工具默认拒绝
    }

    return true
  })
}
```

## MCP 配置验证

### 配置文件安全检查

```typescript
interface MCPConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  transport?: 'stdio' | 'sse' | 'ws'
}

async function validateMCPConfig(config: MCPConfig): ValidationResult {
  // 1. Server 名称检查
  if (!config.name || config.name.length === 0) {
    return { valid: false, error: 'MCP Server 名称不能为空' }
  }

  // 2. 命令检查
  const commandCheck = checkMCPCommand(config.command)
  if (!commandCheck.valid) {
    return commandCheck
  }

  // 3. 参数检查
  if (config.args) {
    const argsCheck = checkMCPArgs(config.args)
    if (!argsCheck.valid) {
      return argsCheck
    }
  }

  // 4. 环境变量检查
  if (config.env) {
    const envCheck = checkMCPEnv(config.env)
    if (!envCheck.valid) {
      return envCheck
    }
  }

  // 5. 白名单检查
  if (!isMCPServerAllowed(config.name)) {
    return { valid: false, error: 'MCP Server 不在白名单中' }
  }

  return { valid: true }
}
```

### 命令安全检查

```typescript
function checkMCPCommand(command: string): ValidationResult {
  // 检查危险命令
  const dangerousCommands = [
    'curl',
    'wget',
    'nc',
    'bash',
    'sh',
    'python',
    'node',
    'eval',
  ]

  // 直接的危险命令
  if (dangerousCommands.includes(command)) {
    return {
      valid: false,
      error: `MCP Server 命令 '${command}' 可能不安全`,
    }
  }

  // 检查路径
  if (command.startsWith('/') || command.startsWith('./')) {
    // 绝对路径或相对路径需要额外检查
    return {
      valid: true,
      warning: 'MCP Server 使用本地路径，请确保来源可信',
    }
  }

  // npx/uvx 相对安全
  if (command === 'npx' || command === 'uvx') {
    return { valid: true }
  }

  // 其他情况需要确认
  return {
    valid: true,
    warning: '未知 MCP Server 命令，请验证来源',
  }
}
```

### 环境变量检查

```typescript
function checkMCPEnv(env: Record<string, string>): ValidationResult {
  const blacklist = ENV_BLACKLIST  // 使用环境变量黑名单

  for (const [key, value] of Object.entries(env)) {
    // 检查黑名单变量
    if (blacklist.has(key)) {
      return {
        valid: false,
        error: `MCP Server 配置包含敏感环境变量: ${key}`,
      }
    }

    // 检查敏感模式
    if (isBlacklistedPattern(key)) {
      return {
        valid: false,
        error: `MCP Server 配置包含可疑环境变量: ${key}`,
      }
    }
  }

  return { valid: true }
}
```

## MCP 工具调用限制

### 工具风险评估

```typescript
function assessMCPToolRisk(tool: MCPTool): RiskLevel {
  // 根据工具描述和 schema 评估风险
  const description = tool.description || ''
  const schema = tool.inputSchema || {}

  // 危险关键词
  const dangerousKeywords = [
    'delete', 'remove', 'destroy', 'execute', 'shell',
    'command', 'system', 'admin', 'root', 'sudo',
  ]

  for (const keyword of dangerousKeywords) {
    if (description.toLowerCase().includes(keyword)) {
      return 'high'
    }
  }

  // 检查 schema 中的危险字段
  if (schema.properties) {
    const dangerousFields = ['command', 'shell', 'exec', 'script']

    for (const field of dangerousFields) {
      if (schema.properties[field]) {
        return 'high'
      }
    }
  }

  // 网络操作
  if (description.toLowerCase().includes('fetch') ||
      description.toLowerCase().includes('request')) {
    return 'medium'
  }

  // 文件操作
  if (description.toLowerCase().includes('write') ||
      description.toLowerCase().includes('edit')) {
    return 'medium'
  }

  // 只读操作
  if (description.toLowerCase().includes('read') ||
      description.toLowerCase().includes('list') ||
      description.toLowerCase().includes('query')) {
    return 'low'
  }

  return 'medium'  // 默认中等风险
}
```

### 工具调用权限

```typescript
async function callMCPTool(
  serverName: string,
  toolName: string,
  args: object
): MCPToolResult {
  // 1. Server 白名单检查
  if (!isMCPServerAllowed(serverName)) {
    return {
      success: false,
      error: `MCP Server '${serverName}' 未被允许`,
    }
  }

  // 2. 工具风险评估
  const tool = await getMCPTool(serverName, toolName)
  const riskLevel = assessMCPToolRisk(tool)

  // 3. 根据风险等级决定权限
  if (riskLevel === 'critical') {
    return {
      success: false,
      error: '工具风险等级为 critical，禁止执行',
    }
  }

  if (riskLevel === 'high') {
    // 需要用户明确确认
    const confirmed = await askUserPermission(
      `MCP 工具 '${toolName}' 风险较高，是否允许执行？`,
      { details: tool.description, args }
    )

    if (!confirmed) {
      return { success: false, error: '用户拒绝执行' }
    }
  }

  if (riskLevel === 'medium') {
    // 检查权限模式
    const permission = context.permissionMode

    if (permission !== 'auto') {
      // 非 auto 模式需要确认
      const confirmed = await askUserPermission(
        `MCP 工具 '${toolName}' 是否允许执行？`
      )

      if (!confirmed) {
        return { success: false, error: '用户拒绝执行' }
      }
    }
  }

  // 4. 执行工具
  return await executeMCPTool(serverName, toolName, args)
}
```

## MCP 资源限制

### 资源读取限制

```typescript
async function readMCPResource(
  serverName: string,
  uri: string
): MCPResourceResult {
  // 1. Server 白名单
  if (!isMCPServerAllowed(serverName)) {
    return { success: false, error: 'Server 未被允许' }
  }

  // 2. URI 检查
  const uriCheck = checkMCPResourceUri(uri)
  if (!uriCheck.valid) {
    return { success: false, error: uriCheck.error }
  }

  // 3. 敏感资源检查
  if (isSensitiveResource(uri)) {
    const confirmed = await askUserPermission(
      `读取 MCP 资源 '${uri}'，可能包含敏感信息`
    )

    if (!confirmed) {
      return { success: false, error: '用户拒绝' }
    }
  }

  // 4. 执行读取
  const content = await mcpClient.readResource(serverName, uri)

  // 5. 内容检查
  const contentCheck = checkMCPContent(content)
  if (!contentCheck.valid) {
    return { success: false, error: '内容安全检查失败' }
  }

  return { success: true, content }
}
```

### URI 安全检查

```typescript
function checkMCPResourceUri(uri: string): ValidationResult {
  try {
    const parsed = new URL(uri)

    // 检查协议
    const allowedProtocols = ['file', 'http', 'https', 'mcp']
    if (!allowedProtocols.includes(parsed.protocol.replace(':', ''))) {
      return { valid: false, error: '不允许的协议' }
    }

    // HTTP/HTTPS 检查黑名单
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (isBlockedUrl(uri)) {
        return { valid: false, error: 'URL 在黑名单中' }
      }
    }

    // file 协议检查路径
    if (parsed.protocol === 'file:') {
      const path = parsed.pathname
      if (isBlockedPath(path)) {
        return { valid: false, error: '路径禁止访问' }
      }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: 'URI 格式无效' }
  }
}
```

## MCP 输出过滤

### 输出内容检查

```typescript
function checkMCPContent(content: string): ValidationResult {
  // 1. Prompt injection 检测
  const injectionCheck = checkPromptInjection(content)
  if (!injectionCheck.valid) {
    return injectionCheck
  }

  // 2. 敏感信息检测
  const sensitiveCheck = checkSensitiveContent(content)
  if (!sensitiveCheck.valid) {
    return sensitiveCheck
  }

  // 3. 大内容限制
  if (content.length > 500000) {
    return {
      valid: false,
      error: '内容过大，可能有问题',
    }
  }

  return { valid: true }
}

function checkSensitiveContent(content: string): ValidationResult {
  // 检查敏感信息模式
  const sensitivePatterns = [
    /api[_-]?key\s*[:=]\s*\w+/i,
    /password\s*[:=]\s*\w+/i,
    /secret\s*[:=]\s*\w+/i,
    /token\s*[:=]\s*\w+/i,
    /private[_-]?key/i,
  ]

  for (const pattern of sensitivePatterns) {
    if (pattern.test(content)) {
      return {
        valid: false,
        error: '内容可能包含敏感信息',
      }
    }
  }

  return { valid: true }
}
```

### 输出截断

```typescript
const MCP_OUTPUT_LIMIT = 100000  // 100KB

function truncateMCPOutput(content: string): string {
  if (content.length <= MCP_OUTPUT_LIMIT) {
    return content
  }

  // 截断并添加警告
  return content.slice(0, MCP_OUTPUT_LIMIT) + `
... (输出已截断，原始大小 ${content.length} 字节)
`
}
```

## MCP 协议隔离

### 进程隔离

```typescript
async function startMCPServer(config: MCPConfig): MCPClient {
  // MCP Server 作为独立进程运行
  const safeEnv = filterEnvironment(process.env)

  // 添加 MCP 特定环境（安全）
  safeEnv['MCP_SERVER_NAME'] = config.name
  safeEnv['MCP_SESSION_ID'] = context.sessionId

  const child = spawn(config.command, config.args || [], {
    env: safeEnv,
    cwd: config.cwd || context.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 监控进程
  return createMCPClient(child, config)
}
```

### 网络隔离

```typescript
async function connectMCPRemote(url: string): MCPClient {
  // 远程 MCP Server 需要额外验证
  const urlCheck = checkMCPUrl(url)
  if (!urlCheck.valid) {
    throw new Error(urlCheck.error)
  }

  // 建立 WebSocket/SSE 连接
  const client = await connectMCP(url)

  // 验证 Server 身份
  const serverInfo = await client.getServerInfo()

  if (!isMCPServerAllowed(serverInfo.name)) {
    client.close()
    throw new Error('MCP Server 未被允许')
  }

  return client
}
```

## MCP 信任边界

### 信任层级

```
Claude Code 核心工具（最高信任）
├── Read, Edit, Bash（需要权限）
├── Glob, Grep（只读，相对安全）
└── WebFetch, WebSearch（网络限制）

用户配置 MCP Server（中等信任）
├── 白名单 Server（信任）
├── 需确认 Server（待定）
└── 黑名单 Server（拒绝）

第三方 MCP Server（最低信任）
├── 所有工具需要评估
├── 所有输出需要过滤
└── 所有资源需要检查
```

### 信任决策

```typescript
function decideMCPTrust(config: MCPConfig): TrustLevel {
  // 企业白名单
  if (ALLOWED_MCP_SERVERS.includes(config.name)) {
    return 'trusted'
  }

  // 企业黑名单
  if (DENIED_MCP_SERVERS.includes(config.name)) {
    return 'denied'
  }

  // 官方 MCP Server
  if (isOfficialMCP(config)) {
    return 'trusted'
  }

  // 用户之前允许的
  if (userAllowedMCP(config.name)) {
    return 'trusted'
  }

  // 未知来源
  return 'untrusted'
}
```

## 下篇预告

下一篇，我们将深入沙箱执行模式——看看 `--dangerously-skip-permissions` 的危险与隔离策略。
