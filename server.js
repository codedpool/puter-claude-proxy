require('dotenv').config();
const { init } = require('@heyputer/puter.js/src/init.cjs');
const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3456;
const DEBUG = process.env.DEBUG === 'true';

// Init puter with auth token
const puter = init(process.env.PUTER_AUTH_TOKEN);

const MODEL_MAP = {
  'claude-haiku-4-5':           process.env.PUTER_MODEL_HAIKU,
  'claude-3-haiku-20240307':    process.env.PUTER_MODEL_HAIKU,
  'claude-sonnet-4-6':          process.env.PUTER_MODEL_SONNET,
  'claude-3-5-sonnet-20241022': process.env.PUTER_MODEL_SONNET,
  'claude-3-5-sonnet-20240620': process.env.PUTER_MODEL_SONNET,
  'claude-opus-4-6':            process.env.PUTER_MODEL_OPUS,
  'claude-3-opus-20240229':     process.env.PUTER_MODEL_OPUS,
};

function resolveModel(requested) {
  return MODEL_MAP[requested] || process.env.DEFAULT_MODEL;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'tool_result') return JSON.stringify(c.content);
      if (c.type === 'tool_use') return `[Tool call: ${c.name}]`;
      return '';
    }).join('');
  }
  return '';
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy: 'puter-claude-proxy', version: '1.0.0' });
});

// Main Anthropic-compatible endpoint
app.post('/v1/messages', async (req, res) => {
  const { messages, system, max_tokens, model: requestedModel } = req.body;
  const model = resolveModel(requestedModel);

  if (DEBUG) {
    console.log('\n--- Incoming Request ---');
    console.log('Model:', requestedModel, '→', model);
    console.log('System:', system?.slice(0, 100));
    console.log('Messages:', JSON.stringify(messages).slice(0, 400));
  }

  // Build Puter message array
  const puterMessages = [];
  if (system) puterMessages.push({ role: 'system', content: system });
  for (const msg of messages) {
    puterMessages.push({
      role: msg.role,
      content: extractText(msg.content)
    });
  }

  try {
    const response = await puter.ai.chat(puterMessages, { model });

    if (DEBUG) console.log('Puter raw:', JSON.stringify(response).slice(0, 400));

    const text =
      response?.message?.content?.[0]?.text ||
      response?.text ||
      response?.message?.content ||
      'No response from Puter';

    if (DEBUG) console.log('✅ Reply:', text.slice(0, 200));

    res.json({
      id: 'msg_' + Date.now(),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 100 }
    });

  } catch (err) {
    console.error('❌ Proxy error:', err.message);
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: err.message }
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ puter-claude-proxy running at http://localhost:${PORT}`);
  console.log(`📡 Routing → Puter.js → Claude (free)`);
  console.log(`🔍 Debug: ${DEBUG} | Default model: ${process.env.DEFAULT_MODEL}`);
});
