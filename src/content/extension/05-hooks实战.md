---
title: "不影响 Claude 行为"
description: "echo '{'continue': true}'"
publishDate: 2024-05-16
order: 5
readingTime: "19 min"
---

上一篇介绍了 Hooks 的配置格式。本篇通过实际案例，深入 Hook 的实战用法。

## PreToolUse：验证 Hook

PreToolUse 在工具执行前触发，可以**阻止操作**。这是最重要的安全 Hook。

### 案例：阻止危险 Bash 命令

创建验证脚本 `~/.claude/hooks/bash-validator.sh`：

```bash
#!/bin/bash

# 读取 Hook 输入
input=$(cat)

# 提取命令
command=$(echo '$input' | jq -r '.tool_input.command // empty')

# 危险命令列表
dangerous_patterns=(
  'rm -rf /'
  'rm -rf *'
  ':(){ :|:& };:'
  'mkfs'
  'dd if='
  '> /dev/sda'
  'curl | bash'
  'wget | sh'
)

# 检查危险模式
for pattern in '${dangerous_patterns[@]}'; do
  if [[ '$command' == *'$pattern'* ]]; then
    # 阻止执行
    jq -n \
      --arg reason 'Blocked dangerous command matching: $pattern' \
      '{continue: false, decision: 'block', reason: $reason}'
    exit 0
  fi
done

# 允许执行
echo '{'continue': true}'
```

配置 `settings.json`：

```json
{
  'hooks': {
    'PreToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          {
            'type': 'command',
            'command': '~/.claude/hooks/bash-validator.sh'
          }
        ]
      }
    ]
  }
}
```

**效果**：当 Claude 尝试执行 `rm -rf *` 时，Hook 检测到危险模式，返回 `block`，命令被阻止。

### 案例：强制 Git 操作审查

只允许安全的 Git 操作：

```bash
#!/bin/bash
# git-validator.sh

input=$(cat)
command=$(echo '$input' | jq -r '.tool_input.command // empty')

# 禁止强制推送到 main/master
if [[ '$command' =~ 'git push --force' ]] && [[ '$command' =~ 'main|master' ]]; then
  jq -n --arg reason 'Force push to main/master is forbidden' \
    '{continue: false, decision: 'block', reason: $reason}'
  exit 0
fi

# 禁止删除远程分支
if [[ '$command' =~ 'git push --delete' ]]; then
  jq -n --arg reason 'Deleting remote branches requires approval' \
    '{continue: false, decision: 'block', reason: $reason}'
  exit 0
fi

echo '{'continue': true}'
```

### PreToolUse 输出详解

PreToolUse Hook 可以返回以下字段：

```json
{
  'continue': false,              // 必需：阻止执行
  'decision': 'block',            // 明确拒绝
  'reason': 'Dangerous command',  // 原因（显示给用户）
  'stopReason': 'Blocked by security hook', // 自定义停止消息
  'permissionDecision': 'deny',   // 权限决策
  'additionalContext': '...'      // 添加上下文
}
```

**关键字段**：
- `continue: false`：阻止工具执行
- `decision: block`：明确拒绝
- `reason`：显示在权限对话框中

## PostToolUse：通知 Hook

PostToolUse 在工具执行后触发，用于**记录、通知、后续处理**。

### 案例：Slack 通知

创建通知脚本：

```bash
#!/bin/bash
# slack-notify.sh

input=$(cat)
tool_name=$(echo '$input' | jq -r '.tool_name')
tool_input=$(echo '$input' | jq -r '.tool_input')
tool_output=$(echo '$input' | jq -r '.tool_output // 'completed'')

# 发送 Slack Webhook
curl -s -X POST '$SLACK_WEBHOOK_URL' \
  -H 'Content-type: application/json' \
  -d '$(jq -n \
    --arg tool '$tool_name' \
    --arg input '$tool_input' \
    --arg output '$tool_output' \
    '{text: 'Claude Code executed \($tool)', attachments: [{color: 'good', fields: [{title: 'Input', value: $input, short: false}, {title: 'Output', value: $output, short: false}]}]}')'

# 不影响 Claude 行为
echo '{'continue': true}'
```

配置：

```json
{
  'hooks': {
    'PostToolUse': [
      {
        'matcher': 'Bash|Write|Edit',
        'hooks': [
          {
            'type': 'command',
            'command': '~/.claude/hooks/slack-notify.sh'
          }
        ]
      }
    ]
  }
}
```

**效果**：每次执行 Bash/Write/Edit 后，发送 Slack 通知。

### 案例：记录操作日志

```bash
#!/bin/bash
# audit-log.sh

input=$(cat)
timestamp=$(date -Iseconds)
session_id=$(echo '$input' | jq -r '.session_id')
tool_name=$(echo '$input' | jq -r '.tool_name')
tool_input=$(echo '$input' | jq -c '.tool_input')

# 写入审计日志
echo '$timestamp | $session_id | $tool_name | $tool_input' \
  >> ~/.claude/audit.log

echo '{'continue': true}'
```

## SessionStart：初始化 Hook

