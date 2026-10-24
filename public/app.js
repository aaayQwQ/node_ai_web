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

function renderMarkdown(value) {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];

  let text = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({
      language: escapeHTML(language.trim()),
      code: escapeHTML(code.replace(/\n$/, ''))
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
        + '<code>' + code.code + '</code></pre>';
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

    return '<p>' + renderInlineMarkdown(trimmed).replace(/\n/g, '<br>') + '</p>';
  });

  return blocks.join('');
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
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = chat.title || '新对话';
    button.title = '点击打开；右键重命名';
    button.className = chat.id === state.activeChatId ? 'active' : '';
    button.addEventListener('click', () => {
      state.activeChatId = chat.id;
      state.thinking = Boolean(chat.thinking);
      updateThinkingButton();
      renderHistory();
      renderMessages();
      closeSidebarOnMobile();
    });
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      const title = window.prompt('重命名对话', chat.title || '新对话');
      if (title === null) return;
      chat.title = title.trim() || '新对话';
      saveHistory();
      renderHistory();
      renderMessages();
    });
    list.appendChild(button);
  }
}

function renderMessages() {
  const container = $('messages');
  container.replaceChildren();

  const chat = currentChat();
  if (!chat || chat.messages.length === 0) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.innerHTML = '<div class="welcome-mark">◈</div>'
      + '<h1>有什么可以帮忙？</h1>'
      + '<p>输入问题，开始一段新的对话。</p>';
    container.appendChild(welcome);
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
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = '◈';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = renderMarkdown(message.content || '');

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
    $('webPassword').value = '';
    $('webPassword').placeholder = '留空则保留当前密码';
    setConnectionStatus('已连接本地服务', 'online');
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

      if (delta && typeof delta.content === 'string') {
        assistantMessage.content += delta.content;
      } else if (delta && Array.isArray(delta.content)) {
        for (const item of delta.content) {
          if (item && item.type === 'text' && item.text) {
            assistantMessage.content += item.text;
          }
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

  if (!currentChat()) createChat();

  const chat = currentChat();
  chat.messages.push({ role: 'user', content });
  chat.title = chat.messages.filter(message => message.role === 'user').length === 1
    ? content.slice(0, 36)
    : chat.title;
  chat.updatedAt = Date.now();
  chat.thinking = state.thinking;

  input.value = '';
  input.style.height = 'auto';

  const assistant = { role: 'assistant', content: '' };
  chat.messages.push(assistant);

  renderHistory();
  renderMessages();
  saveHistory();

  state.controller = new AbortController();
  $('send').disabled = true;
  $('stop').hidden = false;
  input.disabled = true;

  const payload = {
    model: $('modelSelect').value || state.config.model,
    messages: chat.messages
      .filter(message => message.content !== '' || message.role !== 'assistant')
      .map(message => ({ role: message.role, content: message.content })),
    stream: true
  };

  if (state.thinking) {
    payload.reasoning_effort = 'high';
  }

  try {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: requestHeaders({ 'Content-Type': 'application/json' }),
      signal: state.controller.signal,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;

      try {
        const data = JSON.parse(text);
        message = data.error && data.error.message ? data.error.message : text;
      } catch (_) {}

      throw new Error(message || ('HTTP ' + response.status));
    }

    if (!response.body) {
      throw new Error('浏览器没有提供流式响应读取接口。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    while (true) {
      const result = await reader.read();
      if (result.done) break;

      pending += decoder.decode(result.value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop();

      for (const eventText of events) {
        parseSSEChunk(eventText, assistant);
      }

      renderMessages();
    }

    pending += decoder.decode();
    if (pending.trim()) parseSSEChunk(pending, assistant);

    if (!assistant.content) {
      assistant.content = '（服务已响应，但没有返回可显示的文本内容。）';
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!assistant.content) assistant.content = '已停止生成。';
    } else {
      assistant.content = '请求失败：' + error.message;
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
  const body = {
    baseURL: $('baseURL').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    systemPrompt: $('systemPrompt').value,
    temperature: Number($('temperature').value),
    webPassword: $('webPassword').value
  };

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

$('settingsBtn').addEventListener('click', () => {
  $('settingsResult').textContent = '';
  $('settings').showModal();
});
$('profileBtn').addEventListener('click', () => {
  $('settingsResult').textContent = '';
  $('settings').showModal();
});
$('pluginsBtn').addEventListener('click', openPlugins);
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
  window.alert('当前版本暂不支持上传附件。');
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
