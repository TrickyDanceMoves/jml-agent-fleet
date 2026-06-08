'use strict';

const fs   = require('fs');

const DEFAULT_CONFIG = {
  provider: 'claude',
  claude: {
    apiKey:     '',
    agentModel: 'claude-opus-4-7',
    fastModel:  'claude-haiku-4-5-20251001'
  },
  openai: {
    apiKey:     '',
    agentModel: 'gpt-4o',
    fastModel:  'gpt-4o-mini'
  },
  'azure-openai': {
    apiKey:          '',
    endpoint:        '',
    agentDeployment: 'gpt-4o',
    fastDeployment:  'gpt-4o-mini',
    apiVersion:      '2025-01-01-preview'
  },
  ollama: {
    baseUrl:    'http://localhost:11434',
    agentModel: 'llama3.1',
    fastModel:  'llama3.1'
  }
};

function loadConfig(configFile) {
  try {
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf8').split(String.fromCharCode(0xFEFF)).join('');
      return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
    }
  } catch {}
  // Bootstrap Claude from env var if present
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (process.env.ANTHROPIC_API_KEY) {
    cfg.provider = 'claude';
    cfg.claude.apiKey = process.env.ANTHROPIC_API_KEY;
  } else {
    cfg.provider = '';
  }
  return cfg;
}

function saveConfig(configFile, config) {
  // Never persist raw API keys to disk — only save non-secret fields + masked presence.
  // Actually for a local desktop app, persisting is the right UX. We save everything.
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}

function buildProvider(config) {
  const { AnthropicProvider }    = require('./anthropic-provider');
  const { OpenAICompatProvider } = require('./openai-compat-provider');

  switch (config.provider) {
    case 'claude': {
      const c = config.claude || {};
      const apiKey = c.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      return new AnthropicProvider({ apiKey, agentModel: c.agentModel, fastModel: c.fastModel });
    }
    case 'openai': {
      const c = config.openai || {};
      if (!c.apiKey) return null;
      return new OpenAICompatProvider({
        apiKey:     c.apiKey,
        agentModel: c.agentModel || 'gpt-4o',
        fastModel:  c.fastModel  || 'gpt-4o-mini'
      });
    }
    case 'azure-openai': {
      const c = config['azure-openai'] || {};
      if (!c.apiKey || !c.endpoint) return null;
      return new OpenAICompatProvider({
        isAzure:        true,
        apiKey:         c.apiKey,
        azureEndpoint:  c.endpoint,
        azureApiVersion:c.apiVersion || '2025-01-01-preview',
        agentModel:     c.agentDeployment || 'gpt-4o',
        fastModel:      c.fastDeployment  || 'gpt-4o-mini'
      });
    }
    case 'ollama': {
      const c = config.ollama || {};
      return new OpenAICompatProvider({
        apiKey:     'ollama',
        baseURL:    `${(c.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        agentModel: c.agentModel || 'llama3.1',
        fastModel:  c.fastModel  || 'llama3.1'
      });
    }
    default:
      return null;
  }
}

module.exports = { loadConfig, saveConfig, buildProvider, DEFAULT_CONFIG };
