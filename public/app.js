'use strict';

const $ = id => document.getElementById(id);

const state = {
  config: {},
  chats: [],
  activeChatId: null,
  controller: null,
  thinking: false,
  auth: localStorage.getItem('node-ai-web-password') || '',
  nextChatId: 1
};

function requestHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (state.auth) {
    headers.Authorization = 'Bearer ' + state.auth;
  }
  return headers;
}

async function api(path, options = {}) {
  const init = Object.assign({}, options);
  init.headers = requestHeaders(init.headers);

  let response = await fetch(path, init);

  if (response.status === 401) {
    const password = window.prompt('请输入网页访问密码');
    if (password === null) throw new Error('已取消登录。');

    state.auth = password;
    localStorage.setItem('node-ai-web-password', password);
    init.headers = requestHeaders(options.headers);
    response = await fetch(path, init);
  }

  if (!response.ok) {
    let message = await response.text();

    try {
      const data = JSON.parse(message);
      message = data.error && data.error.message
        ? data.error.message
        : message;
    } catch (_) {}

    throw new Error(message || ('HTTP ' + response.status));
  }

  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json')
    ? response.json()
    : response.text();
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value) {
  let text = escapeHTML(value);

  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  return text;
}

function highlightCode(source, language) {
  const lang = String(language || '').toLowerCase();
  const code = String(source || '');
  const supported = /^(js|javascript|ts|typescript|json|html|xml|css|bash|sh|python|py|go|rust|java|c|cpp|sql)$/.test(lang);
  if (!supported) return escapeHTML(code);

  const tokenPattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|new|throw|try|catch|async|await|import|from|export|default|true|false|null|undefined|None|def|print|in|is|and|or|not|package|func|type|struct|fn|pub|use|SELECT|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE|CREATE|TABLE)\b|\b\d+(?:\.\d+)?\b)/g;
  let result = '';
  let last = 0;
  for (const match of code.matchAll(tokenPattern)) {
    result += escapeHTML(code.slice(last, match.index));
    const token = match[0];
    let kind = 'number';
    if (/^(\/\/|#|\/\*)/.test(token)) kind = 'comment';
    else if (/^["'`]/.test(token)) kind = 'string';
    else if (/^\d/.test(token)) kind = 'number';
    else kind = 'keyword';
    result += '<span class="syntax-' + kind + '">' + escapeHTML(token) + '</span>';
    last = match.index + token.length;
  }
  result += escapeHTML(code.slice(last));
  return result;
}

function renderMarkdown(value) {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];

  let text = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({
      language: escapeHTML(language.trim()),
      code: code.replace(/\n$/, '')
    });
    return '\n@@CODE_BLOCK_' + index + '@@\n';
  });

  const blocks = text.split(/\n{2,}/).map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';

    const codeMatch = trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (codeMatch) {
      const code = codeBlocks[Number(codeMatch[1])];
      const label = code.language
        ? '<span class="code-language">' + code.language + '</span>'
        : '';

      return '<pre>' + label
        + '<button type="button" class="copy-code">复制</button>'
        + '<code>' + highlightCode(code.code, code.language.replace(/&amp;/g, '&')) + '</code></pre>';
    }

    if (/^#{1,3}\s/.test(trimmed)) {
      const heading = trimmed.match(/^(#{1,3})\s+([\s\S]+)$/);
      const level = heading[1].length;
      return '<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>';
    }

    const lines = trimmed.split('\n');
    if (lines.every(line => /^\s*[-*+]\s+/.test(line))) {
      return '<ul>' + lines.map(line =>
        '<li>' + renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, '')) + '</li>'
      ).join('') + '</ul>';
    }

    if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
      return '<ol>' + lines.map(line =>
        '<li>' + renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, '')) + '</li>'
      ).join('') + '</ol>';
    }

    if (lines.length >= 2 && lines.every(line => /^\s*\|.*\|\s*$/.test(line))) {
      const cells = lines.map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
      const hasSeparator = cells.length > 1 && cells[1].every(cell => /^:?-{3,}:?$/.test(cell));
      const headerCells = cells[0];
      const bodyRows = cells.slice(hasSeparator ? 2 : 1);
      return '<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>'
        + headerCells.map(cell => '<th>' + renderInlineMarkdown(cell) + '</th>').join('')
        + '</tr></thead><tbody>' + bodyRows.map(row => '<tr>'
          + headerCells.map((_, i) => '<td>' + renderInlineMarkdown(row[i] || '') + '</td>').join('')
          + '</tr>').join('') + '</tbody></table></div>';
    }

    if (lines.every(line => /^\s*&gt;\s?/.test(escapeHTML(line)))) {
      return '<blockquote>' + lines.map(line => renderInlineMarkdown(line.replace(/^\s*>\s?/, ''))).join('<br>') + '</blockquote>';
    }

    return '<p>' + renderInlineMarkdown(trimmed).replace(/\n/g, '<br>') + '</p>';
  });

  return blocks.join('');
}

