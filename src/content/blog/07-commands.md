---
title: "深入 Claude Code CLI 源码：斜杠命令系统详解"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 7
readingTime: "13 min"
---

如果你用过 Claude Code CLI，一定用过 `/init`、`/commit` 或者 `/mcp` 这样的斜杠命令。今天我们来深入分析这个命令系统的设计。

## 三种命令类型

Claude Code 定义了三种命令类型：

### Prompt Command
返回提示内容，由模型执行。比如 `/commit`：

```typescript
const ALLOWED_TOOLS = [
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git commit:*)',
]

const command = {
  type: 'prompt',
  name: 'commit',
  description: 'Create a git commit',
  allowedTools: ALLOWED_TOOLS,
  async getPromptForCommand(_args, context) {
    const promptContent = getPromptContent()
    return [{ type: 'text', text: finalContent }]
  },
}
```

关键点：`allowedTools` 限制了命令执行时只能使用指定的工具。这样 `/commit` 只能执行 git 相关命令，不会意外删除文件。

### Local Command
本地执行，返回文本结果。不涉及模型调用。

### Local JSX Command
返回 React UI 组件，交互式执行。比如 `/config`：

```typescript
const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  load: () => import('./config.js'),  // 懒加载
}
```

懒加载的好处是：只有真正执行 `/config` 时才加载配置面板的代码，不影响启动速度。

## 命令的来源

命令可以来自多个地方：

| 来源 | 说明 |
|------|------|
| Built-in | 内置命令，编译时硬编码 |
| Skills | 用户定义技能文件（.claude/skills/） |
| Plugins | 插件系统加载 |
| MCP | MCP 服务器动态注册 |
| Bundled | 打包内置技能 |

### Skills 技能文件

技能文件放在 `.claude/skills/` 目录下，可以是简单文件或复杂目录：

```markdown
---
name: verify
description: Run tests and lint checks
allowedTools:
  - Bash(npm run test:*)
  - Bash(npm run lint:*)
---

Run `npm run lint && npm run test` and report the results.
```

这是一个简单技能文件。复杂技能可以有更多配置：

```markdown
---
name: deploy
description: Deploy to production
version: 1.0.0
context: fork              # fork = 子代理执行
agent: general-purpose     # 代理类型
effort: high               # effort 级别
hooks:
  PreToolUse:
    - event: Bash
      command: echo 'About to run: $TOOL_INPUT'
allowedTools:
  - Bash(npm run build:*)
  - Bash(npm run deploy:*)
---

## Deployment Process
1. Build the project
2. Run tests
3. Deploy
```

## Fork vs Inline 模式

`context` 字段决定执行方式：

**Inline 模式**：
- 技能内容扩展到当前对话
- 共享主对话的上下文和 token 预算

**Fork 模式**：
- 技能在子代理中执行
- 独立上下文和 token 预算
- 使用指定的 agent 类型

Fork 模式适合复杂的、需要独立思考的任务。Inline 模式适合简单的、与当前对话紧密相关的任务。

## 命令注册的架构

命令注册在 `src/commands.ts` 中，有一个有趣的设计——**条件导入**：

```typescript
const proactive = feature('PROACTIVE')
  ? require('./commands/proactive.js').default
  : null

const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

这些条件导入在编译时会被评估。如果 `BRIDGE_MODE` 未启用，`/bridge` 命令的代码根本不会出现在最终产物中。

### 命令数组

最终命令数组是动态组装的：

```typescript
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  // ... 核心命令
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(feature('BRIDGE_MODE') ? [bridge] : []),
  ...(feature('VOICE_MODE') ? [voiceCommand] : []),
])
```

使用 `memoize` 缓存命令列表，避免重复计算。

## MCP 动态命令

MCP 服务器可以动态注册命令。这是通过 MCP 的 prompt templates 实现的：

```typescript
type McpPromptTemplate = {
  name: string
  description: string
  arguments?: Array<{
    name: string
    description: string
    required: boolean
  }>
}

function convertMcpPromptToCommand(prompt: McpPromptTemplate, serverName: string): Command {
  return {
    type: 'prompt',
    name: `${serverName}/${prompt.name}`,
    description: prompt.description,
    isMcp: true,
    async getPromptForCommand(args, context) {
      const result = await mcpClient.getPrompt(prompt.name, args)
      return result.messages
    },
  }
}
```

这样 MCP 服务器提供的 prompt template 就变成了 Claude Code 的斜杠命令，命名格式为 `/serverName/promptName`。

## 命令执行的流程

当你输入 `/commit some args` 时：

```typescript
// 1. 解析命令名和参数
const [cmdName, args] = parseCommand(input)

// 2. 查找命令
const cmd = commands.find(c => c.name === cmdName || c.aliases?.includes(cmdName))

// 3. 检查可用性
if (!cmd || !isCommandEnabled(cmd)) {
  return 'Command not found'
}

// 4. 执行命令
if (cmd.type === 'prompt') {
  const promptContent = await cmd.getPromptForCommand(args, context)
  // 创建用户消息，触发查询
}

if (cmd.type === 'local-jsx') {
  const module = await cmd.load()
  const ui = await module.call(onDone, context, args)
  render(ui)
}
```

## 权限控制

命令可以限制可用工具：

```typescript
getAppState() {
  const appState = context.getAppState()
  return {
    ...appState,
    toolPermissionContext: {
      ...appState.toolPermissionContext,
      alwaysAllowRules: {
        ...appState.toolPermissionContext.alwaysAllowRules,
        command: ALLOWED_TOOLS,
      },
    },
  }
}
```

这修改了工具权限上下文，让命令执行时自动允许特定工具，无需用户确认。

## Hooks 注册

技能可以在执行时注册 hooks：

```markdown
---
hooks:
  PreToolUse:
    - event: Bash
      command: echo 'Running: $TOOL_INPUT'
---
```

这些 hooks 的生命周期：
1. 技能开始时注册
2. 工具执行前后触发
3. 技能结束时注销

## 总结

Claude Code 的命令系统设计展示了几个要点：

1. **三种命令类型**：Prompt/Local/Local JSX，各有适用场景
2. **多来源加载**：内置、技能、插件、MCP
3. **懒加载模式**：减少启动负担
4. **条件编译**：未启用的命令代码被删除
5. **Fork/Inline 模式**：灵活的执行上下文
6. **权限控制**：`allowedTools` 限制工具范围
7. **Hooks 集成**：技能可以注册生命周期钩子

下一篇我会分享权限系统，看看 Claude Code 如何安全地管理工具执行权限。
