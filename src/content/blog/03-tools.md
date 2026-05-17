---
title: "深入 Claude Code CLI 源码：30+ 工具的设计哲学"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 3
readingTime: "17 min"
---

今天我们来聊聊 Claude Code 的工具系统。这是 CLI 的核心能力层，提供了约 30+ 种工具。每个工具的设计都让我印象深刻——统一接口、安全默认值、分层权限检查。

## 统一的 Tool 接口

所有工具基于同一个接口定义：

```typescript
type Tool<Input, Output> = {
  // 标识
  name: string
  aliases?: string[]
  searchHint?: string

  // Schema（Zod v4）
  inputSchema: Input
  outputSchema?: z.ZodType<unknown>

  // 执行
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult>

  // 权限与安全
  checkPermissions(input, context): Promise<PermissionResult>
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  isEnabled(): boolean

  // UI 渲染
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(...): React.ReactNode
}
```

这让我想到一个设计原则：**接口统一，实现各异**。每个工具可以有自己的复杂实现，但对外接口一致。

## buildTool 工厂函数

工厂函数提供安全默认值：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input) => false,  // 默认假设不安全
  isReadOnly: (_input) => false,          // 默认假设写入
  isDestructive: (_input) => false,       // 需工具自己声明
  checkPermissions: (input) => ({ behavior: 'allow' }),
}
```

'默认假设不安全'——这是一个重要的安全哲学。工具必须显式声明自己是安全的，而不是默认安全。

## FileReadTool：读取的复杂度

文件读取看起来简单，但实际上考虑了很多：

### 设备文件阻止

```typescript
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom',
  '/dev/tty', '/dev/console', '/dev/stdin',
])
```

读取 `/dev/zero` 会返回无限数据，必须阻止。

### macOS 截图路径问题

```typescript
// macOS 截图文件名中 AM/PM 前的空格可能是普通空格或窄空格 (U+202F)
const THIN_SPACE = String.fromCharCode(8239)
```

这是一个有趣的细节——macOS 截图文件名中的空格字符不稳定，需要两种路径尝试。

### 读取去重优化

```typescript
// 已读取的相同范围且文件未修改时，返回 stub
const existingState = readFileState.get(fullFilePath)
if (existingState && !existingState.isPartialView && rangeMatch) {
  const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
  if (mtimeMs === existingState.timestamp) {
    return { type: 'file_unchanged', file: { filePath } }
  }
}
```

避免重复发送相同内容给 API，节省 token。

## FileEditTool：编辑的安全边界

编辑工具的安全设计更严格：

### 必须先读取

```typescript
const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
if (!readTimestamp || readTimestamp.isPartialView) {
  return {
    result: false,
    message: 'File has not been read yet. Read it first before writing.',
    errorCode: 6,
  }
}
```

不能编辑未读取的文件——这是防止意外覆盖的关键规则。

### 文件修改检测

```typescript
if (lastWriteTime > readTimestamp.timestamp) {
  // 检查内容是否真的变了
  const isFullRead = readTimestamp.offset === undefined
  if (isFullRead && fileContent === readTimestamp.content) {
    // 内容未变，安全继续
  } else {
    return { result: false, message: 'File has been modified since read', errorCode: 7 }
  }
}
```

时间戳变了但内容没变的情况（云同步、杀毒软件）也考虑到了。

### Notebook 重定向

```typescript
if (fullFilePath.endsWith('.ipynb')) {
  return {
    result: false,
    message: 'File is a Jupyter Notebook. Use the NotebookEdit tool.',
    errorCode: 5,
  }
}
```

专门的 Notebook 工具处理 `.ipynb` 文件。

## BashTool：最复杂的权限检查

Bash 工具的权限检查有 2600+ 行代码：

### 14 步检查流程

```typescript
async function bashToolHasPermission(input, context) {
  // 1. AST 安全解析（tree-sitter）
  // 2. 复杂命令处理（命令替换、控制流）
  // 3. 语义级检查（zsh builtins, eval）
  // 4. 沙箱自动允许检查
  // 5. Bash deny/ask classifier 并行检查
  // 6. 命令操作符检查（管道、重定向）
  // 7. 传统安全检查
  // 8. 命令分割 + cd 过滤
  // 9. 子命令数限制
  // 10. 多 cd 命令检查
  // 11. cd + git 组合检查（防止 bare repo RCE）
  // 12. 子命令权限检查
  // 13. 路径约束检查
  // 14. 最终决策
}
```

这是一个层层把关的设计，每层都可以阻止执行。

### 安全环境变量白名单

```typescript
const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH',
  'RUST_BACKTRACE', 'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'LANG', 'TERM', 'TZ',
  'ANTHROPIC_API_KEY',
])
```

**永不白名单的变量**：
- `PATH`, `LD_PRELOAD` — 执行劫持
- `PYTHONPATH`, `NODE_PATH` — 模块加载
- `NODE_OPTIONS`, `GOFLAGS` — 代码执行标志

这是安全设计的核心：只允许'行为标志'，不允许'加载路径'。

### 分类器并行检查

```typescript
// 在权限对话框显示时并行运行
export function startSpeculativeClassifierCheck(command, context, signal) {
  const promise = classifyBashCommand(command, cwd, allowDescriptions, 'allow')
  speculativeChecks.set(command, promise)
}
```

用户看到对话框时，后台已经运行 AI 分类器。如果分类器高置信度允许，对话框会自动消失。

## AgentTool：子代理的编排

Agent 工具启动子 Agent 执行复杂任务：

### 18 步执行流程

```typescript
async function* runAgent({ agentDefinition, ... }) {
  // 1. Agent ID 创建
  // 2. Perfetto 追踪注册
  // 3. 消息过滤
  // 4. 文件状态缓存克隆
  // 5. 上下文构建
  // 6. CLAUDE.md 精简（Explore/Plan Agent）
  // 7. 权限模式设置
  // 8. MCP Server 初始化
  // 9. Skill 预加载
  // 10. SubagentStart hooks 执行
  // 11. Agent frontmatter hooks 注册
  // 12. 子 Agent 上下文创建
  // 13. 侧链 transcript 记录
  // 14. 执行 query 循环
  // 15. 转发 API metrics
  // 16. 处理 max_turns_reached
  // 17. 记录并 yield 消息
  // 18. 清理（finally）
}
```

### 内置 Agent 类型

| Agent | 用途 |
|-------|------|
| `Explore` | 快速代码库探索 |
| `Plan` | 设计实现计划 |
| `general-purpose` | 通用多步任务 |
| `claude-code-guide` | CLI 使用指南 |
| `verification` | 代码审查 |

每种 Agent 有不同的权限模式和 token 预算。

## SkillTool：技能的注入

Skill 工具执行预定义的技能：

### Fork vs Inline 模式

**Inline**：内容注入当前对话，共享上下文。
**Fork**：独立子 Agent，有自己的 token 预算。

```typescript
// Fork 模式判断
if (command?.type === 'prompt' && command.context === 'fork') {
  return executeForkedSkill(command, ...)
}
```

什么时候用 Fork？复杂任务、需要独立思考、可能消耗大量 token。

### 安全属性白名单

```typescript
const SAFE_SKILL_PROPERTIES = new Set([
  'type', 'progressMessage', 'contentLength', 'argNames',
  'model', 'effort', 'source', 'pluginInfo', 'disableNonInteractive',
  'name', 'description', 'aliases', 'isMcp', 'isEnabled', 'isHidden',
])
```

只有安全属性的 skill 自动允许——减少权限对话框的噪音。

## 工具分类

### 并发安全

| 安全 | 不安全 |
|------|--------|
| Read, Glob, Grep | Bash, Edit, Write, Agent, Skill |
| WebFetch, WebSearch | |

### 只读 vs 写入

| 只读 | 写入 |
|------|------|
| Read, Glob, Grep | Edit, Write, Bash, Notebook |
| WebFetch, WebSearch | |

### 破坏性声明

只有 `FileEditTool`（overwrite）和 `BashTool`（rm, git push --force）声明破坏性。

## 设计模式

### lazySchema

```typescript
// 避免模块加载时的 Zod schema 构建开销
const inputSchema = lazySchema(() => z.strictObject({...}))
```

### 分层权限检查

1. `validateInput()` — 输入验证
2. `checkPermissions()` — 权限决策
3. 通用权限系统 — 模式处理、对话框

### 上下文修改器

```typescript
return {
  data: result,
  contextModifier(ctx) {
    // 修改 allowedTools、model、effort
    return modifiedContext
  },
}
```

工具执行后可以修改上下文——SkillTool 用这个来注入工具白名单。

## 总结

工具系统展示了 CLI 的核心设计哲学：

1. **统一接口**：所有工具基于 Tool 接口
2. **安全默认值**：默认不安全、默认写入
3. **分层检查**：14 步 Bash 权限检查
4. **白名单设计**：环境变量、skill 属性
5. **并发分类**：安全/不安全明确区分
6. **上下文修改**：工具可修改执行上下文

下一篇我会分享服务层的设计——API、MCP、Compact、Analytics 等核心服务。