function parseJSONField(value, label) {
  if (!String(value || '').trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    return parsed;
  } catch (error) {
    throw new Error(label + '格式错误：' + error.message);
  }
}

function parseJSONArray(value, label) {
  if (!String(value || '').trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    return parsed;
  } catch (error) {
    throw new Error(label + '格式错误：' + error.message);
  }
}

function openSettings() {
  $('settingsResult').textContent = '';
  $('settings').showModal();
  const key = $('apiKey');
  if (key && !state.config.apiKeySet) key.focus();
}

let toastTimer;
function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast visible ' + type;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
}

function currentChat() {
  return state.chats.find(chat => chat.id === state.activeChatId) || null;
}

function createChat() {
  const chat = {
    id: makeId(),
    title: '新对话',
    messages: [],
    updatedAt: Date.now(),
    thinking: false
  };

  state.chats.push(chat);
  state.activeChatId = chat.id;
  saveHistory();
  renderHistory();
  renderMessages();
  $('prompt').focus();
}

function saveHistory() {
  try {
    localStorage.setItem('node-ai-web-history', JSON.stringify(state.chats));
  } catch (_) {}

  api('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.chats)
  }).catch(error => console.warn('保存历史失败：', error.message));
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();

  for (const chat of state.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    const item = document.createElement('div');
    item.className = 'history-item' + (chat.id === state.activeChatId ? ' active' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    open.textContent = chat.title || '新对话';
    open.title = chat.title || '新对话';
    open.addEventListener('click', () => {
      state.activeChatId = chat.id;
      state.thinking = Boolean(chat.thinking);
      updateThinkingButton();
      renderHistory();
      renderMessages();
      closeSidebarOnMobile();
    });

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'history-action';
    rename.textContent = '改名';
    rename.title = '重命名对话';
    rename.setAttribute('aria-label', '重命名对话');
    rename.addEventListener('click', event => {
      event.stopPropagation();
      const title = window.prompt('重命名对话', chat.title || '新对话');
      if (title === null) return;
      chat.title = title.trim().slice(0, 100) || '新对话';
      chat.updatedAt = Date.now();
      saveHistory();
      renderHistory();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-action history-delete';
    remove.textContent = '删除';
    remove.title = '删除对话';
    remove.setAttribute('aria-label', '删除对话');
    remove.addEventListener('click', event => {
      event.stopPropagation();
      if (!window.confirm('确定删除对话“' + (chat.title || '新对话') + '”？此操作不可撤销。')) return;
      const index = state.chats.findIndex(item => item.id === chat.id);
      if (index >= 0) state.chats.splice(index, 1);
      if (state.activeChatId === chat.id) {
        const next = state.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        state.activeChatId = next ? next.id : null;
        state.thinking = next ? Boolean(next.thinking) : false;
      }
      saveHistory();
      renderHistory();
      renderMessages();
    });

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.append(rename, remove);
    item.append(open, actions);
    list.appendChild(item);
  }
}

function renderMessages() {
  const container = $('messages');
  container.replaceChildren();

  const chat = currentChat();
  if (!chat || chat.messages.length === 0) {
    const welcome = document.createElement('div');
    const configured = Boolean(state.config.baseURL && state.config.apiKeySet);
    welcome.className = 'welcome welcome-modern' + (configured ? '' : ' needs-config');
    welcome.innerHTML = '<div class="welcome-brand">NODE AI WEB</div>'
      + '<h1>' + (configured ? '有什么新想法？' : '先连接你的模型，<br>再开始对话。') + '</h1>'
      + '<p class="welcome-description">' + (configured ? '写代码、整理思路、探索问题。让对话从这里开始。' : '这是你的私人 AI 工作区。配置兼容 OpenAI 的 API 地址与密钥，即可开始使用。密钥由本地服务保存。') + '</p>'
      + (configured
        ? '<div class="welcome-suggestions"><button type="button" data-prompt="帮我解释一段代码">解释一段代码 <span>↗</span></button><button type="button" data-prompt="帮我整理一个想法">整理一个想法 <span>↗</span></button><button type="button" data-prompt="用清晰的步骤解决一个问题">拆解一个问题 <span>↗</span></button></div>'
        : '<div class="setup-card"><div class="setup-card-icon">⌘</div><div class="setup-card-copy"><strong>连接你的 API</strong><span>Base URL · API Key · 默认模型</span></div><button type="button" class="setup-cta" id="welcomeSetupBtn">去配置 API Key <span>→</span></button></div><div class="setup-foot"><span>支持 OpenAI 兼容接口</span><span>DeepSeek · OpenAI · OpenRouter · 自定义</span></div>')
      ;
    container.appendChild(welcome);
    welcome.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
      $('prompt').value = button.dataset.prompt;
      $('prompt').dispatchEvent(new Event('input', { bubbles: true }));
      $('prompt').focus();
    }));
    const setupButton = $('welcomeSetupBtn');
    if (setupButton) setupButton.addEventListener('click', openSettings);
    $('modelSelect').title = state.config.model || '默认模型';
    return;
  }

  for (const message of chat.messages) {
    const row = document.createElement('article');
    row.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');

    if (message.role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = message.content || '';
      row.appendChild(bubble);
    } else if (message.role === 'tool') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble tool-result-bubble';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'MCP 工具执行结果';
      const pre = document.createElement('pre');
      pre.textContent = message.content || '';
      details.append(summary, pre);
      bubble.appendChild(details);
      row.appendChild(bubble);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = '◈';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = (message.reasoning
        ? '<details class="thinking-panel"><summary><span class="thinking-pulse"></span>已深度思考 <span class="thinking-panel-note">展开查看</span></summary><div class="thinking-content">' + renderMarkdown(message.reasoning) + '</div></details>'
        : '') + renderMarkdown(message.content || (state.controller ? '正在思考…' : ''));

      row.append(avatar, bubble);
    }

    container.appendChild(row);
  }

  container.scrollTop = container.scrollHeight;

  container.querySelectorAll('.copy-code').forEach(button => {
    button.addEventListener('click', async () => {
      const code = button.parentElement.querySelector('code').innerText;

      try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
      } catch (_) {
        button.textContent = '复制失败';
      }

      window.setTimeout(() => { button.textContent = '复制'; }, 1400);
    });
  });

  container.scrollTop = container.scrollHeight;
  $('modelSelect').title = $('modelSelect').value
    || state.config.model
    || '默认模型';
  updateThinkingButton();
}