SessionStart 在会话开始时触发，用于**注入上下文、初始化环境**。

### 案例：项目约定注入

```json
{
  'hooks': {
    'SessionStart': [
      {
        'hooks': [
          {
            'type': 'prompt',
            'prompt': '# Project Conventions\n\n- Use TypeScript strict mode\n- Prefer functional components with hooks\n- Follow Airbnb style guide\n- Test with Jest\n- Document with JSDoc'
          }
        ]
      }
    ]
  }
}
```

**效果**：每次会话开始，Claude 自动了解项目约定。

### 案例：加载环境变量

```bash
#!/bin/bash
# load-env.sh

# 读取项目环境变量
if [ -f .env.local ]; then
  # 注入环境变量提示
  env_vars=$(grep -v '^#' .env.local | cut -d= -f1)
  jq -n --arg vars '$env_vars' \
    '{continue: true, additionalContext: 'Available environment variables: ' + $vars}'
else
  echo '{'continue': true}'
fi
```

配置：

```json
{
  'hooks': {
    'SessionStart': [
      {
        'hooks': [
          {
            'type': 'command',
            'command': '~/.claude/hooks/load-env.sh'
          }
        ]
      }
    ]
  }
}
```

### SessionStart 输出

SessionStart Hook 可以返回：

```json
{
  'continue': true,
  'additionalContext': '...',    // 添加上下文到系统提示
  'initialUserMessage': '...',   // 替代用户的初始消息
  'watchPaths': ['...']          // 监听的文件路径（FileChanged）
}
```

**`watchPaths`**：设置后，当这些文件变化时触发 `FileChanged` Hook。

## stdin/stdout 交互详解

Hook 通过 stdin 接收 JSON 输入：

### 输入结构

```json
{
  'hook_event_name': 'PreToolUse',
  'session_id': 'abc-123',
  'tool_name': 'Bash',
  'tool_use_id': 'tool-456',
  'tool_input': {
    'command': 'git status'
  },
  'cwd': '/path/to/project'
}
```

**字段说明**：

| 字段 | 说明 |
|------|------|
| `hook_event_name` | Hook 事件类型 |
| `session_id` | 会话 ID |
| `tool_name` | 工具名（PreToolUse/PostToolUse） |
| `tool_use_id` | 工具调用 ID |
| `tool_input` | 工具输入参数 |
| `cwd` | 当前工作目录 |

### 输出结构

```json
{
  'continue': true,
  'suppressOutput': false,
  'additionalContext': '...',
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'allow',
    'updatedInput': { ... }
  }
}
```

**`hookSpecificOutput`**：事件特定的输出字段。

### PreToolUse 特定字段

```json
{
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'allow',     // 或 deny
    'permissionDecisionReason': '...',
    'updatedInput': {                  // 修改工具输入
      'command': 'safe-command'
    },
    'additionalContext': '...'
  }
}
```

**`updatedInput`**：可以修改工具的输入！例如，把危险命令替换为安全版本。

### PostToolUse 特定字段

```json
{
  'hookSpecificOutput': {
    'hookEventName': 'PostToolUse',
    'updatedMCPToolOutput': { ... },  // 修改 MCP 工具输出
    'additionalContext': '...'
  }
}
```

## 实战：修改工具输入

高级用法：PreToolUse Hook 可以**修改工具输入**。

```bash
#!/bin/bash
# sanitize-path.sh

input=$(cat)
command=$(echo '$input' | jq -r '.tool_input.command')

# 如果包含未转义的路径，添加引号
if [[ '$command' =~ 'path with spaces' ]]; then
  safe_command=$(echo '$command' | sed 's/path with spaces/'path with spaces'/')

  jq -n \
    --arg cmd '$safe_command' \
    '{continue: true, hookSpecificOutput: {hookEventName: 'PreToolUse', updatedInput: {command: $cmd}}}'
else
  echo '{'continue': true}'
fi
```

**效果**：自动修复路径参数，避免 Bash 命令失败。

## 多 Hook 协同

同一事件可以有多个 Hook，按顺序执行：

```json
{
  'hooks': {
    'PreToolUse': [
      {
        'matcher': 'Bash',
        'hooks': [
          { 'type': 'command', 'command': 'audit-logger.sh' },
          { 'type': 'command', 'command': 'safety-check.sh' }
        ]
      }
    ]
  }
}
```

**执行顺序**：
1. `audit-logger.sh` 执行，返回 `continue: true`
2. `safety-check.sh` 执行，可能返回 `block`
3. 任一 Hook 返回 `continue: false`，后续 Hook 不执行

## 下一步

下一篇将介绍 MCP 协议基础：
- MCP 是什么？
- 7 种传输类型
- 配置格式

---

## 本篇要点

1. **PreToolUse 验证**：返回 `block` 阻止危险操作
2. **PostToolUse 通知**：发送 Slack、记录审计日志
3. **SessionStart 初始化**：注入项目约定、加载环境
4. **stdin/stdout JSON**：Hook 通过 JSON 交互
5. **updatedInput**：PreToolUse 可修改工具输入
6. **多 Hook 协同**：按顺序执行，任一阻止则停止
