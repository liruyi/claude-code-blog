---
title: "MCP 开发：从零开发 MCP Server"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 7
readingTime: "22 min"
---

上一篇介绍了 MCP 的配置。本篇带你从零开发一个 MCP Server，理解协议的核心实现。

## MCP Server 架构

MCP Server 是一个独立进程，通过 stdin/stdout 与 Claude Code 通信：

```
Claude Code ─── JSON Request (stdin) ─── MCP Server
             ─── JSON Response (stdout) ───
```

**协议核心**：
1. 初始化握手（`initialize`）
2. 工具列表（`tools/list`）
3. 工具调用（`tools/call`）

## 用 TypeScript 开发

### 1. 创建项目

```bash
mkdir my-mcp-server
cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node
```

### 2. 实现 Server

`src/index.ts`：

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// 创建 MCP Server
const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
})

// 定义工具
server.tool(
  'echo',
  'Echo the input message back',
  {
    message: z.string().describe('The message to echo'),
  },
  async ({ message }) => {
    return {
      content: [{ type: 'text', text: `Echo: ${message}` }],
    }
  }
)

server.tool(
  'add',
  'Add two numbers',
  {
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  },
  async ({ a, b }) => {
    return {
      content: [{ type: 'text', text: `${a} + ${b} = ${a + b}` }],
    }
  }
)

// 启动 Server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
```

### 3. 构建和测试

```bash
npx tsc
node dist/index.js
```

**测试工具调用**：

发送 JSON 请求（通过 stdin）：
```json
{'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
```

响应（stdout）：
```json
{
  'jsonrpc': '2.0',
  'id': 1,
  'result': {
    'tools': [
      {'name': 'echo', 'description': 'Echo the input message back', 'inputSchema': {...}},
      {'name': 'add', 'description': 'Add two numbers', 'inputSchema': {...}}
    ]
  }
}
```

## 用 Python 开发

Python 有官方 MCP SDK：

```bash
pip install mcp
```

`server.py`：

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server('my-server')

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name='echo',
            description='Echo the input message back',
            inputSchema={
                'type': 'object',
                'properties': {
                    'message': {'type': 'string', 'description': 'The message to echo'}
                },
                'required': ['message']
            }
        ),
        Tool(
            name='add',
            description='Add two numbers',
            inputSchema={
                'type': 'object',
                'properties': {
                    'a': {'type': 'number', 'description': 'First number'},
                    'b': {'type': 'number', 'description': 'Second number'}
                },
                'required': ['a', 'b']
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == 'echo':
        return [TextContent(type='text', text=f'Echo: {arguments['message']}')]
    elif name == 'add':
        result = arguments['a'] + arguments['b']
        return [TextContent(type='text', text=f'{arguments['a']} + {arguments['b']} = {result}')]
    raise ValueError(f'Unknown tool: {name}')

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream)

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
```

运行：
```bash
python server.py
```

## 协议详解

### 初始化握手

**请求**：
```json
{
  'jsonrpc': '2.0',
  'id': 0,
  'method': 'initialize',
  'params': {
    'protocolVersion': '2024-11-05',
    'capabilities': {},
    'clientInfo': {
      'name': 'claude-code',
      'version': '2.1.88'
    }
  }
}
```

**响应**：
```json
{
  'jsonrpc': '2.0',
  'id': 0,
  'result': {
    'protocolVersion': '2024-11-05',
    'capabilities': {
      'tools': {}
    },
    'serverInfo': {
      'name': 'my-server',
      'version': '1.0.0'
    }
  }
}
```

### 工具列表

**请求**：
```json
{
  'jsonrpc': '2.0',
  'id': 1,
  'method': 'tools/list'
}
```

**响应**：
```json
{
  'jsonrpc': '2.0',
  'id': 1,
  'result': {
    'tools': [
      {
        'name': 'echo',
        'description': 'Echo the input message back',
        'inputSchema': {
          'type': 'object',
          'properties': {
            'message': { 'type': 'string' }
          },
          'required': ['message']
        }
      }
    ]
  }
}
```

### 工具调用

**请求**：
```json
{
  'jsonrpc': '2.0',
  'id': 2,
  'method': 'tools/call',
  'params': {
    'name': 'echo',
    'arguments': {
      'message': 'Hello'
    }
  }
}
```

**响应**：
```json
{
  'jsonrpc': '2.0',
  'id': 2,
  'result': {
    'content': [
      { 'type': 'text', 'text': 'Echo: Hello' }
    ],
    'isError': false
  }
}
```

## inputSchema 格式

工具的 `inputSchema` 使用 JSON Schema：

```json
{
  'type': 'object',
  'properties': {
    'query': {
      'type': 'string',
      'description': 'Search query'
    },
    'limit': {
      'type': 'number',
      'description': 'Maximum results',
      'default': 10
    },
    'filters': {
      'type': 'array',
      'items': { 'type': 'string' },
      'description': 'Filter conditions'
    }
  },
  'required': ['query']
}
```

**常用类型**：
- `string`：字符串
- `number`：数字
- `boolean`：布尔值
- `array`：数组
- `object`：嵌套对象

## 错误处理

### 工具错误

返回 `isError: true`：

```json
{
  'jsonrpc': '2.0',
  'id': 2,
  'result': {
    'content': [
      { 'type': 'text', 'text': 'Error: Invalid input' }
    ],
    'isError': true
  }
}
```

### 协议错误

返回错误对象：

```json
{
  'jsonrpc': '2.0',
  'id': 2,
  'error': {
    'code': -32602,
    'message': 'Invalid params'
  }
}
```

**标准错误码**：
- `-32700`：Parse error
- `-32600`：Invalid Request
- `-32601`：Method not found
- `-32602`：Invalid params
- `-32603`：Internal error

## 实战：知识库 MCP Server

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

// 搜索知识库
server.tool(
  'search',
  'Search the knowledge base for relevant documents',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(5).describe('Maximum results'),
  },
  async ({ query, limit }) => {
    const files = await fs.readdir(KNOWLEDGE_DIR)
    const results: string[] = []

    for (const file of files) {
      const content = await fs.readFile(path.join(KNOWLEDGE_DIR, file), 'utf-8')
      if (content.toLowerCase().includes(query.toLowerCase())) {
        results.push(`### ${file}\n${content.slice(0, 500)}...`)
      }
      if (results.length >= limit) break
    }

    return {
      content: [{
        type: 'text',
        text: results.length > 0
          ? `Found ${results.length} documents:\n\n${results.join('\n\n')}`
          : 'No matching documents found'
      }]
    }
  }
)

