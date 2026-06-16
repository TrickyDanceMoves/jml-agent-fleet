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
  // Azure AI Foundry — keyless (Entra / az login) against a deployed model on an
  // Azure AI Foundry / AIServices resource. endpoint is the resource's Azure
  // OpenAI endpoint (https://<resource>.openai.azure.com); agentModel is the
  // deployment name. Leave apiKey empty for keyless; set keyless:false + apiKey
  // to use a resource key instead.
  'azure-foundry': {
    keyless:    true,
    apiKey:     '',
    endpoint:   'https://<resource>.openai.azure.com',
    agentModel: 'gpt-4o',
    fastModel:  'gpt-4o',
    apiVersion: '2025-01-01-preview',
    scope:      'https://cognitiveservices.azure.com/.default',
    tokenParam: 'max_completion_tokens'
  },
  ollama: {
    baseUrl:    'http://localhost:11434',
    agentModel: 'llama3.1',
    fastModel:  'llama3.1'
  },
  // Local Qwen — served by any OpenAI-compatible local runtime (Ollama's /v1
  // endpoint by default; LM Studio / vLLM work by changing the base URL).
  qwen: {
    baseUrl:    'http://localhost:11434',
    agentModel: 'qwen3:14b',
    fastModel:  'qwen3:4b'
  },
  // LM Studio — local OpenAI-compatible server (Developer tab → Start Server).
  // Free; pick models with tool-calling support for the agent chats.
  lmstudio: {
    baseUrl:    'http://localhost:1234',
    agentModel: 'qwen2.5-7b-instruct',
    fastModel:  'qwen2.5-7b-instruct'
  }
};

function loadConfig(configFile) {
  try {
    if (fs.existsSync(configFile)) {
      const raw  = fs.readFileSync(configFile, 'utf8').split(String.fromCharCode(0xFEFF)).join('');
      const saved = JSON.parse(raw);
      // Deep merge: start from DEFAULT_CONFIG so every provider sub-object has all
      // required keys even if the saved file pre-dates a new field being added.
      const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      if (saved.provider !== undefined) merged.provider = saved.provider;
      for (const key of Object.keys(merged)) {
        if (key === 'provider') continue;
        if (saved[key] && typeof saved[key] === 'object') {
          merged[key] = Object.assign({}, merged[key], saved[key]);
        }
      }
      return merged;
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
    case 'azure-foundry': {
      const c = config['azure-foundry'] || {};
      if (!c.endpoint) return null;
      // Keyless (Entra / az login) by default — matches Foundry's Entra agent
      // identity. Falls back to an api-key only if one is provided and keyless
      // is not explicitly requested.
      const wantsKeyless = c.keyless === true || (c.keyless !== false && !c.apiKey);
      let azureADTokenProvider;
      if (wantsKeyless) {
        const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity');
        const scope = c.scope || 'https://cognitiveservices.azure.com/.default';
        azureADTokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), scope);
      } else if (!c.apiKey) {
        return null;
      }
      return new OpenAICompatProvider({
        isAzure:          true,
        apiKey:           c.apiKey || undefined,
        azureADTokenProvider,
        azureEndpoint:    c.endpoint.replace(/\/$/, ''),
        azureApiVersion:  c.apiVersion || '2025-01-01-preview',
        agentModel:       c.agentModel || 'gpt-4o',
        fastModel:        c.fastModel  || c.agentModel || 'gpt-4o',
        tokenParam:       c.tokenParam || 'max_completion_tokens',
        providerName:     'azure-foundry'
      });
    }
    case 'ollama': {
      const c = config.ollama || {};
      return new OpenAICompatProvider({
        apiKey:       'ollama',
        baseURL:      `${(c.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        agentModel:   c.agentModel || 'llama3.1',
        fastModel:    c.fastModel  || 'llama3.1',
        providerName: 'ollama'
      });
    }
    case 'lmstudio': {
      const c = config.lmstudio || {};
      return new OpenAICompatProvider({
        apiKey:       'lm-studio',
        baseURL:      `${(c.baseUrl || 'http://localhost:1234').replace(/\/$/, '')}/v1`,
        agentModel:   c.agentModel || 'qwen2.5-7b-instruct',
        fastModel:    c.fastModel  || 'qwen2.5-7b-instruct',
        providerName: 'lmstudio'
      });
    }
    case 'qwen': {
      const c = config.qwen || {};
      return new OpenAICompatProvider({
        apiKey:       'local',
        baseURL:      `${(c.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        agentModel:   c.agentModel || 'qwen3:14b',
        fastModel:    c.fastModel  || 'qwen3:4b',
        providerName: 'qwen'
      });
    }
    default:
      return null;
  }
}

module.exports = { loadConfig, saveConfig, buildProvider, DEFAULT_CONFIG };
