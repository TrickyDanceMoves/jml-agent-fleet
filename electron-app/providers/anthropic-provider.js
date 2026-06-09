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

  async streamTurn({ system, tools, messages, onText, onToolStart, signal }) {
    const client = this._client();
    const started = Date.now();

    // Prompt caching: the system prompt and tool table are static for the whole
    // session — mark both ephemeral so multi-turn conversations re-read them from
    // cache instead of re-billing full input tokens every turn.
    const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    const cachedTools  = (tools && tools.length)
      ? tools.map((t, i) => i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)
      : tools;

    const stream = client.messages.stream({
      model: this.agentModel,
      max_tokens: 4096,
      system: systemBlocks,
      tools: cachedTools,
      messages
    }, signal ? { signal } : undefined);

    stream.on('text', onText);

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        onToolStart(event.content_block.name);
      }
    });

    const finalMsg = await stream.finalMessage();
    return {
      content: finalMsg.content,
      stopReason: finalMsg.stop_reason,
      trace: {
        provider: this.name, model: this.agentModel, latencyMs: Date.now() - started,
        inputTokens:  finalMsg.usage?.input_tokens  ?? null,
        outputTokens: finalMsg.usage?.output_tokens ?? null,
        cacheReadTokens: finalMsg.usage?.cache_read_input_tokens ?? null
      }
    };
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
