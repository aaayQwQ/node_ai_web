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

浏览器打开 http://127.0.0.1:3001 。\n\n检查 Node.js 版本、配置和上游连通性：\n\n```sh\nnode main.js --check\n```

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
- `GET /api/plugins`：列出插件。

当配置网页访问密码后，API 和网页都需要使用 `Authorization: Bearer <网页密码>`。聊天接口有每 IP 每分钟 60 次的简单限流。

## 插件

每个插件目录需包含 `plugin.json` 与 `index.js`。支持的钩子：`onPluginInit`、`beforeRequest`、`afterResponse`、`onRequestError`、`onServerStart`。插件可以通过 `context.storage.get(key)` 和 `context.storage.set(key,value)` 保存简单状态。插件代码运行在 Node VM 上，但这不是完整的安全边界；只安装可信插件。

## 排错

- 确认端口 3001 没被占用。
- 确认 Base URL 不要重复添加 `/v1`，例如 DeepSeek 使用 `https://api.deepseek.com`。
- 检查 API Key、模型名和上游余额/限额。
- 查看 `logs/` 下当天日志。
- 查看 `http://127.0.0.1:3001/health` 检查服务是否运行。
