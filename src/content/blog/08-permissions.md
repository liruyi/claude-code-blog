---
title: "深入 Claude Code CLI 源码：权限系统的安全设计"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 8
readingTime: "12 min"
---

今天我们来聊聊 Claude Code 的权限系统。这是一个多层防御的设计，确保工具执行的安全可控。

## 权限模式概览

Claude Code 定义了多种权限模式：

| 模式 | 工具调用 | 文件操作 | Bash 命令 |
|------|----------|----------|-----------|
| `default` | Ask | Ask | Ask |
| `plan` | Read-only | Ask | Ask (只读) |
| `acceptEdits` | Allow edits | Allow | Ask |
| `bypassPermissions` | Allow all | Allow | Allow |
| `auto` | Classifier | Classifier | Classifier |

`plan` 模式特别有趣——它只允许读取操作，适合规划阶段使用，不会意外修改代码。

`auto` 模式使用 AI 分类器自动决定是否允许操作，这需要 `TRANSCRIPT_CLASSIFIER` feature flag 启用。

## PermissionResult 类型

权限检查的结果是一个复杂类型：

```typescript
type PermissionResult =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision
  | { behavior: 'passthrough'; message: string }
```

`passthrough` 是一个特殊状态，表示'无匹配规则，继续检查下一层'。

### Allow 决策

```typescript
type PermissionAllowDecision = {
  behavior: 'allow'
  updatedInput?: Input       // 用户修改后的输入
  userModified?: boolean     // 用户是否修改
  decisionReason?: PermissionDecisionReason
}
```

`updatedInput` 允许用户在允许前修改工具输入，这是一个安全增强功能。

### Ask 决策

```typescript
type PermissionAskDecision = {
  behavior: 'ask'
  message: string            // 提示消息
  suggestions?: PermissionUpdate[]  // 建议的规则更新
}
```

`suggestions` 会建议用户创建新规则，避免下次再询问相同操作。

## 权限规则系统

规则使用简洁的语法：

```json
{
  'alwaysAllow': [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Read(*)',
    'Edit(*)'
  ],
  'alwaysDeny': [
    'Bash(rm -rf:*)',
    'Write(*.env)'
  ]
}
```

规则语法解析：
- `Bash` - 匹配所有 Bash 调用
- `Bash(git status:*)` - 匹配 git status 及其参数
- `Read(*)` - 匹配所有 Read 调用
- `pattern:*` - 后缀通配符

## 规则来源与优先级

规则来自多个来源，有明确的优先级：

```typescript
type PermissionRuleSource =
  | 'userSettings'     // ~/.claude/settings.json
  | 'projectSettings'  // .claude/settings.json
  | 'localSettings'    // .claude/settings.local.json
  | 'policySettings'   // MDM/Policy 设置
  | 'cliArg'           // CLI 参数
  | 'command'          // 命令临时
  | 'session'          // 会话临时
```

检查顺序：deny 规则优先于 allow 规则，确保安全。

```typescript
function checkPermissionRules(toolName, input, context) {
  // 1. 先检查 deny（安全优先）
  for (const rule of denyRules) {
    if (matchesRule(toolName, input, rule)) {
      return { behavior: 'deny', message: `Denied by rule: ${rule}` }
    }
  }

  // 2. 再检查 allow
  for (const rule of allowRules) {
    if (matchesRule(toolName, input, rule)) {
      return { behavior: 'allow', decisionReason: { type: 'rule', rule } }
    }
  }

  // 3. 检查 ask 规则
  // 4. 无匹配则 passthrough
}
```

## 检查流程

完整的权限检查流程：

```typescript
async function toolHasPermission(tool, input, context) {
  // 1. Bypass 模式直接允许
  if (context.toolPermissionContext.mode === 'bypassPermissions') {
    return { behavior: 'allow' }
  }

  // 2. 检查规则
  const ruleResult = checkPermissionRules(toolName, input, context)
  if (ruleResult.behavior !== 'passthrough') return ruleResult

  // 3. 检查模式
  const modeResult = checkPermissionMode(toolName, input, context)
  if (modeResult.behavior !== 'passthrough') return modeResult

  // 4. 检查工作目录
  const workingDirResult = checkWorkingDirectory(toolName, input, context)
  if (workingDirResult.behavior !== 'passthrough') return workingDirResult

  // 5. 检查安全模式
  const safetyResult = checkSafetyPatterns(toolName, input, context)
  if (safetyResult.behavior !== 'passthrough') return safetyResult

  // 6. 默认 ask
  return { behavior: 'ask', message: `Permission required for ${toolName}` }
}
```

这是一个层层把关的设计，每层都可以决定结果，只有全部 passthrough 才会最终询问用户。

## YoloClassifier：Auto 模式的 AI 决策

Auto 模式使用 YoloClassifier 来自动决定权限：

```typescript
type YoloClassifierDecision = {
  action: 'allow' | 'deny'
  reason: string
  classifier: string
}
```

分类器会分析工具名称、输入内容、上下文来做出决策。它会检测危险模式：

```typescript
const DANGEROUS_PATTERNS = [
  'rm -rf',
  'sudo',
  'chmod 777',
  'curl | bash',
  // ...
]
```

遇到这些模式会自动 deny，无需询问用户。

## 沙盒执行

对于 Bash 命令，Claude Code 实现了沙盒执行：

```typescript
const sandboxOptions = {
  excludeCommands: ['git', 'npm', 'node'],  // 不沙盒这些
  dangerouslyDisableSandbox: false,         // 禁用沙盒开关
  networkPolicy: 'restricted',              // 网络策略
}
```

沙盒限制：
- 文件系统访问限制
- 网络访问限制
- 子进程限制

## 拒绝追踪

系统会追踪权限拒绝，用于分析和优化：

```typescript
type DenialTrackingState = {
  recentDenials: Array<{
    toolName: string
    input: unknown
    reason: string
    timestamp: number
  }>
  denialPatterns: Map<string, number>  // 拒绝计数
}
```

这些数据可以帮助识别常见的拒绝模式，建议用户添加相应规则。

## 总结

Claude Code 的权限系统展示了多层安全设计：

1. **多种模式**：default/plan/acceptEdits/bypassPermissions/auto
2. **规则系统**：简洁语法，deny 优先于 allow
3. **多层检查**：规则→模式→工作目录→安全模式→默认询问
4. **AI 分类器**：Auto 模式自动决策
5. **沙盒执行**：限制危险命令
6. **拒绝追踪**：分析和优化

下一篇我会分享 Bridge/Remote Control 系统，看看 Claude Code 如何实现远程执行能力。
