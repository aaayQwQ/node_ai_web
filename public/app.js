'use strict';

const $ = id => document.getElementById(id);

const state = {
  config: {},
  connectionStatus: { message: '正在连接', kind: 'offline' },
  chats: [],
  activeChatId: null,
  controller: null,
  thinking: false,
  thinkingLevel: 'high',
  auth: localStorage.getItem('node-ai-web-password') || '',
  nextChatId: 1,
  providerModels: []
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
    let data = null;
    try { data = JSON.parse(message); } catch (_) {}
    if (data && data.error && data.error.code === 'approval_required' && data.error.approval_id) {
      const approvalError = new Error(data.error.message || '需要确认 MCP 工具调用。');
      approvalError.approvalId = data.error.approval_id;
      throw approvalError;
    }
    if (data && data.error && data.error.message) message = data.error.message;
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
  const lines = source.split('\n');
  const codeBlocks = [];
  const textLines = [];
  let index = 0;
  while (index < lines.length) {
    const opening = lines[index].match(/^ {0,3}(```+|~~~+)[ \t]*([^ \t]*)[^\n]*$/);
    if (!opening) { textLines.push(lines[index++]); continue; }
    const fence = opening[1], language = (opening[2] || '').trim();
    index++;
    const codeLines = [];
    let closed = false;
    while (index < lines.length) {
      const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        closed = true; index++; break;
      }
      codeLines.push(lines[index++]);
    }
    const blockIndex = codeBlocks.length;
    codeBlocks.push({ language, code: codeLines.join('\n').replace(/\n$/, '') });
    textLines.push('', '@@CODE_BLOCK_' + blockIndex + '@@', '');
    if (!closed) break;
  }
  const blocks = textLines.join('\n').split(/\n{2,}/).map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    const codeMatch = trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (codeMatch) {
      const code = codeBlocks[Number(codeMatch[1])];
      return '<section class="markdown-code-block"><div class="code-toolbar"><span class="code-language">'
        + escapeHTML(code.language || 'TEXT') + '</span><button type="button" class="copy-code">复制</button></div>'
        + '<pre><code>' + highlightCode(code.code, code.language) + '</code></pre></section>';
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      const heading = trimmed.match(/^(#{1,6})\s+([\s\S]+)$/), level = heading[1].length;
      return '<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>';
    }
    const lines = trimmed.split('\n');
    if (lines.every(line => /^\s*[-*+]\s+/.test(line)))
      return '<ul>' + lines.map(line => '<li>' + renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, '')) + '</li>').join('') + '</ul>';
    if (lines.every(line => /^\s*\d+\.\s+/.test(line)))
      return '<ol>' + lines.map(line => '<li>' + renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, '')) + '</li>').join('') + '</ol>';
    if (lines.length >= 2 && lines.every(line => /^\s*\|.*\|\s*$/.test(line))) {
      const cells = lines.map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
      const hasSeparator = cells.length > 1 && cells[1].every(cell => /^:?-{3,}:?$/.test(cell));
      const headers = cells[0], rows = cells.slice(hasSeparator ? 2 : 1);
      return '<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>'
        + headers.map(cell => '<th>' + renderInlineMarkdown(cell) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(row => '<tr>' + headers.map((_, i) => '<td>' + renderInlineMarkdown(row[i] || '') + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>';
    }
    if (lines.every(line => /^\s*>/.test(line)))
      return '<blockquote>' + lines.map(line => renderInlineMarkdown(line.replace(/^\s*>\s?/, ''))).join('<br>') + '</blockquote>';
    return '<p>' + renderInlineMarkdown(trimmed).replace(/\n/g, '<br>') + '</p>';
  });
  return blocks.join('');
}
function renderAssistantHTML(message) {
  // Only render user-facing answer text. No reasoning, tool status, or interim narration.
  return (message.content ? renderMarkdown(message.content) : '')
    + (message.error ? '<div class="message-inline-error">' + escapeHTML(message.error) + '</div>' : '')
    + (message.stopped ? '<div class="message-stopped">已停止生成</div>' : '');
}
function bindCopyButtons(container) {
  container.querySelectorAll('.copy-code').forEach(button => {
    button.addEventListener('click', async () => {
      const code = button.closest('.markdown-code-block').querySelector('code').innerText;
      try { await navigator.clipboard.writeText(code); button.textContent = '已复制'; }
      catch (_) { button.textContent = '复制失败'; }
      window.setTimeout(() => { button.textContent = '复制'; }, 1400);
    });
  });
}
function renderStreamingMessage(message) {
  const rows = $('messages').querySelectorAll('.message.assistant');
  const row = rows[rows.length - 1];
  if (!row) return;
  const bubble = row.querySelector('.bubble');
  if (!bubble) return;
  bubble.innerHTML = renderAssistantHTML(message);
  bindCopyButtons(bubble);
  const container = $('messages');
  container.scrollTop = container.scrollHeight;
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

function openGeneralSettings() {
  $('settingsResult').textContent = '';
  $('settings').showModal();
}

function openSettingsHub() {
  $('settingsHub').showModal();
  closeSidebarOnMobile();
}

async function openRuntimeStatus() {
  const providerCount = (state.config.providers || []).filter(item => item && item.baseURL && item.apiKeySet).length;
  const modelCount = (state.config.selectedModels || []).filter(item => item && item.enabled !== false).length;
  const selected = $('modelSelect').selectedOptions[0]?.textContent || '尚未选择';
  $('runtimeLocal').textContent = state.connectionStatus.kind === 'offline' ? '连接异常' : '本地服务已连接';
  $('runtimeLocalDetail').textContent = state.connectionStatus.message || '等待状态更新';
  $('runtimeApi').textContent = providerCount ? providerCount + ' 个已配置服务商' : (state.config.baseURL && state.config.apiKeySet ? '默认 API 已配置' : '尚未配置 API');
  $('runtimeModels').textContent = modelCount + ' 个已启用模型';
  $('runtimeSelectedModel').textContent = selected;
  $('runtimeMcp').textContent = '正在读取…';
  $('runtimeUpdated').textContent = new Date().toLocaleString();
  $('runtimeStatus').showModal();
  try {
    const servers = await api('/api/mcp/servers');
    $('runtimeMcp').textContent = Array.isArray(servers) ? servers.filter(item => item && item.enabled).length + ' 个已启用服务' : '暂不可用';
  } catch (error) {
    $('runtimeMcp').textContent = '读取失败：' + error.message;
  }
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
    thinking: false,
    thinkingLevel: state.thinkingLevel || 'high'
  };
  state.thinking = false;

  state.chats.push(chat);
  state.activeChatId = chat.id;
  saveHistory();
  renderHistory();
  renderMessages();
  $('prompt').focus();
}

let historySaveQueue = Promise.resolve();
let historySaveVersion = 0;
function saveHistory() {
  const snapshot = JSON.stringify(state.chats);
  const version = ++historySaveVersion;
  try { localStorage.setItem('node-ai-web-history', snapshot); }
  catch (_) { showToast('浏览器存储空间不足，历史记录可能无法完整保存。', 'warning'); }
  // Serialize writes: an older, slower POST must not overwrite a newer snapshot.
  historySaveQueue = historySaveQueue.catch(() => {}).then(() => api('/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: snapshot
  })).catch(error => {
    console.warn('保存历史失败：', error.message);
    if (version === historySaveVersion) showToast('历史记录未能同步到本地服务；浏览器副本仍已保留。', 'warning');
  });
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
      state.thinkingLevel = ['low', 'medium', 'high'].includes(chat.thinkingLevel) ? chat.thinkingLevel : 'high';
      updateThinkingButton();
      renderHistory();
      renderMessages();
      closeSidebarOnMobile();
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'history-more';
    more.textContent = '⋮';
    more.title = '对话菜单';
    more.setAttribute('aria-label', '对话菜单');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'history-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'history-menu-item';
    rename.textContent = '重命名';
    rename.setAttribute('role', 'menuitem');
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
    remove.className = 'history-menu-item history-menu-delete';
    remove.textContent = '删除';
    remove.setAttribute('role', 'menuitem');
    remove.addEventListener('click', event => {
      event.stopPropagation();
      if (!window.confirm('确定删除对话“' + (chat.title || '新对话') + '”？此操作不可撤销。')) return;
      const index = state.chats.findIndex(entry => entry.id === chat.id);
      if (index >= 0) state.chats.splice(index, 1);
      if (state.activeChatId === chat.id) {
        if (state.controller) state.controller.abort();
        state.activeChatId = null;
        state.thinking = false;
        const next = state.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) {
          state.activeChatId = next.id;
          state.thinking = Boolean(next.thinking);
        }
        updateThinkingButton();
      }
      saveHistory();
      renderHistory();
      renderMessages();
    });

    menu.append(rename, remove);
    more.addEventListener('click', event => {
      event.stopPropagation();
      const shouldOpen = menu.hidden;
      list.querySelectorAll('.history-menu').forEach(other => { other.hidden = true; });
      list.querySelectorAll('.history-more').forEach(button => button.setAttribute('aria-expanded', 'false'));
      menu.hidden = !shouldOpen;
      more.setAttribute('aria-expanded', String(shouldOpen));
    });

    item.append(open, more, menu);
    list.appendChild(item);
  }
}
function getWelcomeCopy() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) {
    return { title: '早上好，今天想先处理什么？', description: '把问题、代码，或者一个还没成形的想法放在这里。' };
  }
  if (hour >= 11 && hour < 18) {
    return { title: '有什么新想法？', description: '从一个问题开始。我们可以一起梳理思路、写代码，或把复杂的事讲清楚。' };
  }
  if (hour >= 18 && hour < 23) {
    return { title: '晚上好，想从哪里开始？', description: '不用先把问题想完整，先写下来，再一步步理清。' };
  }
  return { title: '还在探索什么？', description: '先把想法放下来。无论是一个小问题，还是一件复杂的事，都可以从这里开始。' };
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
      + '<h1>' + (configured ? getWelcomeCopy().title : '先连接你的模型，<br>再开始对话。') + '</h1>'
      + '<p class="welcome-description">' + (configured ? getWelcomeCopy().description : '这是你的私人 AI 工作区。配置兼容 OpenAI 的 API 地址与密钥，即可开始使用。密钥由本地服务保存。') + '</p>'
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
    if (setupButton) setupButton.addEventListener('click', openProviders);
    $('modelSelect').title = state.config.model || '模型 / 服务商';
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
      // MCP results are context for the model, never standalone chat messages.
      continue;
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = '◈';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = renderAssistantHTML(message);

      row.append(avatar, bubble);
    }

    container.appendChild(row);
  }

  container.scrollTop = container.scrollHeight;

  bindCopyButtons(container);

  container.scrollTop = container.scrollHeight;
  $('modelSelect').title = $('modelSelect').selectedOptions[0]?.textContent || '模型 / 服务商';
  updateThinkingButton();
  if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
    try {
      window.MathJax.typesetClear([container]);
      window.MathJax.typesetPromise([container]).catch(() => {});
    } catch (_) {}
  }
}

function setConnectionStatus(message, status) {
  state.connectionStatus = { message, kind: status };
  const label = $('status');
  const dot = $('connectionDot');
  if (label) label.textContent = message;
  if (dot) {
    dot.classList.toggle('online', status === 'online');
    dot.classList.toggle('offline', status === 'offline');
  }
}

async function loadSettings() {
  try {
    state.config = await api('/api/config');
    $('systemPrompt').value = state.config.systemPrompt || '';
    $('temperature').value = state.config.temperature ?? 0.7;
    $('topP').value = state.config.topP ?? 1;
    $('maxTokens').value = state.config.maxTokens ?? 4096;
    $('contextWindow').value = state.config.contextWindow ?? 20;
    $('mcpAutoApprove').checked = state.config.mcpAutoApprove === true;
    $('webPassword').value = '';
    $('webPassword').placeholder = '留空则保留当前密码';
    setConnectionStatus('本地服务已就绪', 'online');
    const ready = Boolean((state.config.baseURL && state.config.apiKeySet) || (state.config.providers || []).some(provider => provider.baseURL && provider.apiKeySet));
    document.body.classList.toggle('needs-api-config', !ready);
    if (!ready) setConnectionStatus('需要配置 API', 'offline');
    renderMessages();
  } catch (error) {
    setConnectionStatus('本地服务连接失败', 'offline');
    console.error(error);
  }
}

async function loadModels() {
  const select = $('modelSelect');
  const selected = select.value || '';
  const providers = Array.isArray(state.config.providers) ? state.config.providers : [];
  const enabled = Array.isArray(state.config.selectedModels)
    ? state.config.selectedModels.filter(item => item && item.enabled !== false)
    : [];
  select.replaceChildren(new Option('选择模型', ''));
  for (const item of enabled) {
    const provider = providers.find(entry => entry.id === item.providerId && entry.baseURL && entry.apiKeySet);
    if (!provider || !item.modelId) continue;
    const value = provider.id + '::' + item.modelId;
    select.add(new Option(item.modelId + ' / ' + provider.name, value));
  }

  // 已配置服务商模型时，默认选中第一个，避免聊天请求退回空的全局配置。
  const availableValues = Array.from(select.options).slice(1).map(option => option.value);
  if (selected && availableValues.includes(selected)) {
    select.value = selected;
  } else if (availableValues.length) {
    select.value = availableValues[0];
  } else {
    select.value = '';
  }
  select.title = select.selectedOptions[0]?.textContent || '模型 / 服务商';
}
function updateThinkingButton() {
  const button = $('thinkingBtn');
  if (!button) return;
  const enabled = Boolean(state.thinking);
  const level = ['low', 'medium', 'high'].includes(state.thinkingLevel) ? state.thinkingLevel : 'high';
  state.thinkingLevel = level;
  button.classList.toggle('thinking-active', enabled);
  button.dataset.enabled = String(enabled);
  button.title = enabled ? '思考模式已开启 · ' + ({ low: '轻量', medium: '标准', high: '深度' }[level]) + '等级' : '思考模式已关闭';
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', enabled ? '关闭思考模式' : '开启思考模式');
  const label = button.querySelector('[data-thinking-label]');
  if (label) label.textContent = enabled ? '思考已开启' : '思考已关闭';
  const symbol = button.querySelector('.thinking-symbol');
  if (symbol) symbol.textContent = enabled ? '✓' : '◉';
  const levelSelect = $('thinkingLevel');
  if (levelSelect) {
    levelSelect.value = level;
    levelSelect.disabled = !enabled;
    levelSelect.title = enabled ? '选择思考等级' : '开启思考模式后选择等级';
  }
}

function buildContextMessages(messages, maxTurns) {
  const turns = [];
  let current = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      if (current.length) turns.push(current);
      current = [message];
    } else if (current.length) {
      current.push(message);
    }
  }
  if (current.length) turns.push(current);

  const limit = Math.max(1, Math.floor(Number(maxTurns) || 20));
  const selectedTurns = turns.slice(-limit);
  const context = [];

  for (const turn of selectedTurns) {
    const toolCallIds = new Set();
    const completedToolCallIds = new Set();
    const validMessages = [];

    for (const message of turn) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const ids = message.tool_calls
          .map(call => call && call.id)
          .filter(id => typeof id === 'string' && id);
        const results = turn.filter(item =>
          item.role === 'tool' && ids.includes(item.tool_call_id)
        );
        const complete = ids.length === message.tool_calls.length &&
          ids.every(id => results.some(item => item.tool_call_id === id));

        if (!complete) continue;
        ids.forEach(id => toolCallIds.add(id));
        validMessages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.tool_calls
        });
        continue;
      }

      if (message.role === 'tool') {
        if (!toolCallIds.has(message.tool_call_id) || completedToolCallIds.has(message.tool_call_id)) continue;
        completedToolCallIds.add(message.tool_call_id);
        validMessages.push({
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content || ''
        });
        continue;
      }

      if (message.role === 'assistant') {
        if (message.content || message.reasoning) {
          validMessages.push({ role: 'assistant', content: message.content || '' });
        }
        continue;
      }

      if (message.role === 'user') {
        validMessages.push({ role: 'user', content: message.content || '' });
      }
    }

    context.push(...validMessages);
  }

  return context;
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

  const selectedModel = $('modelSelect').value || '';
  const hasSelectedProviderModel = selectedModel.includes('::')
    && (state.config.providers || []).some(provider =>
      provider.id === selectedModel.slice(0, selectedModel.indexOf('::'))
      && provider.baseURL && provider.apiKeySet
    );
  const hasDefaultProvider = Boolean(state.config.baseURL && state.config.apiKeySet);

  if (!hasSelectedProviderModel && !hasDefaultProvider) {
    const hasConfiguredProviders = (state.config.providers || []).some(provider =>
      provider.baseURL && provider.apiKeySet
    );
    showToast(
      hasConfiguredProviders
        ? '服务商已保存，但还没有可用模型。请进入“连接设置 → 服务商与模型”，读取模型并勾选保存。'
        : '请先在“连接设置”中添加服务商，并保存至少一个可用模型。',
      'warning'
    );
    openProviders();
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
    try { mcpTools = await api('/api/mcp/tools', { signal: state.controller.signal }); }
    catch (error) { showToast('读取 MCP 工具失败：' + error.message, 'warning'); }
    const toolLookup = new Map(mcpTools.map(tool => [tool.function.name, tool]));
    let round = 0;
    let continueTools = true;

    // 每轮把全部 MCP 工具定义一次性提供给模型；同一响应中的多个工具调用并行执行。
    // 最多允许 20 轮真正的工具调用，之后追加一轮禁用工具的总结请求，避免把轮数上限错误地显示成最终答案。
    const MAX_TOOL_ROUNDS = 20;
    while (continueTools && round <= MAX_TOOL_ROUNDS) {
      round++;
      const finalSummaryTurn = round > MAX_TOOL_ROUNDS;
      const maxTurns = Number(state.config.contextWindow) || 20;
      const contextMessages = buildContextMessages(chat.messages, maxTurns);

      const payload = {
        model: $('modelSelect').value || state.config.model,
        messages: contextMessages,
        stream: true,
        temperature: Number(state.config.temperature ?? 0.7),
        top_p: Number(state.config.topP ?? 1),
        max_tokens: Number(state.config.maxTokens ?? 4096)
      };
      if (state.thinking) payload.reasoning_effort = state.thinkingLevel || 'high';
      if (mcpTools.length && !finalSummaryTurn) {
        payload.tools = mcpTools.map(tool => ({ type: 'function', function: tool.function }));
      } else if (finalSummaryTurn) {
        payload.tool_choice = 'none';
      }
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
        renderStreamingMessage(assistant);
      }
      pending += decoder.decode();
      if (pending.trim()) parseSSEChunk(pending, assistant);
      renderStreamingMessage(assistant);

      const toolCalls = (assistant.tool_calls || []).filter(call => call && call.function && call.function.name);
      if (!toolCalls.length) {
        continueTools = false;
        break;
      }
      if (finalSummaryTurn) {
        assistant.content = '本轮未能生成完整回复，请重新发送问题。';
        continueTools = false;
        break;
      }
      assistant.tool_calls = toolCalls;
      assistant.content = assistant.content || '';
      renderMessages();
      const pendingCalls = toolCalls.map(async call => {
        try {
          const registered = toolLookup.get(call.function.name);
          if (!registered) throw new Error('Requested tool is not registered.');
          if (state.controller.signal.aborted) {
            const abortError = new Error('Generation stopped.');
            abortError.name = 'AbortError';
            throw abortError;
          }
          const args = JSON.parse(call.function.arguments || '{}');
          const callOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: state.controller.signal,
            body: JSON.stringify({ name: call.function.name, arguments: args })
          };
          let result;
          try {
            result = await api('/api/mcp/call', callOptions);
          } catch (error) {
            if (!error.approvalId) throw error;
            const approved = window.confirm(
              '模型请求调用一个需要确认的 MCP 工具：\n\n'
              + registered.serverName + ' / ' + registered.originalName
              + '\n\n参数：\n' + JSON.stringify(args, null, 2)
              + '\n\n仅在确认工具和参数可信时允许执行。'
            );
            const decision = await api('/api/mcp/approvals/' + encodeURIComponent(error.approvalId), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: state.controller.signal,
              body: JSON.stringify({ approved })
            });
            if (!approved || decision.approved === false) {
              return { role: 'tool', tool_call_id: call.id, content: 'Tool execution was declined by the user.' };
            }
            result = decision;
          }
          return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.result) };
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          // Return execution errors to the model so it can decide how to proceed,
          // instead of exposing raw tool output or stack details in the conversation.
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'Tool execution failed.', detail: error.message })
          };
        }
      });
      // 同一轮模型同时请求的工具并发执行，全部完成后一次性把结果交还模型。
      const toolResults = await Promise.all(pendingCalls);
      chat.messages.push(...toolResults);
      assistant = { role: 'assistant', content: '', reasoning: '' };
      chat.messages.push(assistant);
      saveHistory();
    }
    if (!assistant.content && !assistant.reasoning) {
      assistant.content = '（服务已响应，但没有返回可显示的文本内容。）';
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!assistant.content && !assistant.reasoning) assistant.content = '已停止生成。';
      else assistant.stopped = true;
    } else {
      const detail = '这次请求未能完成。请检查模型服务商配置和网络连接后重试。';
      if (assistant.content || assistant.reasoning) assistant.error = detail;
      else assistant.content = detail;
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
    providers: Array.isArray(state.config.providers) ? state.config.providers : [],
    selectedModels: Array.isArray(state.config.selectedModels) ? state.config.selectedModels : [],
    systemPrompt: $('systemPrompt').value,
    temperature: Number($('temperature').value),
    topP: Number($('topP').value),
    maxTokens: Number($('maxTokens').value),
    contextWindow: Number($('contextWindow').value),
    mcpAutoApprove: $('mcpAutoApprove').checked,
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

    $('webPassword').value = '';
    await loadSettings();
    await loadModels();
    $('settingsResult').textContent = '设置已保存。';
    showToast('通用设置已保存。', 'success');
    $('settings').close();
    openSettingsHub();
    renderMessages();
  } catch (error) {
    $('settingsResult').textContent = '保存失败：' + error.message;
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

function showMCPList() {
  $('mcpEditor').hidden = true;
  $('mcpServerList').hidden = false;
  $('mcpAddTop').hidden = false;
}
function showMCPEditor() {
  $('mcpEditor').hidden = false;
  $('mcpServerList').hidden = true;
  $('mcpAddTop').hidden = true;
  $('mcpEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  $('mcpToken').value = '';
  $('mcpApproval').value = 'confirm';
  $('mcpEnabled').checked = true;
  $('mcpEditorTitle').textContent = '添加 MCP 服务';
  $('mcpResult').textContent = '';
  updateMCPTypeFields();
}

function updateMCPTypeFields() {
  const stdio = $('mcpType').value === 'stdio';
  const websocket = $('mcpType').value === 'websocket';
  $('mcpUrlRow').hidden = stdio;
  $('mcpUrl').placeholder = websocket ? 'ws://127.0.0.1:3000/mcp 或 wss://example.com/mcp' : $('mcpType').value === 'sse' ? 'https://example.com/sse' : 'http://127.0.0.1:3000/mcp';
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
  // Secret headers are masked by the API. Keep this blank unless the user wants to replace the token.
  $('mcpToken').value = '';
  $('mcpApproval').value = server.approval || 'confirm';
  $('mcpEnabled').checked = Boolean(server.enabled);
  $('mcpEditorTitle').textContent = '编辑 MCP 服务';
  $('mcpResult').textContent = '';
  updateMCPTypeFields();
  showMCPEditor();
}

async function refreshMCPServers() {
  const list = $('mcpServerList');
  list.replaceChildren();
  try {
    const servers = await api('/api/mcp/servers');
    if (!servers.length) {
      list.hidden = false;
      $('mcpAddTop').hidden = false;
    }
    for (const server of servers) {
      const card = document.createElement('section');
      card.className = 'plugin-card';
      const title = document.createElement('strong');
      title.textContent = server.name;
      const status = document.createElement('p');
      status.className = 'mcp-server-status';
      status.textContent = server.type.toUpperCase() + ' · ' + (server.enabled ? '已启用' : '已停用')
        + ' · ' + (server.approval === 'auto' ? '自动调用' : '调用前确认');
      const toolSummary = document.createElement('small');
      toolSummary.className = 'mcp-tool-summary';
      toolSummary.textContent = '工具列表尚未刷新';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = '编辑';
      edit.addEventListener('click', () => editMCPServer(server));
      const discover = document.createElement('button');
      discover.type = 'button'; discover.textContent = '测试 / 刷新工具';
      discover.addEventListener('click', async () => {
        try {
          discover.disabled = true;
          discover.textContent = '检查中…';
          const result = await api('/api/mcp/servers/' + encodeURIComponent(server.id) + '/discover', { method: 'POST' });
          const tools = Array.isArray(result.tools) ? result.tools : [];
          toolSummary.textContent = tools.length
            ? '工具（' + tools.length + '）：' + tools.map(tool => tool.name || '未命名工具').join('、')
            : '连接成功，但服务器未公布工具';
          status.textContent = server.type.toUpperCase() + ' · 连接正常 · ' + (server.enabled ? '已启用' : '已停用');
          showToast('连接成功，发现 ' + tools.length + ' 个工具', 'success');
        } catch (error) {
          const rawMessage = String(error.message || '未知错误');
          const authFailure = /(?:HTTP 401|HTTP 403|unauthorized|invalid or missing token|invalid token|missing token)/i.test(rawMessage);
          toolSummary.textContent = authFailure
            ? '连接失败：服务端拒绝认证。请编辑服务并填写访问 Token；默认发送 Authorization: Bearer Token。若服务要求 X-API-Key 等自定义头，请配置 Headers。原始错误：' + rawMessage
            : '连接失败：' + rawMessage;
          status.textContent = server.type.toUpperCase() + (authFailure ? ' · 需要认证 Token' : ' · 连接失败');
          showToast(authFailure ? 'MCP 认证失败，请检查 Token / Headers' : rawMessage, 'warning');
        } finally {
          discover.disabled = false;
          discover.textContent = '测试 / 刷新工具';
        }
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
      card.append(title, status, toolSummary, document.createElement('br'), edit, discover, remove);
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
  showMCPList();
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
    const mcpToken = $('mcpToken').value.trim();
    if (mcpToken) {
      body.headers.Authorization = 'Bearer ' + mcpToken;
    }
    const result = await api('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    output.textContent = '已保存：' + result.server.name;
    await refreshMCPServers();
    resetMCPForm();
    showMCPList();
    showToast('MCP 服务已保存', 'success');
  } catch (error) {
    output.textContent = error.message;
    showToast(error.message, 'warning');
  }
}


function providerDefaults() {
  return Array.isArray(state.config.providers) ? state.config.providers : [];
}
function showProviderList() {
  $('providerEditor').hidden = true;
  $('providerListPane').hidden = false;
  $('providerAddTop').hidden = false;
}
function showProviderEditor() {
  $('providerEditor').hidden = false;
  $('providerListPane').hidden = true;
  $('providerAddTop').hidden = true;
  $('providerEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetProviderForm() {
  $('providerId').value = '';
  $('providerName').value = '';
  $('providerBaseURL').value = '';
  $('providerApiKey').value = '';
  $('providerApiKey').placeholder = '粘贴 API Key';
  $('providerHeaders').value = '{}';
  $('providerEditorTitle').textContent = '添加服务商';
  $('providerResult').textContent = '';
  $('providerModels').replaceChildren();
  $('providerManualModel').value = '';
  $('providerModelCount').textContent = '尚未添加';
}
function editProvider(provider) {
  $('providerId').value = provider.id;
  $('providerName').value = provider.name || '';
  $('providerBaseURL').value = provider.baseURL || '';
  $('providerApiKey').value = '';
  $('providerApiKey').placeholder = provider.apiKeySet ? '密钥已保存；留空保留现有密钥' : '粘贴 API Key';
  $('providerHeaders').value = JSON.stringify(provider.customHeaders || {}, null, 2);
  $('providerEditorTitle').textContent = '编辑服务商：' + (provider.name || '');
  $('providerResult').textContent = '';
  $('providerModels').replaceChildren();
  $('providerManualModel').value = '';
  const savedModels = (state.config.selectedModels || []).filter(item => item.providerId === provider.id && item.enabled !== false);
  for (const item of savedModels) addProviderModelOption(item.modelId, true);
  updateProviderModelCount();
  showProviderEditor();
}
function renderProviders() {
  const list = $('providerList');
  list.replaceChildren();
  const providers = providerDefaults();
  if (!providers.length) {
    $('providerListPane').hidden = true;
    return;
  }
  $('providerListPane').hidden = false;
  for (const provider of providers) {
    const card = document.createElement('section');
    card.className = 'provider-card';
    const title = document.createElement('strong');
    title.textContent = provider.name;
    const detail = document.createElement('small');
    detail.textContent = (provider.baseURL || '') + ' · ' + (provider.apiKeySet ? '密钥已保存' : '未配置密钥');
    const edit = document.createElement('button');
    edit.type = 'button'; edit.textContent = '管理模型 / 编辑';
    edit.addEventListener('click', () => editProvider(provider));
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (!confirm('确定删除服务商“' + provider.name + '”？相关勾选模型也会移除。')) return;
      const providersNext = providerDefaults().filter(item => item.id !== provider.id);
      const selectedNext = (state.config.selectedModels || []).filter(item => item.providerId !== provider.id);
      await persistProviders(providersNext, selectedNext);
      renderProviders();
      resetProviderForm();
    });
    card.append(title, detail, edit, remove);
    list.appendChild(card);
  }
}
async function persistProviders(providers, selectedModels) {
  const result = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers, selectedModels })
  });
  state.config = result.config;
  await loadSettings();
  await loadModels();
}
async function openProviders() {
  resetProviderForm();
  renderProviders();
  showProviderList();
  $('providersDialog').showModal();
}
function addProviderModelOption(modelId, checked = true) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const holder = $('providerModels');
  const existing = Array.from(holder.querySelectorAll('input[type="checkbox"]')).find(input => input.value === id);
  if (existing) {
    if (checked) existing.checked = true;
    return false;
  }
  const label = document.createElement('label');
  label.className = 'provider-model-option';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = id;
  checkbox.checked = Boolean(checked);
  const name = document.createElement('span');
  name.textContent = id;
  label.append(checkbox, name);
  holder.appendChild(label);
  return true;
}
function updateProviderModelCount() {
  const count = $('providerModels').querySelectorAll('input[type="checkbox"]').length;
  $('providerModelCount').textContent = count + ' 个模型';
}
async function addManualProviderModel() {
  const input = $('providerManualModel');
  const modelId = input.value.trim();
  if (!modelId) {
    $('providerResult').textContent = '请先输入模型 ID。';
    input.focus();
    return;
  }
  const added = addProviderModelOption(modelId, true);
  input.value = '';
  updateProviderModelCount();
  const providerId = $('providerId').value;
  const savedProvider = providerId && providerDefaults().find(item => item.id === providerId);
  if (savedProvider) {
    try {
      const otherModels = (state.config.selectedModels || []).filter(item => item.providerId !== providerId);
      const currentModels = (state.config.selectedModels || []).filter(item => item.providerId === providerId && item.enabled !== false);
      const byId = new Map(currentModels.map(item => [item.modelId, item]));
      byId.set(modelId, { providerId, modelId, enabled: true });
      await persistProviders(providerDefaults(), otherModels.concat(Array.from(byId.values())));
      $('providerResult').textContent = '模型 ' + modelId + ' 已保存，并已加入聊天模型列表。';
      showToast('模型已添加到聊天列表', 'success');
    } catch (error) {
      $('providerResult').textContent = '模型已加入临时列表，但保存失败：' + error.message;
      showToast('模型保存失败：' + error.message, 'warning');
    }
  } else {
    $('providerResult').textContent = added
      ? '模型已加入列表；保存服务商时会一并保存并加入聊天模型列表。'
      : '该模型已存在，已确保勾选。';
  }
  input.focus();
}

async function readProviderModels() {
  const output = $('providerResult');
  output.textContent = '正在读取模型列表…';
  try {
    const id = $('providerId').value || 'preview';
    const provider = {
      id,
      name: $('providerName').value.trim() || '新服务商',
      baseURL: $('providerBaseURL').value.trim(),
      apiKey: $('providerApiKey').value.trim(),
      customHeaders: parseJSONField($('providerHeaders').value, '自定义请求头')
    };
    const saved = providerDefaults().find(item => item.id === id);
    if (!provider.apiKey && saved) provider.apiKey = saved.apiKey || '';
    if (!provider.baseURL || (!provider.apiKey && !(saved && saved.apiKeySet))) throw new Error('请先填写 Base URL 和 API Key。');
    const result = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id === 'preview' ? '' : provider.id, baseURL: provider.baseURL, apiKey: provider.apiKey, customHeaders: provider.customHeaders })
    });
    const models = Array.isArray(result.models) ? result.models.filter(item => item && item.id) : [];
    state.providerModels = models.map(item => item.id);
    const selected = (state.config.selectedModels || []).filter(item => item.providerId === id && item.enabled !== false);
    const selectedSet = new Set(selected.map(item => item.modelId));
    const currentlyChecked = new Set(Array.from($('providerModels').querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value));
    for (const model of models) {
      addProviderModelOption(model.id, selectedSet.has(model.id) || currentlyChecked.has(model.id));
    }
    updateProviderModelCount();
    output.textContent = '在线获取成功 · ' + result.rtt + ' ms。勾选模型后保存，即可加入聊天框；也可以手动添加其他模型 ID。';
  } catch (error) {
    $('providerResult').textContent = '读取失败：' + error.message;
  }
}
async function saveProvider() {
  try {
    const id = $('providerId').value || makeId();
    const existing = providerDefaults().find(item => item.id === id);
    const provider = {
      id,
      name: $('providerName').value.trim(),
      baseURL: $('providerBaseURL').value.trim(),
      apiKey: $('providerApiKey').value.trim(),
      customHeaders: parseJSONField($('providerHeaders').value, '自定义请求头')
    };
    if (!provider.name || !provider.baseURL) throw new Error('服务商名称和 Base URL 必填。');
    if (!provider.apiKey && !(existing && existing.apiKeySet)) throw new Error('请填写 API Key。');
    const providers = providerDefaults().filter(item => item.id !== id);
    providers.push(provider);
    const checkedNow = Array.from($('providerModels').querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
    const keepOther = (state.config.selectedModels || []).filter(item => item.providerId !== id);
    const selected = keepOther.concat(checkedNow.map(modelId => ({ providerId: id, modelId, enabled: true })));
    await persistProviders(providers, selected);
    $('providerId').value = id;
    $('providerEditorTitle').textContent = '管理模型 / 编辑：' + provider.name;
    $('providerResult').textContent = '服务商及当前勾选的 ' + checkedNow.length + ' 个模型已保存；也可以继续添加模型。';
    renderProviders();
    showProviderEditor();
    showToast('服务商已保存', 'success');
  } catch (error) {
    $('providerResult').textContent = error.message;
  }
}
async function saveSelectedProviderModels() {
  const id = $('providerId').value;
  if (!id || !providerDefaults().some(item => item.id === id)) {
    $('providerResult').textContent = '请先保存服务商，再选择模型。';
    return;
  }
  const checked = Array.from($('providerModels').querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
  const keepOther = (state.config.selectedModels || []).filter(item => item.providerId !== id);
  const selectedModels = keepOther.concat(checked.map(modelId => ({ providerId: id, modelId, enabled: true })));
  await persistProviders(providerDefaults(), selectedModels);
  $('providerResult').textContent = '已保存 ' + checked.length + ' 个模型。聊天框只显示已勾选的模型。';
  showToast('模型选择已保存', 'success');
}

function closeSidebarOnMobile() {
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.body.classList.remove('sidebar-open');
  }
}

document.addEventListener('click', event => {
  if (event.target.closest('.history-item')) return;
  document.querySelectorAll('.history-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.history-more').forEach(button => button.setAttribute('aria-expanded', 'false'));
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.history-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.history-more').forEach(button => button.setAttribute('aria-expanded', 'false'));
});

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
  $('composer').classList.toggle('composer-has-text', Boolean(event.target.value.trim()));
});

$('settingsBtn').addEventListener('click', openSettingsHub);
$('mcpType').addEventListener('change', updateMCPTypeFields);
$('mcpAddTop').addEventListener('click', () => { resetMCPForm(); showMCPEditor(); $('mcpName').focus(); });
$('mcpBack').addEventListener('click', showMCPList);
$('providerBack').addEventListener('click', showProviderList);
$('providerAddManualModel').addEventListener('click', addManualProviderModel);
$('providerManualModel').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addManualProviderModel();
  }
});

$('providerAddTop').addEventListener('click', () => { resetProviderForm(); showProviderEditor(); $('providerName').focus(); });
$('providerReset').addEventListener('click', resetProviderForm);
$('providerSave').addEventListener('click', saveProvider);
$('providerTest').addEventListener('click', readProviderModels);
$('saveSelectedModels').addEventListener('click', saveSelectedProviderModels);
$('mcpReset').addEventListener('click', resetMCPForm);
$('mcpSave').addEventListener('click', saveMCPServer);
function returnToSettingsHub(dialogId) {
  const dialog = $(dialogId);
  if (dialog && dialog.open) dialog.close();
  $('settingsHub').showModal();
}
$('providersSettingsBack').addEventListener('click', () => returnToSettingsHub('providersDialog'));
$('generalBack').addEventListener('click', () => returnToSettingsHub('settings'));
$('runtimeBack').addEventListener('click', () => returnToSettingsHub('runtimeStatus'));
$('mcpSettingsBack').addEventListener('click', () => returnToSettingsHub('mcpManager'));

$('settingsCategoryProviders').addEventListener('click', () => { $('settingsHub').close(); openProviders(); });
$('settingsCategoryGeneral').addEventListener('click', () => { $('settingsHub').close(); openGeneralSettings(); });
$('settingsCategoryRuntime').addEventListener('click', () => { $('settingsHub').close(); openRuntimeStatus(); });
$('settingsCategoryMCP').addEventListener('click', () => { $('settingsHub').close(); openMCPManager(); });
$('themeBtn').addEventListener('click', () => {
  document.body.classList.toggle('light');
  localStorage.setItem(
    'node-ai-web-theme',
    document.body.classList.contains('light') ? 'light' : 'dark'
  );
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
  if (chat) {
    chat.thinking = state.thinking;
    chat.thinkingLevel = state.thinkingLevel;
  }
  updateThinkingButton();
  saveHistory();
  showToast(state.thinking
    ? '已开启深度思考。实际效果取决于当前模型与服务商。'
    : '已关闭思考模式。', 'info');
});
$('thinkingLevel').addEventListener('change', () => {
  const level = $('thinkingLevel').value;
  if (!['low', 'medium', 'high'].includes(level)) return;
  state.thinkingLevel = level;
  const chat = currentChat();
  if (chat) chat.thinkingLevel = level;
  updateThinkingButton();
  saveHistory();
  showToast('思考等级已设为' + ({ low: '轻量', medium: '标准', high: '深度' }[level]) + '。', 'info');
});
$('attachBtn').addEventListener('click', () => {
  showToast('附件上传暂未接入；此按钮目前保留为工具入口。', 'info');
});

$('saveSettings').addEventListener('click', saveSettings);
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
      thinking: false,
      thinkingLevel: 'high'
    }, chat));

  if (state.chats.length) {
    state.activeChatId = state.chats
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    const active = currentChat();
    state.thinking = Boolean(active && active.thinking);
    state.thinkingLevel = active && ['low', 'medium', 'high'].includes(active.thinkingLevel) ? active.thinkingLevel : 'high';
  }

  renderHistory();
  renderMessages();
  await loadSettings();
  await loadModels();
})();
