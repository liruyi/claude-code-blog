---
title: "Skills 进阶：Fork 模式与上下文控制"
description: "Deploy the application following these steps..."
publishDate: 2024-05-16
order: 3
readingTime: "14 min"
---

上一篇介绍了 Skills 的基础用法。本篇深入高级特性，让你的 Skill 更强大、更灵活。

## Fork vs Inline 模式

Skill 有两种执行模式：

### Inline 模式（默认）

Skill 内容**注入当前对话**，共享上下文：

```
用户: /review src/auth.ts
     │
     ▼
Skill 内容注入当前对话
     │
     ▼
Claude 在当前对话中执行
     │
     ▼
结果直接显示
```

**特点**：
- 共享对话历史
- 共享 token 预算
- 工具输出进入当前上下文
- 用户可以中途干预

### Fork 模式

Skill **启动独立子 Agent**，隔离执行：

```
用户: /research 'find all API endpoints'
     │
     ▼
启动子 Agent（独立上下文）
     │
     ├─► 主对话继续（可以聊天）
     │
     └─► 子 Agent 执行完毕后通知
```

**特点**：
- 独立对话历史
- 独立 token 预算
- 工具输出不污染主上下文
- 用户可以继续其他对话

### 如何选择？

| 场景 | 推荐模式 |
|------|----------|
| 简单操作（commit、review） | Inline |
| 复杂研究（大量搜索、多文件） | Fork |
| 不需要中途干预 | Fork |
| 需要与用户交互 | Inline |
| 工具输出很多（Grep、Read） | Fork |

### 配置 Fork 模式

在 frontmatter 中设置：

```yaml
---
name: research
description: Research a topic in the codebase
context: fork
agent: Explore
---

# Research Skill

Explore the codebase to find information about...
```

**`context`**: `fork` 启用 Fork 模式，默认 `inline`

**`agent`**: Fork 时使用的 Agent 类型：
- `Explore`：快速探索（适合研究）
- `Plan`：规划实现（适合设计）
- `general-purpose`：通用任务

## model 属性：选择执行模型

为 Skill 指定专用模型：

```yaml
---
name: quick-fix
description: Fix simple bugs quickly
model: haiku
---

# Quick Fix

Fix the bug described in the argument...
```

**可选值**：
- `opus`：最强，复杂推理
- `sonnet`：平衡，大多数任务
- `haiku`：最快，简单任务

**场景示例**：

| Skill 类型 | 推荐模型 |
|------------|----------|
| 代码审查（复杂） | `opus` |
| 常规操作（commit） | `sonnet` |
| 快速搜索（Grep） | `haiku` |
| 规划实现（Plan） | `opus` |

## effort 属性：控制投入程度

`effort` 决定 AI 的'思考深度'：

```yaml
---
name: deep-analysis
description: Deep analysis of complex issues
effort: high
---

# Deep Analysis

Analyze the issue thoroughly...
```

**可选值**：
- `low`：快速、直接，最小开销
- `medium`：平衡，标准实现
- `high`：全面，大量测试和文档
- `max`：极致推理（仅 Opus 4.6 支持）

**官方描述**：

| Level | 描述 |
|-------|------|
| `low` | Quick, straightforward implementation with minimal overhead |
| `medium` | Balanced approach with standard implementation and testing |
| `high` | Comprehensive implementation with extensive testing and documentation |
| `max` | Maximum capability with deepest reasoning (Opus 4.6 only) |

**注意**：
- `max` 仅在 Opus 4.6 模型上可用
- 其他模型使用 `max` 会被降级为 `high`

## hooks 属性：Skill 内置钩子

Skill 可以定义自己的 Hooks：

```yaml
---
name: deploy
description: Deploy to production
allowedTools: [Bash]
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'echo 'Checking deployment safety...''
---

# Deploy Skill

Deploy the application following these steps...
```

Hook 在 Skill 执行期间生效，Skill 结束后失效。

## files 属性：附带参考文件

内置 Skill 可以附带参考文件，供 AI 查阅：

```typescript
registerBundledSkill({
  name: 'claude-api',
  description: 'Build apps with Claude API',
  files: {
    'examples/chat.ts': '// Example chat implementation...',
    'examples/stream.ts': '// Example streaming...',
  },
  getPromptForCommand: async (args) => [...]
})
```

用户 Skill 不支持 `files`，但可以用另一种方式：在 prompt 中引用外部文件：

```markdown
---
name: api-guide
---

# API Guide

Reference the API documentation in this project:
- Read docs/api.md for general guide
- Read docs/examples.md for code examples
```

## 完整示例：Fork 模式研究 Skill

```markdown
---
name: investigate
description: Investigate a bug or issue thoroughly
context: fork
agent: Explore
model: sonnet
effort: medium
allowedTools: [Read, Grep, Glob, WebSearch]
argumentHint: [bug description or issue]
---

# Investigation Skill

Investigate the described issue systematically.

## Steps

1. **Understand the Issue**: Parse the user's description to identify:
   - Error messages or symptoms
   - Affected components or files
   - When it occurs (trigger conditions)

2. **Search Evidence**:
   - Grep for error messages in logs
   - Grep for related function names
   - Glob to find potentially affected files

3. **Analyze Code**:
   - Read relevant files
   - Trace the execution path
   - Identify potential root causes

4. **Web Research** (if needed):
   - Search for similar issues online
   - Check framework/library documentation

5. **Report Findings**:
   - Summarize root cause
   - List evidence with file:line references
   - Suggest potential fixes

## Output Format

Provide a structured report:
- **Summary**: One paragraph overview
- **Root Cause**: Most likely explanation
- **Evidence**: List of findings
- **Recommendations**: Suggested fixes
```

使用：
```
/investigate login fails with 500 error after deploy
```

Fork 模式下，主对话可以继续，研究完成后收到通知。

## 最佳实践

### 1. Fork 用于隔离大量输出

```
// ❌ Inline：大量 Grep 输出污染主上下文
用户: /search 'function.*auth'
     │
     ▼
主对话充满 500 行 grep 结果

// ✅ Fork：输出隔离
用户: /search 'function.*auth'
     │
     ├─► 主对话继续聊天
     │
     └─► 子 Agent 完成后返回摘要
```

### 2. 模型选择考虑成本

- 简单任务用 `haiku` 节省成本
- 复杂任务用 `opus` 保证质量
- 大多数任务用 `sonnet`

### 3. effort 与任务复杂度匹配

| 任务类型 | effort |
|----------|--------|
| 快速修复 | `low` |
| 标准功能 | `medium` |
| 关键模块 | `high` |
| 极难问题 | `max` (Opus 4.6) |

### 4. allowedTools 防止'越权'

```yaml
# 只允许读取，不允许修改
allowedTools: [Read, Grep, Glob]

# 只允许 Bash，限制危险操作
allowedTools: [Bash]
```

## 下一步

下一篇将介绍 Hooks 入门：
- 24 种 Hook 事件
- 配置格式
- 简单 Hook 示例

---

## 本篇要点

1. `context: fork` 启动独立子 Agent
2. `agent` 指定 Fork 时的 Agent 类型
3. `model` 选择执行模型（opus/sonnet/haiku）
4. `effort` 控制思考深度（low/medium/high/max）
5. `hooks` 为 Skill 定义内置钩子
6. Fork 模式适合大量输出、不需要中途干预的任务
