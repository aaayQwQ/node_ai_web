'use strict';

// Protocol bridge for providers that expose different model API dialects.
// The public interface remains OpenAI Chat Completions so the UI and MCP loop
// do not need provider-specific branches.
function detect(config, model) {
  const explicit = String(config.apiFormat || 'auto').toLowerCase();
  if (['chat', 'responses', 'anthropic'].includes(explicit)) return explicit;
  const base = String(config.baseURL || '').toLowerCase();
  const id = String(model || config.model || '').toLowerCase();
  if (/opencode\\.ai/.test(base)) {
    if (/^(gpt-|grok-|muse-spark)/.test(id)) return 'responses';
    if (/^(claude-|qwen)/.test(id)) return 'anthropic';
  }
  // Explicitly selected protocol is recommended for non-standard gateways.
  return 'chat';
}

function anthropicInput(payload) {
  const messages = [];
  let system = [];
  (payload.messages || []).forEach(message => {
    const role = message.role;
    if (role === 'system') {
      system.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''));
      return;
    }
    if (role === 'tool') {
      messages.push({ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      }] });
      return;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      message.tool_calls.forEach(call => {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      });
      messages.push({ role: 'assistant', content: blocks });
      return;
    }
    messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: message.content == null ? '' : message.content });
  });
  const result = {
    model: payload.model,
    max_tokens: Number(payload.max_tokens) || 4096,
    messages,
    stream: false
  };
  if (system.length) result.system = system.join('\n\n');
  if (payload.temperature !== undefined) result.temperature = payload.temperature;
  if (payload.top_p !== undefined) result.top_p = payload.top_p;
  if (Array.isArray(payload.tools)) {
    result.tools = payload.tools.filter(tool => tool && tool.function).map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} }
    }));
  }
  if (payload.tool_choice === 'none') result.tool_choice = { type: 'none' };
  else if (payload.tool_choice && payload.tool_choice.function) {
    result.tool_choice = { type: 'tool', name: payload.tool_choice.function.name };
  } else if (payload.tool_choice === 'required') result.tool_choice = { type: 'any' };
  return result;
}

function responsesInput(payload) {
  const input = [];
  (payload.messages || []).forEach(message => {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
      return;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      message.tool_calls.forEach(call => input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || '{}'
      }));
      return;
    }
    input.push({ role: message.role === 'system' ? 'developer' : message.role, content: message.content == null ? '' : message.content });
  });
  const result = { model: payload.model, input, stream: false };
  if (payload.max_tokens !== undefined) result.max_output_tokens = payload.max_tokens;
  if (payload.temperature !== undefined) result.temperature = payload.temperature;
  if (payload.top_p !== undefined) result.top_p = payload.top_p;
  if (Array.isArray(payload.tools)) {
    result.tools = payload.tools.filter(tool => tool && tool.function).map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
      strict: false
    }));
  }
  if (payload.tool_choice !== undefined) result.tool_choice = payload.tool_choice;
  return result;
}

function fromAnthropic(data, model) {
  const content = [];
  const toolCalls = [];
  (data.content || []).forEach((block, index) => {
    if (block.type === 'text') content.push(block.text || '');
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || ('call_' + index),
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  });
  return {
    id: data.id || 'chatcmpl-bridge',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: content.join('') || null, tool_calls: toolCalls.length ? toolCalls : undefined },
      finish_reason: toolCalls.length ? 'tool_calls' : (data.stop_reason === 'max_tokens' ? 'length' : 'stop')
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : undefined
  };
}

function fromResponses(data, model) {
  const content = [];
  const toolCalls = [];
  (data.output || []).forEach((item, index) => {
    if (item.type === 'message') {
      (item.content || []).forEach(part => {
        if (part.type === 'output_text' || part.type === 'text') content.push(part.text || '');
      });
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || ('call_' + index),
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      });
    }
  });
  if (!content.length && typeof data.output_text === 'string') content.push(data.output_text);
  return {
    id: data.id || 'chatcmpl-bridge',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: content.join('') || null, tool_calls: toolCalls.length ? toolCalls : undefined },
      finish_reason: toolCalls.length ? 'tool_calls' : (data.status === 'incomplete' ? 'length' : 'stop')
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : undefined
  };
}

function sseResponse(data) {
  const choice = data.choices && data.choices[0] || {};
  const message = choice.message || {};
  const chunks = [];
  const base = { id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model };
  if (message.content) chunks.push('data: ' + JSON.stringify(Object.assign({}, base, { choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }] })) + '\n\n');
  (message.tool_calls || []).forEach((call, index) => {
    chunks.push('data: ' + JSON.stringify(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }, finish_reason: null }] })) + '\n\n');
  });
  chunks.push('data: ' + JSON.stringify(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] })) + '\n\n');
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

module.exports = { detect, anthropicInput, responsesInput, fromAnthropic, fromResponses, sseResponse };
