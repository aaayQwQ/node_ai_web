# Node AI Web

轻量级 OpenAI 兼容 API 网页聊天界面。纯 Node.js 内置模块，不需要 npm install，不依赖 package.json。

## 要求

- Node.js 12 或更新版本（推荐当前受支持的 LTS）。
- 一个兼容 OpenAI Chat Completions API 的 Base URL 和 API Key。

## 启动

在项目目录运行：

```sh
node main.js
```

浏览器打开 http://127.0.0.1:3001 。 

运行无第三方依赖的 Base URL 回归测试：\n\n```sh\nnode tests/base-url.test.js\n```\n\n检查 Node.js 版本、配置和上游连通性：

```sh
node main.js --check
```

首次启动会生成 `config/config.json` 和 `config/history.json`。在网页点击“设置”，填写 Base URL、API Key 和模型名称，然后保存。默认 Base URL 是 `https://api.deepseek.com`，默认模型是 `deepseek-chat`。

## 配置

- `config/config.json`：端口、上游 Base URL、API Key、模型、系统提示词、网页访问密码等。
- `config/history.json`：对话历史。
- `config/plugins_data/`：插件持久化数据。
- `logs/YYYY-MM-DD.log`：按天记录的日志，自动保留最近 14 天。
- `plugins/`：插件目录。

请勿将带有真实 API Key 或网页密码的配置提交到公开仓库。网页访问密码默认为空；若监听在非本机地址，建议配置密码并自行使用 HTTPS/反向代理。

## API

- `GET /health`：服务状态。
- `GET /v1/models`：转发到上游模型列表。
- `POST /v1/chat/completions`：转发聊天补全请求，支持 SSE 流式响应。
- `POST /v1/embeddings`：转发 Embeddings 请求。
- `GET/POST /api/config`：读取/保存配置。
- `GET/POST /api/history`：读取/保存历史。
- `GET /api/plugins`：列出本地插件。
- `GET/POST /api/mcp/servers`：列出或添加/编辑 MCP 服务。
- `DELETE /api/mcp/servers/:id`：删除 MCP 服务。
- `POST /api/mcp/servers/:id/discover`：发现该服务的工具。
- `GET /api/mcp/tools`：返回所有已启用服务的 OpenAI Function Calling 工具定义。
- `POST /api/mcp/call`：调用 MCP 工具。\n- `POST /api/plugins/:id/enable` 和 `/disable`：启用或停用插件。\n- `POST /api/plugins/:id/reload`：重新加载插件。

当配置网页访问密码后，API 和网页都需要使用 `Authorization: Bearer <网页密码>`。聊天接口有每 IP 每分钟 60 次的简单限流。

## 插件

每个插件目录需包含 `plugin.json` 与 `index.js`。支持的钩子：`onPluginInit`、`beforeRequest`、`afterResponse`、`onRequestError`、`onServerStart`。插件可以通过 `context.storage.get(key)` 和 `context.storage.set(key,value)` 保存简单状态。插件代码运行在 Node VM 上，但这不是完整的安全边界；只安装可信插件。

## 排错

- 确认端口 3001 没被占用。
- Base URL 可填写 `https://api.example.com` 或 `https://api.example.com/v1`；程序会避免重复拼接 `/v1`。不要把 API Key 或网页密码放进 URL。
- 检查 API Key、模型名和上游余额/限额。
- 查看 `logs/` 下当天日志。
- 查看 `http://127.0.0.1:3001/health` 检查服务是否运行。


## MCP 服务

在网页左下角的“插件”入口管理 MCP 服务。支持以下配置：

- **HTTP**：向配置的 Endpoint URL 发送 MCP JSON-RPC 请求（适用于 Streamable HTTP 服务）。
- **SSE**：支持传统 SSE 连接、endpoint 事件与 JSON-RPC 消息的基础流程；具体兼容性取决于服务器实现。
- **Stdio**：在运行 Node AI Web 的主机上启动指定命令，通过标准输入/输出交换 JSON-RPC 消息。

启用服务后，聊天发送前会尝试发现工具；当模型返回工具调用时，前端会按服务的调用策略确认或执行工具，并把结果交回模型继续生成。默认策略是“每次调用前确认”。上下文窗口按最近 N 轮用户消息截断。

**安全提示：** MCP 服务配置可以访问网络或启动本机进程。仅添加可信的服务与命令；不要把管理界面暴露到公网而不设置网页访问密码。认证头和环境变量会在读取配置时遮蔽。MCP 服务器能力和工具参数各不相同，仍应对每个服务单独测试。
