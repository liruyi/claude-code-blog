---
title: "Skills 基础：编写第一个自定义技能"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 2
readingTime: "12 min"
---

Skills 是 Claude Code 最简单的扩展方式。一个 Skill 就是一个 Markdown 文件，包含 frontmatter（元数据）和 content（提示内容）。

## Skill 文件格式

```markdown
---
name: my-skill
description: A brief description of what this skill does
allowedTools: [Read, Grep, Glob]
argumentHint: [optional description]
userInvocable: true
---

# Your prompt here

Instructions for Claude to follow...
```

Frontmatter 使用 YAML 格式，`---` 之间是元数据，之后是提示内容。

## 属性详解

### 必需属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `name` | string | Skill 名称，用于 `/skill-name` 调用 |
| `description` | string | 描述，显示在 Skill 列表中 |

### 可选属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `allowedTools` | string[] | 限制可用工具，如 `[Read, Grep, Glob]` |
| `argumentHint` | string | 参数提示，如 `[issue description]` |
| `userInvocable` | boolean | 是否用户可调用（默认 true） |
| `disableModelInvocation` | boolean | 禁止 AI 自动调用（默认 false） |
| `aliases` | string[] | 别名列表 |
| `searchHint` | string | 搜索提示 |
| `model` | string | 模型选择：`opus`、`sonnet`、`haiku` |
| `effort` | string | 投入程度：`low`、`medium`、`high` |

### 属性详解

**allowedTools**

限制 Skill 可使用的工具，减少 AI 的'越权'行为：

```yaml
allowedTools: [Read, Grep, Glob]
```

常用工具名：`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`

**argumentHint**

告诉用户 Skill 接受什么参数：

```yaml
argumentHint: [issue description]
```

用户调用时：`/my-skill the bug is in login flow`

**userInvocable**

控制用户是否可以 `/skill-name` 调用。设为 `false` 时，只有 AI 可以触发。

**disableModelInvocation**

禁止 AI 自动调用。设为 `true` 时，必须用户显式调用。

**model**

选择执行 Skill 时使用的模型：

```yaml
model: opus    # 最强，复杂任务
model: sonnet  # 平衡，大多数任务
model: haiku   # 最快，简单任务
```

## Skill 存放位置

Claude Code 会扫描以下目录发现 Skills：

| 位置 | 路径 | 作用域 |
|------|------|--------|
| 用户目录 | `~/.claude/skills/` | 所有项目可用 |
| 项目目录 | `.claude/skills/` | 当前项目可用 |

Skill 文件命名不限，但通常用 `skill-name.md`。

## 发现机制

Claude Code 启动时：

1. 扫描用户目录和项目目录
2. 解析每个 `.md` 文件的 frontmatter
3. 提取 `name` 属性注册为 Skill
4. 按 `description` 显示在列表中

使用 `/skills` 命令查看已注册的 Skills。

## 第一个 Skill：/review

创建一个代码审查 Skill：

```markdown
---
name: review
description: Review the current code changes for quality and security
allowedTools: [Read, Grep, Glob, Bash]
argumentHint: [optional: specific files to review]
---

# Code Review Skill

Review the code for the following aspects:

## 1. Code Quality
- Readability and clarity
- Naming conventions
- Code structure and organization
- Duplicate code detection

## 2. Security
- Input validation
- SQL injection risks
- XSS vulnerabilities
- Authentication/authorization issues
- Sensitive data handling

## 3. Performance
- N+1 query patterns
- Unnecessary computations
- Memory leaks potential

## Instructions

1. If user specified files, review those files
2. Otherwise, run `git diff HEAD~1` to see recent changes
3. Analyze each change against the criteria above
4. Provide specific feedback with file:line references
5. Suggest concrete improvements

Format feedback as:
- **Issue**: Description
- **Location**: file:line
- **Severity**: Low/Medium/High
- **Suggestion**: How to fix
```

保存到 `~/.claude/skills/review.md`。

使用：
```
/review
/review src/auth.ts src/api.ts
```

## 内置 Skills 参考

Claude Code 内置 15+ Skills（无需创建）：

| Skill | 描述 |
|-------|------|
| `/debug` | 调试当前会话，读取 debug log |
| `/claude-api` | Claude API 使用指南 |
| `/loop` | 循环执行任务（如 `/loop 5m /test`） |
| `/remember` | 记住信息到 memory 系统 |
| `/simplify` | 简化代码，提高可读性 |
| `/verify` | 验证工作完成 |
| `/stuck` | 处理卡住的情况 |
| `/update-config` | 配置 settings.json |
| `/skillify` | 把当前对话转换为 Skill |
| `/batch` | 批量执行任务 |

查看完整列表：`/skills`

## 调试 Skill

如果 Skill 不生效：

1. **检查 frontmatter 格式**：必须是 YAML，`---` 包围
2. **检查 name**：不能有空格或特殊字符
3. **检查位置**：文件必须在正确目录
4. **检查注册**：运行 `/skills` 看是否出现在列表

使用 `/debug` Skill 查看详细日志：

```
/debug Skill not loading
```

## Skill vs 直接提示

为什么不直接告诉 Claude 'Review my code'？

| 对比 | 直接提示 | Skill |
|------|----------|-------|
| 可复用 | 每次重写 | 一次定义，多次调用 |
| 团队共享 | 需要复制粘贴 | 放在项目目录，所有人可用 |
| 工具限制 | Claude 可用所有工具 | 限制为 `allowedTools` |
| 标准化 | 每次可能不同 | 固定流程 |

## 下一步

下一篇将深入 Skills 进阶：
- Fork vs Inline 模式
- `contextModifier` 修改上下文
- 模型选择策略
- `effort` 参数

---

## 本篇要点

1. Skill 是 Markdown 文件：frontmatter + content
2. 必需属性：`name`、`description`
3. 可选属性：`allowedTools`、`argumentHint`、`model`...
4. 存放位置：`~/.claude/skills/` 或 `.claude/skills/`
5. 调用方式：`/skill-name [arguments]`