// 读取文档
server.tool(
  'read',
  'Read a specific document from the knowledge base',
  {
    filename: z.string().describe('Document filename'),
  },
  async ({ filename }) => {
    try {
      const content = await fs.readFile(path.join(KNOWLEDGE_DIR, filename), 'utf-8')
      return {
        content: [{ type: 'text', text: content }]
      }
    } catch {
      return {
        content: [{ type: 'text', text: `Error: Document ${filename} not found` }],
        isError: true
      }
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
```

## 配置到 Claude Code

`.mcp.json`：

```json
{
  'mcpServers': {
    'knowledge': {
      'command': 'node',
      'args': ['dist/index.js'],
      'env': {
        'KNOWLEDGE_DIR': '/path/to/knowledge'
      }
    }
  }
}
```

使用：
```
请搜索关于 API 设计的文档
```

Claude Code 会调用 `knowledge.search` 工具。

## 下一步

下一篇将介绍 MCP Resources 和 Prompts：
- 提供可读取资源
- 预定义提示模板
- 完整 MCP 能力

---

## 本篇要点

1. **MCP Server = stdin/stdout 进程**：JSON 请求/响应
2. **SDK**：`@modelcontextprotocol/sdk` (TS) 或 `mcp` (Python)
3. **协议流程**：initialize → tools/list → tools/call
4. **inputSchema**：JSON Schema 定义工具输入
5. **错误处理**：`isError: true` 或标准错误码
6. **实战**：知识库搜索 Server