function setConnectionStatus(message, status) {
  $('status').textContent = message;
  $('connectionDot').classList.toggle('online', status === 'online');
  $('connectionDot').classList.toggle('offline', status === 'offline');
}

async function loadSettings() {
  try {
    state.config = await api('/api/config');
    $('baseURL').value = state.config.baseURL || '';
    $('apiKey').value = '';
    $('apiKey').placeholder = state.config.apiKeySet
      ? '已保存密钥（留空则保留）'
      : '粘贴 API Key';
    $('model').value = state.config.model || '';
    $('systemPrompt').value = state.config.systemPrompt || '';
    $('temperature').value = state.config.temperature ?? 0.7;
    $('topP').value = state.config.topP ?? 1;
    $('maxTokens').value = state.config.maxTokens ?? 4096;
    $('contextWindow').value = state.config.contextWindow ?? 20;
    $('customHeaders').value = JSON.stringify(state.config.customHeaders || {}, null, 2);
    $('webPassword').value = '';
    $('webPassword').placeholder = '留空则保留当前密码';
    setConnectionStatus('本地服务已就绪', 'online');
    const ready = Boolean(state.config.baseURL && state.config.apiKeySet);
    document.body.classList.toggle('needs-api-config', !ready);
    if (!ready) setConnectionStatus('需要配置 API', 'offline');
    renderMessages();
  } catch (error) {
    setConnectionStatus('本地服务连接失败', 'offline');
    console.error(error);
  }
}

