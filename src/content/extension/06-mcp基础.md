---
title: "MCP 基础：协议介绍与配置"
description: "文章内容摘要"
publishDate: 2024-05-16
order: 6
readingTime: "17 min"
---

MCP (Model Context Protocol) 是 Anthropic 推出的开放协议，让 AI Agent 可以接入外部工具。Claude Code 通过 MCP，可以连接 Slack、GitHub、数据库、内部 API 等外部系统。

## MCP 是什么？

MCP 定义了一套标准协议：

```
Claude Code (Client) ─── MCP Protocol ─── MCP Server (External Tool)
```

**核心概念**：
- **Client**：Claude Code，发起工具调用请求
- **Server**：外部工具服务，提供工具定义和执行能力
- **Transport**：通信方式（stdio、HTTP、WebSocket）

**MCP Server 提供的能力**：
1. **Tools**：可调用的操作（如发送 Slack 消息）
2. **Resources**：可读取的资源（如知识库文档）
3. **Prompts**：预定义的提示模板

## 7 种传输类型

MCP Server 有多种连接方式：

### 1. stdio：进程通信（最常用）

Server 作为子进程运行，通过 stdin/stdout 通信：

```json
{
  'mcpServers': {
    'filesystem': {
      'type': 'stdio',
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-filesystem']
    }
  }
}
```

**特点**：
- 最简单、最稳定
- 无需网络配置
- 适合本地工具

**常用启动方式**：
- `npx -y @anthropic-ai/mcp-server-*`
- `uvx mcp-server-*` (Python)
- 直接执行本地脚本

### 2. sse：HTTP SSE 远程连接

Server 通过 HTTP Server-Sent Events 提供服务：

```json
{
  'mcpServers': {
    'remote-api': {
      'type': 'sse',
      'url': 'https://api.example.com/mcp/sse',
      'headers': {
        'Authorization': 'Bearer YOUR_TOKEN'
      }
    }
  }
}
```

**特点**：
- 支持远程服务
- 需要网络访问
- 支持 OAuth 认证

### 3. http：HTTP 连接

类似 sse，但使用标准 HTTP：

```json
{
  'mcpServers': {
    'api': {
      'type': 'http',
      'url': 'https://api.example.com/mcp',
      'headers': {
        'X-API-Key': 'YOUR_KEY'
      }
    }
  }
}
```

### 4. ws：WebSocket 连接

实时双向通信：

```json
{
  'mcpServers': {
    'realtime': {
      'type': 'ws',
      'url': 'wss://api.example.com/mcp/ws',
      'headers': {
        'Authorization': 'Bearer YOUR_TOKEN'
      }
    }
  }
}
```

**特点**：
- 实时通信
- 适合需要持续连接的场景

### 5. sse-ide：IDE 内部 SSE

IDE 扩展专用：

```json
{
  'mcpServers': {
    'vscode': {
      'type': 'sse-ide',
      'url': 'http://localhost:3000/mcp',
      'ideName': 'VSCode'
    }
  }
}
```

### 6. ws-ide：IDE 内部 WebSocket

IDE 扩展 WebSocket 版本：

```json
{
  'mcpServers': {
    'jetbrains': {
      'type': 'ws-ide',
      'url': 'ws://localhost:3000/mcp',
      'ideName': 'JetBrains',
      'authToken': 'optional-token'
    }
  }
}
```

### 7. sdk：SDK 内嵌传输

由 SDK 直接管理，无需配置连接：

```json
{
  'mcpServers': {
    'claude-vscode': {
      'type': 'sdk',
      'name': 'claude-vscode'
    }
  }
}
```

**特点**：
- SDK 内部管理
- 不启动进程或网络连接

## 配置作用域

MCP Server 配置有多个作用域：

| 作用域 | 位置 | 作用范围 |
|--------|------|----------|
| `project` | `.mcp.json` | 当前项目 |
| `user` | `~/.claude/settings.json` | 所有项目 |
| `local` | `.claude/settings.local.json` | 当前项目（本地） |
| `enterprise` | `managed-mcp.json` | 企业管理 |
| `claudeai` | Claude.ai Connector | 云端服务 |

### `.mcp.json` 文件格式

项目级配置放在 `.mcp.json`：

```json
{
  'mcpServers': {
    'slack': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-slack'],
      'env': {
        'SLACK_BOT_TOKEN': '${SLACK_BOT_TOKEN}'
      }
    },
    'github': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-github'],
      'env': {
        'GITHUB_TOKEN': '${GITHUB_TOKEN}'
      }
    }
  }
}
```

**注意**：
- 项目级配置需要用户审批（安全机制）
- `env` 支持环境变量展开 `${VAR}`

