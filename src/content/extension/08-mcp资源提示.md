---
title: "MCP 资源与提示：完整的 MCP 能力"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 8
readingTime: "25 min"
---

上一篇介绍了 MCP Server 的工具开发。本篇深入 MCP 的另外两个核心能力：Resources（资源）和 Prompts（提示）。

## MCP 三大能力

MCP Server 可以提供：

| 能力 | 说明 | 用途 |
|------|------|------|
| **Tools** | 可调用的操作 | 执行动作、修改数据 |
| **Resources** | 可读取的资源 | 提供文档、数据、配置 |
| **Prompts** | 预定义的提示 | 标准化交互模板 |

## Resources：可读取资源

Resources 是 Server 提供的**静态或动态数据**，Claude 可以主动读取。

### Resource 类型

1. **静态资源**：固定内容（如文档、配置）
2. **动态资源**：实时生成（如数据库查询结果）
3. **订阅资源**：内容变化时通知更新

### 实现 Resources

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({
  name: 'resource-server',
  version: '1.0.0',
})

// 列出可用资源
server.resources(
  async () => {
    return {
      resources: [
        {
          uri: 'config://app',
          name: 'App Configuration',
          description: 'Current application configuration',
          mimeType: 'application/json',
        },
        {
          uri: 'docs://readme',
          name: 'README',
          description: 'Project README file',
          mimeType: 'text/markdown',
        },
        {
          uri: 'db://users',
          name: 'User List',
          description: 'Active users from database',
          mimeType: 'application/json',
        },
      ]
    }
  }
)

// 读取资源内容
server.readResource(
  async (uri: string) => {
    if (uri === 'config://app') {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            version: '1.0.0',
            environment: 'production',
            features: ['auth', 'api', 'ui'],
          }),
        }],
      }
    }

    if (uri === 'docs://readme') {
      const readme = await fs.readFile('README.md', 'utf-8')
      return {
        contents: [{
          uri,
          mimeType: 'text/markdown',
          text: readme,
        }],
      }
    }

    if (uri === 'db://users') {
      // 动态查询数据库
      const users = await db.query('SELECT id, name FROM users WHERE active = true')
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(users),
        }],
      }
    }

    throw new Error(`Unknown resource: ${uri}`)
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main()
```

### Claude 如何使用 Resources

Claude 可以主动读取资源：

```
用户: 查看当前配置
     │
     ▼
Claude 决定读取 config://app
     │
     ▼
Server 返回配置内容
     │
     ▼
Claude 解释配置给用户
```

### 资源 URI 格式

URI 格式灵活，但建议遵循约定：

| 格式 | 示例 | 用途 |
|------|------|------|
| `scheme://path` | `file://docs/api.md` | 文件 |
| `db://table` | `db://users` | 数据库表 |
| `config://name` | `config://app` | 配置 |
| `http://url` | `http://api.example.com/data` | 远程数据 |

### 资源订阅

Server 可以支持资源变化通知：

```typescript
// 注册资源订阅
server.subscribeResource(
  async (uri: string) => {
    // 返回订阅 ID
    return { subscriptionId: `sub-${uri}` }
  }
)

// 当资源变化时，发送通知
server.sendResourceUpdate('config://app', {
  contents: [{
    uri: 'config://app',
    mimeType: 'application/json',
    text: JSON.stringify(newConfig),
  }],
})
```

## Prompts：预定义提示

Prompts 是 Server 提供的**交互模板**，用户或 Claude 可以调用。

### 实现 Prompts