async function loadModels() {
  try {
    const result = await api('/v1/models');
    const models = Array.isArray(result.data) ? result.data : [];
    const select = $('modelSelect');
    const selected = select.value || state.config.model || '';

    select.replaceChildren(new Option('使用默认模型', ''));

    for (const model of models) {
      if (!model || !model.id) continue;
      select.add(new Option(model.id, model.id));
    }

    select.value = selected;
    if (select.value !== selected) select.value = '';
    select.title = select.value || state.config.model || '默认模型';
  } catch (error) {
    console.warn('读取模型列表失败：', error.message);
  }
}

function updateThinkingButton() {
  const enabled = Boolean(state.thinking);
  $('thinkingBtn').classList.toggle('thinking-active', enabled);
  $('thinkingBtn').title = enabled ? '深度思考已开启' : '开启深度思考';
  $('thinkingBtn').setAttribute('aria-pressed', String(enabled));
}

function parseSSEChunk(text, assistantMessage) {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    try {
      const event = JSON.parse(data);
      const choice = event.choices && event.choices[0];
      const delta = choice && choice.delta;

      if (delta && typeof delta.reasoning_content === 'string') {
        assistantMessage.reasoning = (assistantMessage.reasoning || '') + delta.reasoning_content;
      } else if (delta && typeof delta.reasoning === 'string') {
        assistantMessage.reasoning = (assistantMessage.reasoning || '') + delta.reasoning;
      }

      if (delta && Array.isArray(delta.tool_calls)) {
        assistantMessage.tool_calls = assistantMessage.tool_calls || [];
        for (const part of delta.tool_calls) {
          const index = Number(part.index) || 0;
          if (!assistantMessage.tool_calls[index]) {
            assistantMessage.tool_calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const call = assistantMessage.tool_calls[index];
          if (part.id) call.id = part.id;
          if (part.function && part.function.name) call.function.name += part.function.name;
          if (part.function && part.function.arguments) call.function.arguments += part.function.arguments;
        }
      }

      if (delta && typeof delta.content === 'string') {
        assistantMessage.content += delta.content;
      } else if (delta && Array.isArray(delta.content)) {
        for (const item of delta.content) {
          if (item && item.type === 'text' && item.text) assistantMessage.content += item.text;
        }
      }
    } catch (_) {
      // 忽略 SSE 中的注释行、心跳和非 JSON 数据。
    }
  }
}

