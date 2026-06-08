'use strict';

class AnthropicProvider {
  constructor({ apiKey, agentModel, fastModel }) {
    this.apiKey     = apiKey;
    this.agentModel = agentModel || 'claude-opus-4-7';
    this.fastModel  = fastModel  || 'claude-haiku-4-5-20251001';
  }

  get name() { return 'claude'; }

  _client() {
    const Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic.default({ apiKey: this.apiKey });
  }

  async streamTurn({ system, tools, messages, onText, onToolStart }) {
    const client = this._client();
    const stream = client.messages.stream({
      model: this.agentModel,
      max_tokens: 4096,
      system,
      tools,
      messages
    });

    stream.on('text', onText);

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        onToolStart(event.content_block.name);
      }
    });

    const finalMsg = await stream.finalMessage();
    return { content: finalMsg.content, stopReason: finalMsg.stop_reason };
  }

  async complete({ messages, maxTokens }) {
    const client = this._client();
    const msg = await client.messages.create({
      model: this.fastModel,
      max_tokens: maxTokens || 300,
      messages
    });
    return msg.content[0]?.text || '';
  }
}

module.exports = { AnthropicProvider };
