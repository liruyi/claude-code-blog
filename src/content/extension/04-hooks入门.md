---
title: "Hooks 入门：24 种事件与配置格式"
description: "read input"
publishDate: 2024-05-16
order: 4
readingTime: "17 min"
---

Hooks 是 Claude Code 的'生命周期注入点'。在特定事件发生时，执行自定义逻辑——验证、通知、记录、甚至阻止操作。

## Hook 是什么？

Hook 的核心概念：

```
事件发生 → Hook 执行 → 可能影响后续行为
```

例如：
- 用户提交 Bash 命令 → PreToolUse Hook → 可能阻止危险命令
- 工具执行完毕 → PostToolUse Hook → 发送 Slack 通知
- 会话开始 → SessionStart Hook → 初始化环境

## 24 种 Hook 事件

Claude Code 提供丰富的 Hook 事件：

### 工具生命周期

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `PreToolUse` | 工具执行前 | ✅ 是 |
| `PostToolUse` | 工具执行成功后 | ❌ 否 |
| `PostToolUseFailure` | 工具执行失败后 | ❌ 否 |

### 会话生命周期

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `SessionStart` | 会话开始时 | ❌ 否 |
| `SessionEnd` | 会话结束时 | ❌ 否 |
| `Setup` | 初始化设置时 | ❌ 否 |

### 停止事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `Stop` | 任务成功停止 | ❌ 否 |
| `StopFailure` | 任务失败停止 | ❌ 否 |

### 子 Agent

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `SubagentStart` | 子 Agent 启动时 | ❌ 否 |
| `SubagentStop` | 子 Agent 结束时 | ❌ 否 |

### 压缩事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `PreCompact` | 对话压缩前 | ❌ 否 |
| `PostCompact` | 对话压缩后 | ❌ 否 |

### 权限事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `PermissionRequest` | 权限请求时 | ✅ 是 |
| `PermissionDenied` | 权限被拒绝时 | ❌ 否 |

### 任务事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `TaskCreated` | 任务创建时 | ❌ 否 |
| `TaskCompleted` | 任务完成时 | ❌ 否 |

### 用户交互

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `UserPromptSubmit` | 用户提交提示前 | ✅ 是 |
| `Notification` | 显示通知时 | ❌ 否 |

### 协作事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `TeammateIdle` | 协作者空闲时 | ❌ 否 |
| `Elicitation` | 需要用户输入时 | ❌ 否 |
| `ElicitationResult` | 用户输入结果 | ❌ 否 |

### 文件事件

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `CwdChanged` | 工作目录变更 | ❌ 否 |
| `FileChanged` | 文件内容变更 | ❌ 否 |

### Worktree

| 事件 | 触发时机 | 可阻止操作 |
|------|----------|------------|
| `WorktreeCreate` | Worktree 创建时 | ❌ 否 |

## Hook 来源

Hooks 可以来自不同位置：

| 来源 | 位置 | 作用域 |
|------|------|--------|
| `userSettings` | `~/.claude/settings.json` | 所有项目 |
| `projectSettings` | `.claude/settings.json` | 当前项目 |
| `localSettings` | `.claude/settings.local.json` | 当前项目（本地） |
| `pluginHook` | 插件目录 | 插件范围 |
| `sessionHook` | 运行时注册 | 当前会话 |
| `builtinHook` | 内置 | 始终生效 |

## HookCommand 类型

Hook 有多种执行方式：

### command：执行 shell 命令

```json
{
  'type': 'command',
  'command': 'notify-send 'Claude Code' 'Task completed''
}
```

### prompt：注入提示内容

```json
{
  'type': 'prompt',
  'prompt': 'Remember to check for security issues before executing.'
}
```

### agent：启动子 Agent

```json
{
  'type': 'agent',
  'prompt': 'Analyze the command for security risks'
}
```

### http：发送 HTTP 请求

```json
{
  'type': 'http',
  'url': 'https://api.example.com/hooks/notify'
}
```

### callback：内部回调（高级）

```typescript
{
  'type': 'callback',
  'callback': async (input) => { ... }
}
```

### function：内部函数（高级）

```typescript
{
  'type': 'function',
  'timeout': 30
}
```

## 配置格式

Hooks 在 `settings.json` 中配置：

