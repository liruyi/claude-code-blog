---
title: "深入 Claude Code CLI 源码：Hooks 生命周期系统"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 11
readingTime: "18 min"
---

Hooks 系统是 Claude Code 的'注入点'，允许用户在关键操作前后插入自定义逻辑。今天我们来详细分析这个设计。

## Hooks 是什么？

Hooks 是生命周期事件监听器。当某个事件发生时（比如工具执行前），系统会调用你注册的 hook 函数或脚本。

系统支持多种 hook 类型：

| 类型 | 说明 |
|------|------|
| `command` | 执行 shell 命令 |
| `prompt` | 使用 LLM 验证条件 |
| `agent` | 多轮 LLM 查询验证 |
| `http` | POST 到外部服务 |
| `function` | 内置 JS 函数（内部使用） |

## 27 种 Hook 事件

Claude Code 定义了丰富的 hook 事件：

| 事件 | 触发时机 |
|------|----------|
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后 |
| `PostToolUseFailure` | 工具执行失败后 |
| `PermissionDenied` | Auto 模式拒绝工具 |
| `PermissionRequest` | 权限对话框显示 |
| `UserPromptSubmit` | 用户提交提示 |
| `SessionStart` | 会话启动 |
| `SessionEnd` | 会话结束 |
| `Stop` | 响应结束前 |
| `StopFailure` | API 错误导致结束 |
| `SubagentStart` | 子 Agent 启动 |
| `SubagentStop` | 子 Agent 结束 |
| `PreCompact` | 对话压缩前 |
| `PostCompact` | 对话压缩后 |
| `Setup` | 项目初始化 |
| `TeammateIdle` | Teammate 空闲 |
| `TaskCreated` | 任务创建 |
| `TaskCompleted` | 任务完成 |
| `Elicitation` | MCP 用户输入请求 |
| `ElicitationResult` | MCP 用户输入响应 |
| `ConfigChange` | 配置文件变更 |
| `WorktreeCreate` | Worktree 创建 |
| `WorktreeRemove` | Worktree 移除 |
| `InstructionsLoaded` | 指令文件加载 |
| `CwdChanged` | 工作目录变更 |
| `FileChanged` | 文件变更检测 |
| `Notification` | 通知发送 |

## Hook 配置示例

```json
{
  'hooks': {
    'PreToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': 'echo 'Running Bash tool''
          }
        ]
      },
      {
        'matcher': 'Bash(git *)',
        'hooks': [
          {
            'type': 'command',
            'command': './scripts/pre-git-hook.sh'
          }
        ]
      }
    ],
    'PostToolUse': [
      {
        'matcher': 'Write',
        'hooks': [
          {
            'type': 'http',
            'url': 'https://api.example.com/log',
            'headers': {
              'Authorization': 'Bearer $API_TOKEN'
            },
            'allowedEnvVars': ['API_TOKEN']
          }
        ]
      }
    ]
  }
}
```

### matcher 语法

`matcher` 用来筛选哪些操作触发 hook：

- `Bash` - 所有 Bash 工具调用
- `Bash(git *)` - git 相关命令
- `Write` - 所有 Write 工具调用
- `Write(*.ts)` - 写入 .ts 文件

## Hook 来源优先级

Hook 可以来自多个地方：

```typescript
type HookSource =
  | 'userSettings'     // ~/.claude/settings.json
  | 'projectSettings'  // .claude/settings.json
  | 'localSettings'    // .claude/settings.local.json
  | 'policySettings'   // 管理设置
  | 'pluginHook'       // 插件 hooks
  | 'sessionHook'      // 会话临时 hooks
```

优先级（从高到低）：
1. User Settings
2. Project Settings
3. Local Settings
4. Policy Settings
5. Plugin Hooks（最低）

## Command Hook 执行

Shell 命令 hook 的执行流程：

```typescript
async function execCommandHook(hook, hookEvent, jsonInput) {
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : 30000
  const shellCommand = new ShellCommand({
    command: hook.command,
    shell: hook.shell ?? 'bash',
    timeout: timeoutMs
  })

  const result = await shellCommand.run(jsonInput)

  if (result.code === 0) {
    return { outcome: 'success' }
  } else if (result.code === 2) {
    return { outcome: 'blocking', blockingError: result.stderr }
  } else {
    return { outcome: 'non_blocking_error', stderr: result.stderr }
  }
}
```

### Exit Code 含义

| Exit Code | 含义 |
|-----------|------|
| 0 | 成功，继续执行 |
| 2 | 阻塞，阻止操作（显示 stderr 给模型） |
| 其他 | 非阻塞错误（显示 stderr 给用户，继续执行） |

这个设计很巧妙：用 exit code 区分'阻止'和'警告'。