async function sendMessage(event) {
  if (event) event.preventDefault();
  const input = $('prompt');
  const content = input.value.trim();
  if (!content || state.controller) return;

  if (!state.config.baseURL || !state.config.apiKeySet) {
    showToast('请先配置 Base URL 和 API Key，再发送消息。', 'warning');
    openSettings();
    return;
  }
  if (!currentChat()) createChat();

  const chat = currentChat();
  chat.messages.push({ role: 'user', content });
  chat.title = chat.messages.filter(message => message.role === 'user').length === 1 ? content.slice(0, 36) : chat.title;
  chat.updatedAt = Date.now();
  chat.thinking = state.thinking;
  input.value = '';
  input.style.height = 'auto';

  let assistant = { role: 'assistant', content: '', reasoning: '' };
  chat.messages.push(assistant);
  renderHistory();
  renderMessages();
  saveHistory();

  state.controller = new AbortController();
  $('send').disabled = true;
  $('stop').hidden = false;
  input.disabled = true;

  try {
    let mcpTools = [];
    try { mcpTools = await api('/api/mcp/tools'); }
    catch (error) { showToast('读取 MCP 工具失败：' + error.message, 'warning'); }
    const toolLookup = new Map(mcpTools.map(tool => [tool.function.name, tool]));
    let round = 0;
    let continueTools = true;

    while (continueTools && round < 5) {
      round++;
      const maxTurns = Number(state.config.contextWindow) || 20;
      const allMessages = chat.messages.filter(message =>
        message.role === 'user' || message.role === 'tool' ||
        (message.role === 'assistant' && (message.content || message.tool_calls))
      );
      const userIndices = [];
      allMessages.forEach((message, index) => { if (message.role === 'user') userIndices.push(index); });
      const startIndex = userIndices.length > maxTurns ? userIndices[userIndices.length - maxTurns] : 0;
      const contextMessages = allMessages.slice(startIndex).map(message => {
        if (message.role === 'assistant' && message.tool_calls) {
          return { role: 'assistant', content: message.content || null, tool_calls: message.tool_calls };
        }
        if (message.role === 'tool') {
          return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content || '' };
        }
        return { role: message.role, content: message.content || '' };
      });

      const payload = {
        model: $('modelSelect').value || state.config.model,
        messages: contextMessages,
        stream: true,
        temperature: Number(state.config.temperature ?? 0.7),
        top_p: Number(state.config.topP ?? 1),
        max_tokens: Number(state.config.maxTokens ?? 4096)
      };
      if (state.thinking) payload.reasoning_effort = 'high';
      if (mcpTools.length) payload.tools = mcpTools.map(tool => ({ type: 'function', function: tool.function }));
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: requestHeaders({ 'Content-Type': 'application/json' }),
        signal: state.controller.signal,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try { const data = JSON.parse(text); message = data.error && data.error.message ? data.error.message : text; } catch (_) {}
        throw new Error(message || ('HTTP ' + response.status));
      }
      if (!response.body) throw new Error('浏览器没有提供流式响应读取接口。');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });
        const events = pending.split(/\r?\n\r?\n/);
        pending = events.pop();
        for (const eventText of events) parseSSEChunk(eventText, assistant);
        renderMessages();
      }
      pending += decoder.decode();
      if (pending.trim()) parseSSEChunk(pending, assistant);

      const toolCalls = (assistant.tool_calls || []).filter(call => call && call.function && call.function.name);
      if (!toolCalls.length) {
        continueTools = false;
        break;
      }
      assistant.tool_calls = toolCalls;
      assistant.content = assistant.content || '';
      renderMessages();
      for (const call of toolCalls) {
        const registered = toolLookup.get(call.function.name);
        if (!registered) throw new Error('模型请求了未注册的 MCP 工具：' + call.function.name);
        const description = registered.serverName + ' / ' + registered.originalName;
        if (registered && (registered.approval !== 'auto') && !window.confirm('允许调用 MCP 工具？\n' + description + '\n参数：\n' + call.function.arguments)) {
          chat.messages.push({ role: 'tool', tool_call_id: call.id, content: '用户拒绝了该工具调用。' });
          continue;
        }
        showToast('正在调用 MCP 工具：' + description, 'info');
        let args;
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch (_) { throw new Error('MCP 工具参数不是有效 JSON：' + call.function.name); }
        const result = await api('/api/mcp/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: call.function.name, arguments: args })
        });
        chat.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.result)
        });
      }
      assistant = { role: 'assistant', content: '', reasoning: '' };
      chat.messages.push(assistant);
      saveHistory();
    }
    if (round >= 5 && continueTools) {
      assistant.content = '工具调用轮数已达到上限，请继续提问或减少工具链长度。';
    } else if (!assistant.content && !assistant.reasoning) {
      assistant.content = '（服务已响应，但没有返回可显示的文本内容。）';
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!assistant.content) assistant.content = '已停止生成。';
    } else {
      assistant.content = '请求失败：' + error.message;
      showToast(error.message, 'warning');
    }
  } finally {
    state.controller = null;
    $('send').disabled = false;
    $('stop').hidden = true;
    input.disabled = false;
    input.focus();
    chat.updatedAt = Date.now();
    saveHistory();
    renderHistory();
    renderMessages();
  }
}