```typescript
// 列出可用提示
server.prompts(
  async () => {
    return {
      prompts: [
        {
          name: 'code-review',
          description: 'Review code for quality and security',
          arguments: [
            {
              name: 'filename',
              description: 'File to review',
              required: true,
            },
            {
              name: 'focus',
              description: 'Focus area (security|performance|style)',
              required: false,
            },
          ],
        },
        {
          name: 'debug',
          description: 'Debug an issue with context',
          arguments: [
            {
              name: 'error',
              description: 'Error message or symptom',
              required: true,
            },
            {
              name: 'component',
              description: 'Affected component',
              required: false,
            },
          ],
        },
      ],
    }
  }
)

// 获取提示内容
server.getPrompt(
  async (name: string, args: Record<string, string>) => {
    if (name === 'code-review') {
      return {
        description: 'Review code for quality and security',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please review the file ${args.filename} for ${args.focus || 'quality and security'}.

Focus on:
- Code quality: readability, structure, naming
- Security: vulnerabilities, input validation
- Performance: inefficiencies, N+1 queries

Provide specific feedback with file:line references.`,
            },
          },
        ],
      }
    }

    if (name === 'debug') {
      return {
        description: 'Debug an issue with context',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Debug the following issue:

Error: ${args.error}
Component: ${args.component || 'unknown'}

Steps:
1. Analyze the error message
2. Search for related code
3. Identify root cause
4. Suggest fix`,
            },
          },
        ],
      }
    }

    throw new Error(`Unknown prompt: ${name}`)
  }
)
```

### 用户如何使用 Prompts

用户可以显式调用：

```
/mcp prompt code-review filename=src/auth.ts focus=security
```

或 Claude 根据上下文自动选择。

### Prompt 与 Skill 的区别

| 对比 | Skill | MCP Prompt |
|------|-------|------------|
| 定义位置 | Claude Code 本地 | MCP Server |
| 调用方式 | `/skill-name` | `/mcp prompt name args` |
| 共享范围 | 项目/用户 | Server 所有用户 |
| 动态性 | 静态 Markdown | 可动态生成 |
| 适用场景 | 团队内部 | 第三方服务 |

## 完整 MCP Server 示例

知识库 MCP Server，支持 Tools、Resources、Prompts：

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || './knowledge'

const server = new McpServer({
  name: 'knowledge-server',
  version: '1.0.0',
})

// === Tools ===

server.tool(
  'search',
  'Search the knowledge base',
  {
    query: z.string(),
    limit: z.number().optional().default(5),
  },
  async ({ query, limit }) => {
    const files = await fs.readdir(KNOWLEDGE_DIR)
    const results = []

    for (const file of files) {
      const content = await fs.readFile(path.join(KNOWLEDGE_DIR, file), 'utf-8')
      if (content.toLowerCase().includes(query.toLowerCase())) {
        results.push({ file, snippet: content.slice(0, 300) })
      }
      if (results.length >= limit) break
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results, null, 2),
      }],
    }
  }
)

server.tool(
  'create',
  'Create a new knowledge document',
  {
    filename: z.string(),
    content: z.string(),
  },
  async ({ filename, content }) => {
    await fs.writeFile(path.join(KNOWLEDGE_DIR, filename), content)
    return {
      content: [{ type: 'text', text: `Created ${filename}` }],
    }
  }
)

// === Resources ===

server.resources(
  async () => ({
    resources: [
      {
        uri: 'kb://list',
        name: 'Knowledge Base Index',
        mimeType: 'application/json',
      },
      {
        uri: 'kb://stats',
        name: 'Knowledge Base Statistics',
        mimeType: 'application/json',
      },
    ],
  })
)

server.readResource(
  async (uri: string) => {
    if (uri === 'kb://list') {
      const files = await fs.readdir(KNOWLEDGE_DIR)
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(files),
        }],
      }
    }

    if (uri === 'kb://stats') {
      const files = await fs.readdir(KNOWLEDGE_DIR)
      const stats = await Promise.all(
        files.map(async (f) => ({
          name: f,
          size: (await fs.stat(path.join(KNOWLEDGE_DIR, f))).size,
        }))
      )
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(stats),
        }],
      }
    }

    throw new Error(`Unknown resource: ${uri}`)
  }
)

// === Prompts ===

server.prompts(
  async () => ({
    prompts: [
      {
        name: 'ask',
        description: 'Ask a question about the knowledge base',
        arguments: [
          { name: 'topic', description: 'Topic to ask about', required: true },
        ],
      },
    ],
  })
)

server.getPrompt(
  async (name: string, args: Record<string, string>) => {
    if (name === 'ask') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Search the knowledge base for information about: ${args.topic}

Summarize the key points and provide references to specific documents.`,
            },
          },
        ],
      }
    }
    throw new Error(`Unknown prompt: ${name}`)
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main()
```

## Capabilities 声明

Server 需要声明支持的能力：

```typescript
const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},      // 支持工具
    resources: {},  // 支持资源
    prompts: {},    // 支持提示
  },
})
```

Claude Code 在初始化时会检查这些能力，只使用 Server 支持的功能。

## 下一步

下一篇将介绍组合扩展：
- Skills + Hooks 协同
- MCP + Skills 组合
- 完整审批流程实现

---

## 本篇要点

1. **MCP 三大能力**：Tools（操作）、Resources（数据）、Prompts（模板）
2. **Resources**：通过 URI 提供可读取的数据
3. **Prompts**：预定义交互模板，带参数
4. **Capabilities**：Server 声明支持的能力
5. **完整 Server**：Tools + Resources + Prompts 组合