## Prompt Hook：LLM 验证

Prompt hook 使用 LLM 来验证条件：

```typescript
async function execPromptHook(hook, jsonInput) {
  const response = await queryModel({
    systemPrompt: `You are evaluating a hook.
       Return {'ok': true} if condition is met,
       {'ok': false, 'reason': '...'} if not`,
    model: hook.model ?? 'haiku',  // 默认用便宜模型
    outputFormat: { type: 'json_schema' }
  })

  const parsed = JSON.parse(response)
  if (!parsed.ok) {
    return { outcome: 'blocking', blockingError: parsed.reason }
  }
  return { outcome: 'success' }
}
```

适合复杂条件判断，比如'这个提交是否符合团队规范'。

## Agent Hook：多轮验证

Agent hook 最强大——可以执行多轮工具调用来验证：

```typescript
async function execAgentHook(hook, jsonInput) {
  const hookAgentId = `hook-agent-${uuid()}`

  for await (const message of query({
    messages: [...],
    tools: [..., structuredOutputTool],
    options: { agentId: hookAgentId }
  })) {
    if (message.type === 'attachment' &&
        message.attachment.type === 'structured_output') {
      return parsedResult
    }
    if (turnCount >= MAX_AGENT_TURNS) {
      return { outcome: 'cancelled' }
    }
  }
}
```

最大 50 轮限制，避免无限循环。

## HTTP Hook：调用外部服务

HTTP hook 可以 POST 到外部服务：

```typescript
async function execHttpHook(hook, jsonInput) {
  // URL 白名单检查
  if (policy.allowedUrls && !matchesPattern(hook.url, policy.allowedUrls)) {
    return { ok: false, error: 'URL not in allowlist' }
  }

  // 环境变量插值
  const headers = {}
  for (const [name, value] of Object.entries(hook.headers)) {
    headers[name] = interpolateEnvVars(value, hook.allowedEnvVars)
  }

  const response = await axios.post(hook.url, jsonInput, {
    headers,
    lookup: ssrfGuardedLookup  // SSRF 保护
  })

  return { ok: response.status < 300, body: response.data }
}
```

### 安全特性

1. **URL 白名单**：`allowedHttpHookUrls` 限制可调用的 URL
2. **环境变量白名单**：只有 `allowedEnvVars` 中的变量可以插值
3. **SSRF 保护**：阻止私有 IP 地址
4. **Header 注入防护**：清理 CRLF/NUL 字节

## SSRF Guard

HTTP hook 的 SSRF 保护：

```typescript
function ssrfGuardedLookup(hostname) {
  dns.lookup(hostname, (err, address) => {
    // 检查私有 IP
    if (isPrivateIP(address) && !isLoopback(address)) {
      callback(new Error(`SSRF: blocked private IP`))
      return
    }
    callback(null, address)
  })
}
```

阻止的 IP 范围：
- 10.0.0.0/8
- 172.16.0.0/12
- 192.168.0.0/16
- 169.254.0.0/16（链路本地）

例外：127.0.0.1（本地开发）允许。

## 异步 Hook 注册

某些 hook 可以异步返回结果：

```typescript
type PendingAsyncHook = {
  processId: string
  hookId: string
  startTime: number
  timeout: number
  shellCommand: ShellCommand
}
```

系统会定期检查异步 hook 的结果：

```typescript
async function checkForAsyncHookResponses() {
  for (const hook of pendingHooks) {
    if (hook.shellCommand.status === 'completed') {
      const stdout = await hook.shellCommand.stdout
      // 解析 JSON 响应
      responses.push({ processId, response, ... })
    }
  }
  return responses
}
```

## Hook 事件广播

Hook 执行事件会被广播，用于 SDK 集成：

```typescript
type HookExecutionEvent =
  | { type: 'started', hookId, hookName, hookEvent }
  | { type: 'progress', hookId, stdout, stderr }
  | { type: 'response', hookId, outcome, exitCode }
```

某些事件总是广播（低噪音）：
- `SessionStart`
- `Setup`

其他事件需要 `includeHookEvents` 选项启用。

## 总结

Hooks 系统展示了生命周期注入的丰富设计：

1. **27 种事件**：覆盖工具执行、会话、压缩、配置等
2. **多种 hook 类型**：command/prompt/agent/http/function
3. **Matcher 语法**：精确筛选触发条件
4. **Exit code 语义**：0=成功，2=阻塞，其他=警告
5. **LLM 验证**：prompt/agent hook 使用 AI 判断
6. **HTTP 安全**：白名单、SSRF 保护、header 清理
7. **异步支持**：长时间 hook 可以异步返回

下一篇我会分享 Feature Flags 系统，看看 Bun 的编译时特性开关如何工作。
