---
title: "深入 Claude Code CLI 源码：Skills 与 Memory 系统"
description: "文章内容摘要"
publishDate: 2024-04-28
order: 10
readingTime: "12 min"
---

今天我们来聊聊 Claude Code 的 Skills 和 Memory 系统。这是两个让我印象深刻的设计——它们让 AI 能够'记住'用户偏好，并且可以定义'工作流'。

## Skills：可扩展的行为系统

Skills 是什么？简单说，它是一段预定义的提示词，加上一些执行约束。当你调用 `/verify` 时，Claude 会按照 skill 中定义的提示词和行为约束来工作。

### Skill 的来源

| 来源 | 说明 |
|------|------|
| Bundled | 打包在 CLI 中的内置技能 |
| User | 用户定义技能（.claude/skills/） |
| Plugin | 插件提供的技能 |

### BundledSkillDefinition

内置技能的定义：

```typescript
type BundledSkillDefinition = {
  name: string              // Skill 名称
  description: string       // 描述
  prompt: string            // 提示词内容
  allowedTools?: string[]   // 允许的工具白名单
  autoSkipTools?: string[]  // 自动跳过确认的工具
  context?: 'fork' | 'inline'  // 执行上下文
  hooks?: SkillHooks        // 生命周期钩子
}
```

### 内置技能列表

`src/skills/bundled/` 目录有 17 个内置技能：

- `batch.ts` - 批量执行
- `claudeApi.ts` - Claude API 帮助
- `debug.ts` - 调试工作流
- `loop.ts` - 循环执行模式
- `remember.ts` - 记忆系统交互
- `skillify.ts` - 创建新 Skill
- `stuck.ts` - 问题解决
- `commit.ts` - Git 提交辅助
- `review-pr.ts` - PR 审查
- ...

### 用户技能文件

用户可以在 `.claude/skills/` 目录创建技能文件。简单格式：

```markdown
---
name: my-skill
description: My custom skill
allowedTools: [Bash, Read, Write]
---

Skill prompt content here...
```

复杂格式可以定义 hooks：

```markdown
---
name: deploy
context: fork
hooks:
  PreToolUse:
    - event: Bash
      command: ./scripts/pre-tool.sh
---

Deployment instructions...
```

## Fork vs Inline 模式

这是一个关键概念：

**Inline 模式**：
- Skill 内容扩展到当前对话
- 共享完整上下文
- 使用主对话的 token 预算

**Fork 模式**：
- 在子代理中独立执行
- 有自己的上下文和 token 预算
- 可以使用不同的 agent 类型

什么时候用 Fork？当 skill 任务复杂、需要独立思考、可能会消耗大量 token 时。比如 `/review-pr` 审查整个 PR，用 Fork 模式更合适。

## Memory：跨会话的记忆

Memory 系统是我最喜欢的功能。它让 Claude 能够跨会话记住关键信息。

### 四种 Memory 类型

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识 | '用户是资深后端工程师' |
| `feedback` | 工作方式指导 | '不要用 mock 测试数据库' |
| `project` | 项目进展、目标、约束 | '周三后禁止合并' |
| `reference` | 外部系统指针 | 'bug 在 Linear 项目 INGEST' |

### Memory 文件格式

每个 memory 文件使用 frontmatter：

```markdown
---
name: user_role
description: User's role
type: user
---

User is a senior backend engineer.
Focus: API design, microservices
**Why:** User mentioned during first session
**How to apply:** Tailor explanations to senior-level understanding
```

结构要求：首先是规则/事实，然后 `**Why:**` 说明原因，最后 `**How to apply:**` 说明应用方式。

### 不应该保存的内容

系统明确告诉 AI 不要保存这些：

- 代码模式、架构（可以从代码推导）
- Git 历史（git log 是权威来源）
- 调试方案（代码已包含）
- CLAUDE.md 已记录的内容
- 临时任务细节

### Memory 路径优先级

```typescript
function getAutoMemPath(): string | null {
  if (process.env.CLAUDE_CODE_AUTO_MEM_PATH_OVERRIDE) return override
  if (projectSettings.autoMemPath) return projectSettings
  return `${cwd}/.claude/projects/${projectHash}/memory/`
}
```

最终存储在项目的 `.claude/projects/{hash}/memory/` 目录下。

### 截断限制

Memory 文件有大小限制：

```typescript
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25000
```

超过限制会截断，避免消耗过多 token。

## Skill Hooks

Skills 可以注册生命周期钩子：

```typescript
type SkillHooks = {
  PromptSubmit?: SkillHookDefinition
  ToolCall?: SkillHookDefinition
  ToolResult?: SkillHookDefinition
  PostToolUse?: SkillHookDefinition
  SessionEnd?: SkillHookDefinition
}
```

| Hook | 触发时机 |
|------|----------|
| `PromptSubmit` | 用户提交提示后 |
| `ToolCall` | 工具调用前 |
| `ToolResult` | 工具结果返回后 |
| `SessionEnd` | 会话结束时 |

这些 hooks 在 skill 执行期间注册，skill 结束时注销。

## Token 估算

系统会估算 skill 的 token 消耗：

```typescript
function estimateSkillFrontmatterTokens(frontmatter): number {
  let tokens = 0
  if (frontmatter.name) tokens += name.length / 4  // ~4 chars/token
  if (frontmatter.allowedTools) tokens += length * 2  // 每工具 ~2 tokens
  return Math.ceil(tokens)
}
```

这用于 token 预算管理，避免加载太多 skills 超出限制。

## Memory 自动保存触发

系统会在以下情况自动保存 memory：

1. 用户明确请求：'remember this'
2. 检测到用户偏好：纠正行为或确认非显而易见选择
3. 项目重要信息：截止日期、决策、约束
4. 外部系统指针：仪表盘、跟踪系统

## /remember Skill

内置的 `/remember` skill 提供 memory 交互：

```
/remember            # 列出已有 memory
/remember user ...   # 保存 user 类型 memory
/remember feedback ...  # 保存 feedback 类型
/forget name         # 删除 memory
```

## 总结

Skills 和 Memory 系统展示了 Claude Code 的扩展性设计：

1. **Skills**：
   - 三种来源：Bundled/User/Plugin
   - Fork/Inline 两种执行模式
   - YAML frontmatter 定义元数据
   - Hooks 注册生命周期钩子

2. **Memory**：
   - 四种类型：user/feedback/project/reference
   - 明确的'不应保存'边界
   - 结构化的 Why/How to apply 格式
   - 截断限制控制 token 消耗

下一篇我会分享 Hooks 系统的详细分析，看看 Claude Code 如何实现生命周期事件注入。