async function saveSettings() {
  let body;
  try {
  body = {
    baseURL: $('baseURL').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    systemPrompt: $('systemPrompt').value,
    temperature: Number($('temperature').value),
    topP: Number($('topP').value),
    maxTokens: Number($('maxTokens').value),
    contextWindow: Number($('contextWindow').value),
    customHeaders: parseJSONField($('customHeaders').value, '自定义请求头'),
    webPassword: $('webPassword').value
  };
  } catch (error) {
    $('settingsResult').textContent = error.message;
    return;
  }

  $('settingsResult').textContent = '正在保存…';

  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (body.webPassword) {
      state.auth = body.webPassword;
      localStorage.setItem('node-ai-web-password', state.auth);
    }

    $('apiKey').value = '';
    $('webPassword').value = '';
    await loadSettings();
    await loadModels();
    $('settingsResult').textContent = '设置已保存。';
    const ready = Boolean(state.config.baseURL && state.config.apiKeySet);
    if (ready) {
      showToast('连接配置已保存，可以开始对话。', 'success');
      $('settings').close();
    } else {
      showToast('已保存；请确认 Base URL 和 API Key 均已填写。', 'warning');
    }
    renderMessages();
  } catch (error) {
    $('settingsResult').textContent = '保存失败：' + error.message;
  }
}

async function testConnection() {
  const output = $('settingsResult');
  output.textContent = '正在测试连接…';

  try {
    const result = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseURL: $('baseURL').value.trim(),
        apiKey: $('apiKey').value.trim()
      })
    });

    output.textContent = '连接成功 · ' + result.rtt + ' ms · '
      + result.count + ' 个模型\n' + result.url;
  } catch (error) {
    output.textContent = '连接失败：' + error.message;
  }
}

async function openPlugins() {
  const container = $('pluginList');
  container.replaceChildren();

  try {
    const plugins = await api('/api/plugins');

    if (!plugins.length) {
      container.textContent = '当前没有安装插件。';
    }

    for (const plugin of plugins) {
      const card = document.createElement('section');
      card.className = 'plugin-card';

      const title = document.createElement('strong');
      title.textContent = plugin.name || plugin.id;

      const description = document.createElement('p');
      description.textContent = plugin.description || '没有描述。';

      const status = document.createElement('small');
      status.textContent = plugin.id + ' · ' + (plugin.enabled ? '已启用' : '未启用');

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = plugin.enabled ? '停用' : '启用';
      toggle.addEventListener('click', async () => {
        try {
          await api('/api/plugins/' + encodeURIComponent(plugin.id)
            + '/' + (plugin.enabled ? 'disable' : 'enable'), { method: 'POST' });
          await openPlugins();
        } catch (error) {
          window.alert(error.message);
        }
      });

      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = '重新加载';
      reload.style.marginLeft = '7px';
      reload.addEventListener('click', async () => {
        try {
          await api('/api/plugins/' + encodeURIComponent(plugin.id) + '/reload', {
            method: 'POST'
          });
          await openPlugins();
        } catch (error) {
          window.alert(error.message);
        }
      });

      card.append(title, description, status, document.createElement('br'), toggle, reload);
      container.appendChild(card);
    }

    $('plugins').showModal();
  } catch (error) {
    window.alert(error.message);
  }
}

