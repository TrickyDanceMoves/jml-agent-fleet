'use strict';

// Converts Anthropic tool definitions to OpenAI function-call format
function toOpenAITools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

// Converts Anthropic-format message history to OpenAI message array.
// Anthropic stores tool results inline in user turns; OpenAI uses role:'tool'.
function toOpenAIMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            });
          } else if (block.type === 'text') {
            out.push({ role: 'user', content: block.text });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts  = msg.content.filter(b => b.type === 'text');
        const toolParts  = msg.content.filter(b => b.type === 'tool_use');
        const textStr    = textParts.map(b => b.text).join('') || null;
        const tool_calls = toolParts.map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) }
        }));
        const entry = { role: 'assistant' };
        if (tool_calls.length) {
          // OpenAI spec: content MUST be null (not a string) when tool_calls is present.
          // Setting both causes HTTP 400 on Azure AI Foundry and many Ollama models.
          entry.content    = null;
          entry.tool_calls = tool_calls;
        } else {
          entry.content = textStr || '';
        }
        out.push(entry);
      }
    }
  }
  return out;
}

class OpenAICompatProvider {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseURL]          Custom base URL (Ollama: http://localhost:11434/v1)
   * @param {boolean} [opts.isAzure]
   * @param {string}  [opts.azureEndpoint]   Azure OpenAI resource endpoint
   * @param {string}  [opts.azureApiVersion]
   * @param {string}  opts.agentModel        Model/deployment for the main agent loop
   * @param {string}  opts.fastModel         Model/deployment for quick utility calls
   */
  constructor({ apiKey, baseURL, isAzure, azureEndpoint, azureApiVersion, agentModel, fastModel, providerName }) {
    this.agentModel    = agentModel;
    this.fastModel     = fastModel;
    this.isAzure       = !!isAzure;
    this._providerName = providerName || (isAzure ? 'azure-openai' : 'openai');

    if (isAzure) {
      const { AzureOpenAI } = require('openai');
      const version = azureApiVersion || '2025-01-01-preview';
      this._agentClient = new AzureOpenAI({ endpoint: azureEndpoint, apiKey, apiVersion: version });
      this._fastClient  = this._agentClient;
    } else {
      const { OpenAI } = require('openai');
      const opts = { apiKey };
      if (baseURL) opts.baseURL = baseURL;
      this._agentClient = new OpenAI(opts);
      this._fastClient  = this._agentClient;
    }
  }

  get name() { return this._providerName; }

  async streamTurn({ system, tools, messages, onText, onToolStart }) {
    const openAiMessages = [
      { role: 'system', content: system },
      ...toOpenAIMessages(messages)
    ];
    const openAiTools = toOpenAITools(tools);

    const stream = await this._agentClient.chat.completions.create({
      model:       this.agentModel,
      max_tokens:  4096,
      messages:    openAiMessages,
      tools:       openAiTools,
      tool_choice: openAiTools ? 'auto' : undefined,
      stream:      true
    });

    let textContent = '';
    const toolAccum = {}; // index → { id, name, arguments }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textContent += delta.content;
        onText(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolAccum[idx]) {
            toolAccum[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id)                toolAccum[idx].id = tc.id;
          if (tc.function?.name) {
            const isFirst = !toolAccum[idx].name;
            toolAccum[idx].name = tc.function.name;
            if (isFirst) onToolStart(tc.function.name);
          }
          if (tc.function?.arguments) toolAccum[idx].arguments += tc.function.arguments;
        }
      }
    }

    // Return in Anthropic content-block format so main.js loop is provider-agnostic
    const content = [];
    if (textContent) content.push({ type: 'text', text: textContent });
    for (const tc of Object.values(toolAccum)) {
      let input = {};
      try { input = JSON.parse(tc.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }

    const stopReason = Object.keys(toolAccum).length > 0 ? 'tool_use' : 'end_turn';
    return { content, stopReason };
  }

  async complete({ messages, maxTokens }) {
    const openAiMessages = toOpenAIMessages(messages);
    const resp = await this._fastClient.chat.completions.create({
      model:      this.fastModel,
      max_tokens: maxTokens || 300,
      messages:   openAiMessages
    });
    return resp.choices[0]?.message?.content || '';
  }
}

module.exports = { OpenAICompatProvider };