```json
{
  'hooks': {
    'PreToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': 'echo 'Bash command about to execute''
          }
        ]
      }
    ],
    'PostToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': 'notify-send 'Claude Code' 'Bash completed''
          }
        ]
      }
    ],
    'SessionStart': [
      {
        'hooks': [
          {
            'type': 'prompt',
            'prompt': 'You are working in a TypeScript project. Follow team conventions.'
          }
        ]
      }
    ]
  }
}
```

### matcher 属性

`matcher` 指定 Hook 适用的工具：

```json
{
  'matcher': 'Bash',           // 仅 Bash 工具
  'matcher': 'Read|Write',     // Read 或 Write
  'matcher': 'Bash(git *)',    // Bash + git 命令
  'matcher': '*',              // 所有工具
}
```

**工具匹配语法**：
- `Bash`：工具名精确匹配
- `Bash(git *)`：工具名 + 输入匹配
- `Bash|Edit`：多个工具
- 无 matcher：所有触发

### if 条件

Hook 可以有条件执行：

```json
{
  'type': 'command',
  'command': 'echo 'Dangerous command'',
  'if': 'Bash(rm *)'
}
```

`if` 与 `matcher` 类似，但作为 Hook 的额外条件。

### timeout 属性

设置 Hook 执行超时（秒）：

```json
{
  'type': 'command',
  'command': 'long-running-script.sh',
  'timeout': 60
}
```

默认超时 60 秒。

## 简单 Hook 示例

### 1. SessionStart：初始化提示

```json
{
  'hooks': {
    'SessionStart': [
      {
        'hooks': [
          {
            'type': 'prompt',
            'prompt': 'This is a React project using TypeScript. Use functional components and hooks.'
          }
        ]
      }
    ]
  }
}
```

每次会话开始，自动注入项目约定。

### 2. PostToolUse：桌面通知

```json
{
  'hooks': {
    'PostToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': 'notify-send 'Claude Code' 'Command executed: $TOOL_INPUT''
          }
        ]
      }
    ]
  }
}
```

Bash 命令执行后发送桌面通知。

### 3. PreCompact：保存关键信息

```json
{
  'hooks': {
    'PreCompact': [
      {
        'hooks': [
          {
            'type': 'command',
            'command': 'echo 'Remember: user authentication uses JWT''
          }
        ]
      }
    ]
  }
}
```

压缩前提醒保留关键信息。

## Hook 输入与输出

Hook 执行时，接收 JSON 输入（通过 stdin）：

```json
{
  'hook_event_name': 'PreToolUse',
  'tool_name': 'Bash',
  'tool_input': {
    'command': 'rm -rf node_modules'
  },
  'session_id': 'abc-123'
}
```

Hook 输出也是 JSON：

```json
{
  'continue': true,
  'suppressOutput': false,
  'decision': 'approve',
  'reason': 'Command is safe'
}
```

### 关键输出字段

| 字段 | 说明 |
|------|------|
| `continue` | 是否继续执行（默认 true） |
| `suppressOutput` | 是否隐藏 stdout（默认 false） |
| `decision` | `approve` 或 `block`（PreToolUse） |
| `reason` | 决策原因 |
| `stopReason` | `continue: false` 时显示的消息 |

## 阻止操作示例

PreToolUse Hook 可以阻止危险操作：

```bash
#!/bin/bash
# safety-check.sh

read input
command=$(echo '$input' | jq -r '.tool_input.command')

if [[ '$command' == *'rm -rf'* ]]; then
  echo '{'continue': false, 'stopReason': 'Dangerous rm -rf command blocked'}'
else
  echo '{'continue': true}'
fi
```

配置：

```json
{
  'hooks': {
    'PreToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': '~/.claude/hooks/safety-check.sh'
          }
        ]
      }
    ]
  }
}
```

## 下一步

下一篇将深入 Hooks 实战：
- PreToolUse 验证 Hook
- PostToolUse 通知 Hook
- stdin/stdout 详细交互

---

## 本篇要点

1. **24 种 Hook 事件**：工具、会话、权限、任务、协作、文件
2. **6 种 HookCommand**：command、prompt、agent、http、callback、function
3. **配置位置**：`settings.json` 的 `hooks` 字段
4. **matcher**：指定 Hook 适用的工具
5. **PreToolUse 可阻止操作**：返回 `continue: false`
