'use strict';

const assert = require('assert');
const protocols = require('../src/model_protocols');

const base = { baseURL: 'https://opencode.ai/zen/v1', apiFormat: 'auto' };
assert.strictEqual(protocols.detect(base, 'gpt-5.5'), 'responses');
assert.strictEqual(protocols.detect(base, 'grok-4.6'), 'responses');
assert.strictEqual(protocols.detect(base, 'claude-sonnet-4-6'), 'anthropic');
assert.strictEqual(protocols.detect(base, 'qwen3.7-max'), 'anthropic');
assert.strictEqual(protocols.detect(base, 'deepseek-v4-pro'), 'chat');
assert.strictEqual(protocols.detect(base, 'kimi-k3'), 'chat');
assert.strictEqual(protocols.detect({ baseURL: 'https://api.example.com', apiFormat: 'auto' }, 'gpt-5'), 'chat');
assert.strictEqual(protocols.detect({ baseURL: 'https://api.example.com', apiFormat: 'anthropic' }, 'any-model'), 'anthropic');

const chatPayload = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  temperature: 0.4,
  top_p: 0.8,
  messages: [
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'Run the tool.' },
    { role: 'assistant', content: '', tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'lookup', arguments: '{"q":"x"}' }
    }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'found' }
  ],
  tools: [{ type: 'function', function: {
    name: 'lookup', description: 'Lookup data',
    parameters: { type: 'object', properties: { q: { type: 'string' } } }
  } }]
};

const anthropic = protocols.anthropicInput(chatPayload);
assert.strictEqual(anthropic.system, 'Be helpful.');
assert.strictEqual(anthropic.max_tokens, 1024);
assert.strictEqual(anthropic.temperature, 0.4);
assert.strictEqual(Object.prototype.hasOwnProperty.call(anthropic, 'top_p'), false);
assert.strictEqual(anthropic.messages[1].content[0].type, 'tool_use');
assert.strictEqual(anthropic.messages[2].content[0].type, 'tool_result');
assert.strictEqual(anthropic.tools[0].name, 'lookup');

const responses = protocols.responsesInput(Object.assign({}, chatPayload, { model: 'gpt-5.5' }));
assert.strictEqual(responses.model, 'gpt-5.5');
assert.strictEqual(responses.max_output_tokens, 1024);
assert.strictEqual(responses.input[2].type, 'function_call');
assert.strictEqual(responses.input[3].type, 'function_call_output');
assert.strictEqual(responses.tools[0].type, 'function');

const anthropicResult = protocols.fromAnthropic({
  id: 'msg_1', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Working' },
    { type: 'tool_use', id: 'call_2', name: 'lookup', input: { q: 'y' } }
  ],
  usage: { input_tokens: 10, output_tokens: 4 }
});
assert.strictEqual(anthropicResult.choices[0].message.content, 'Working');
assert.strictEqual(anthropicResult.choices[0].message.tool_calls[0].id, 'call_2');
assert.strictEqual(anthropicResult.choices[0].finish_reason, 'tool_calls');

const responsesResult = protocols.fromResponses({
  id: 'resp_1', model: 'gpt-5.5', status: 'completed',
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
    { type: 'function_call', call_id: 'call_3', name: 'lookup', arguments: '{"q":"z"}' }
  ]
});
assert.strictEqual(responsesResult.choices[0].message.content, 'Done');
assert.strictEqual(responsesResult.choices[0].message.tool_calls[0].id, 'call_3');
assert.strictEqual(responsesResult.choices[0].finish_reason, 'tool_calls');
assert(protocols.sseResponse(responsesResult).includes('data: [DONE]'));

console.log('Model protocol adapter tests passed.');