function resetMCPForm() {
  $('mcpId').value = '';
  $('mcpName').value = '';
  $('mcpType').value = 'http';
  $('mcpUrl').value = '';
  $('mcpCommand').value = '';
  $('mcpArgs').value = '[]';
  $('mcpEnv').value = '{}';
  $('mcpHeaders').value = '{}';
  $('mcpApproval').value = 'confirm';
  $('mcpEnabled').checked = true;
  $('mcpEditorTitle').textContent = '添加 MCP 服务';
  $('mcpResult').textContent = '';
  updateMCPTypeFields();
}

function updateMCPTypeFields() {
  const stdio = $('mcpType').value === 'stdio';
  $('mcpUrlRow').hidden = stdio;
  $('mcpCommandRow').hidden = !stdio;
  $('mcpArgsRow').hidden = !stdio;
  $('mcpEnvRow').hidden = !stdio;
}

function editMCPServer(server) {
  $('mcpId').value = server.id || '';
  $('mcpName').value = server.name || '';
  $('mcpType').value = server.type || 'http';
  $('mcpUrl').value = server.url || '';
  $('mcpCommand').value = server.command || '';
  $('mcpArgs').value = JSON.stringify(server.args || [], null, 2);
  $('mcpEnv').value = JSON.stringify(server.env || {}, null, 2);
  $('mcpHeaders').value = JSON.stringify(server.headers || {}, null, 2);
  $('mcpApproval').value = server.approval || 'confirm';
  $('mcpEnabled').checked = Boolean(server.enabled);
  $('mcpEditorTitle').textContent = '编辑 MCP 服务';
  $('mcpResult').textContent = '';
  updateMCPTypeFields();
}

async function refreshMCPServers() {
  const list = $('mcpServerList');
  list.replaceChildren();
  try {
    const servers = await api('/api/mcp/servers');
    if (!servers.length) {
      const empty = document.createElement('p');
      empty.textContent = '尚未添加 MCP 服务。';
      list.appendChild(empty);
    }
    for (const server of servers) {
      const card = document.createElement('section');
      card.className = 'plugin-card';
      const title = document.createElement('strong');
      title.textContent = server.name;
      const status = document.createElement('p');
      status.textContent = server.type.toUpperCase() + ' · ' + (server.enabled ? '已启用' : '已停用')
        + ' · ' + (server.approval === 'auto' ? '自动调用' : '调用前确认');
      const edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = '编辑';
      edit.addEventListener('click', () => editMCPServer(server));
      const discover = document.createElement('button');
      discover.type = 'button'; discover.textContent = '发现工具';
      discover.addEventListener('click', async () => {
        try {
          const result = await api('/api/mcp/servers/' + encodeURIComponent(server.id) + '/discover', { method: 'POST' });
          showToast('发现 ' + result.tools.length + ' 个工具', 'success');
        } catch (error) { showToast(error.message, 'warning'); }
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!window.confirm('确定删除 MCP 服务“' + server.name + '”？')) return;
        try {
          await api('/api/mcp/servers/' + encodeURIComponent(server.id), { method: 'DELETE' });
          await refreshMCPServers();
          showToast('MCP 服务已删除', 'success');
        } catch (error) { showToast(error.message, 'warning'); }
      });
      card.append(title, status, edit, discover, remove);
      list.appendChild(card);
    }
  } catch (error) {
    const message = document.createElement('p');
    message.textContent = '加载 MCP 服务失败：' + error.message;
    list.appendChild(message);
  }
}

async function openMCPManager() {
  resetMCPForm();
  await refreshMCPServers();
  $('mcpManager').showModal();
}

async function saveMCPServer() {
  const output = $('mcpResult');
  try {
    const body = {
      id: $('mcpId').value || undefined,
      name: $('mcpName').value.trim(),
      type: $('mcpType').value,
      url: $('mcpUrl').value.trim(),
      command: $('mcpCommand').value.trim(),
      args: parseJSONArray($('mcpArgs').value, '启动参数'),
      env: parseJSONField($('mcpEnv').value, '环境变量'),
      headers: parseJSONField($('mcpHeaders').value, 'Headers'),
      approval: $('mcpApproval').value,
      enabled: $('mcpEnabled').checked
    };
    const result = await api('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    output.textContent = '已保存：' + result.server.name;
    await refreshMCPServers();
    resetMCPForm();
    showToast('MCP 服务已保存', 'success');
  } catch (error) {
    output.textContent = error.message;
    showToast(error.message, 'warning');
  }
}

function closeSidebarOnMobile() {
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.body.classList.remove('sidebar-open');
  }
}