### 用户级配置

在 `~/.claude/settings.json`：

```json
{
  'mcpServers': {
    'filesystem': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-filesystem', '/home/user']
    }
  }
}
```

用户级配置自动生效，无需审批。

## 环境变量展开

MCP 配置支持环境变量：

```json
{
  'mcpServers': {
    'api': {
      'command': 'node',
      'args': ['server.js'],
      'env': {
        'API_KEY': '${API_KEY}',
        'DATABASE_URL': '${DATABASE_URL}'
      }
    }
  }
}
```

**语法**：`${VAR_NAME}` 在启动时替换为实际值。

**缺失变量处理**：
- 变量不存在时，Server 可能启动失败
- Claude Code 会警告缺失的环境变量

## 企业策略配置

企业可以控制 MCP Server 使用：

### allowedMcpServers：白名单

```json
{
  'allowedMcpServers': [
    { 'serverName': 'slack' },
    { 'serverName': 'github' },
    { 'serverCommand': ['npx', '-y', '@anthropic-ai/mcp-server-*'] },
    { 'serverUrl': 'https://internal.example.com/*' }
  ]
}
```

**匹配方式**：
- `serverName`：按名称匹配
- `serverCommand`：按命令数组匹配
- `serverUrl`：按 URL 匹配（支持 `*` 通配符）

### deniedMcpServers：黑名单

```json
{
  'deniedMcpServers': [
    { 'serverName': 'dangerous-server' },
    { 'serverUrl': 'https://external.example.com/*' }
  ]
}
```

黑名单优先级高于白名单。

### allowManagedMcpServersOnly

```json
{
  'allowManagedMcpServersOnly': true
}
```

设为 `true` 时，只有企业配置的 MCP Server 可用，用户无法添加自己的。

## 常用 MCP Server

### Slack

```json
{
  'mcpServers': {
    'slack': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-slack'],
      'env': {
        'SLACK_BOT_TOKEN': '${SLACK_BOT_TOKEN}'
      }
    }
  }
}
```

**能力**：
- 发送消息到频道
- 读取频道消息
- 搜索消息

### GitHub

```json
{
  'mcpServers': {
    'github': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-github'],
      'env': {
        'GITHUB_TOKEN': '${GITHUB_TOKEN}'
      }
    }
  }
}
```

**能力**：
- 创建/更新 Issue
- 创建 PR
- 搜索仓库
- 读取文件

### Filesystem

```json
{
  'mcpServers': {
    'filesystem': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-filesystem', '/path/to/allowed/dir']
    }
  }
}
```

**能力**：
- 读取文件（限制在指定目录）
- 写入文件
- 列出目录

### Puppeteer（浏览器控制）

```json
{
  'mcpServers': {
    'puppeteer': {
      'command': 'npx',
      'args': ['-y', '@anthropic-ai/mcp-server-puppeteer']
    }
  }
}
```

**能力**：
- 打开网页
- 截图
- 点击、输入
- 提取内容

## 禁用/启用 Server

用户可以禁用特定 Server：

```json
{
  'disabledMcpServers': ['slack']
}
```

或启用（针对默认禁用的内置 Server）：

```json
{
  'enabledMcpServers': ['computer-use']
}
```

## 调试 MCP

### 查看 Server 状态

使用 `/mcp` 命令查看已连接的 Server：

```
/mcp
```

输出：
```
Connected MCP Servers:
- slack (connected, 3 tools)
- github (connected, 5 tools)
- filesystem (failed: permission denied)
```

### 查看 Server 工具

```
/mcp slack
```

输出：
```
Server: slack
Tools:
- slack_post_message: Post a message to a Slack channel
- slack_get_messages: Get messages from a channel
- slack_search: Search messages
```

### Server 连接状态

| 状态 | 说明 |
|------|------|
| `connected` | 正常运行 |
| `failed` | 启动失败 |
| `needs-auth` | 需要认证 |
| `pending` | 正在连接 |
| `disabled` | 已禁用 |

## 下一步

下一篇将深入 MCP Server 开发：
- 从零开发 MCP Server
- 协议实现
- 错误处理

---

## 本篇要点

1. **MCP = Model Context Protocol**：Anthropic 推出的工具接入协议
2. **7 种传输**：stdio、sse、http、ws、sse-ide、ws-ide、sdk
3. **配置位置**：`.mcp.json`（项目）、`settings.json`（用户）
4. **环境变量**：`${VAR_NAME}` 自动展开
5. **企业策略**：`allowedMcpServers`、`deniedMcpServers`、`allowManagedMcpServersOnly`
6. **调试命令**：`/mcp` 查看 Server 状态