$('newChat').addEventListener('click', () => {
  createChat();
  closeSidebarOnMobile();
});
$('composer').addEventListener('submit', sendMessage);
$('stop').addEventListener('click', () => {
  if (state.controller) state.controller.abort();
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
$('prompt').addEventListener('input', event => {
  event.target.style.height = 'auto';
  event.target.style.height = Math.min(event.target.scrollHeight, 200) + 'px';
});

$('settingsBtn').addEventListener('click', openSettings);
$('profileBtn').addEventListener('click', openSettings);
$('pluginsBtn').addEventListener('click', openMCPManager);
$('mcpType').addEventListener('change', updateMCPTypeFields);
$('mcpReset').addEventListener('click', resetMCPForm);
$('mcpSave').addEventListener('click', saveMCPServer);
$('statusBtn').addEventListener('click', async () => {
  try {
    $('statusInfo').textContent = JSON.stringify(await api('/health'), null, 2);
  } catch (error) {
    $('statusInfo').textContent = error.message;
  }
  $('statusDialog').showModal();
});
$('themeBtn').addEventListener('click', () => {
  document.body.classList.toggle('light');
  localStorage.setItem(
    'node-ai-web-theme',
    document.body.classList.contains('light') ? 'light' : 'dark'
  );
});
$('collapseSidebar').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
});
$('mobileMenu').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});
$('mobileMenuTop').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});
$('modelSelect').addEventListener('change', () => {
  $('modelSelect').title = $('modelSelect').value
    || state.config.model
    || '默认模型';
});
$('thinkingBtn').addEventListener('click', () => {
  state.thinking = !state.thinking;
  const chat = currentChat();
  if (chat) chat.thinking = state.thinking;
  updateThinkingButton();
  saveHistory();
});
$('attachBtn').addEventListener('click', () => {
  showToast('附件上传暂未接入；此按钮目前保留为工具入口。', 'info');
});
$('providerPreset').addEventListener('change', () => {
  const presets = {
    custom: { url: '', model: '' },
    openai: { url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    anthropic: { url: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
    openrouter: { url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    siliconflow: { url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    ollama: { url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' }
  };
  const preset = presets[$('providerPreset').value];
  if (!preset) return;
  if (preset.url) $('baseURL').value = preset.url;
  if (preset.model) $('model').value = preset.model;
  showToast('已填入预设地址和模型；请检查后保存。', 'info');
});
$('saveSettings').addEventListener('click', saveSettings);
$('testConnection').addEventListener('click', testConnection);
$('refreshModels').addEventListener('click', async () => {
  await loadModels();
  $('settingsResult').textContent = '已尝试读取模型列表。';
});
document.querySelectorAll('.close-modal').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

if (localStorage.getItem('node-ai-web-theme') === 'light') {
  document.body.classList.add('light');
} else {
  document.body.classList.remove('light');
}

(async function initialize() {
  try {
    const history = await api('/api/history');
    state.chats = Array.isArray(history) ? history : [];
  } catch (_) {
    try {
      state.chats = JSON.parse(localStorage.getItem('node-ai-web-history') || '[]');
    } catch (_) {
      state.chats = [];
    }
  }

  state.chats = state.chats
    .filter(chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages))
    .map(chat => Object.assign({
      title: '新对话',
      updatedAt: Date.now(),
      thinking: false
    }, chat));

  if (state.chats.length) {
    state.activeChatId = state.chats
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }

  renderHistory();
  renderMessages();
  await loadSettings();
  await loadModels();
})();
