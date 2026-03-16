require('dotenv').config();
const { init } = require('@heyputer/puter.js/src/init.cjs');
const express = require('express');


const app = express();
app.use(express.json({ limit: '50mb' }));


const PORT = process.env.PORT || 3456;
const DEBUG = process.env.DEBUG === 'true';


const puter = init(process.env.PUTER_AUTH_TOKEN);


const MODEL_MAP = {
  // Claude variants
  'claude-haiku-4-5':           process.env.PUTER_MODEL_HAIKU,
  'claude-3-haiku-20240307':    process.env.PUTER_MODEL_HAIKU,
  'claude-sonnet-4-6':          process.env.PUTER_MODEL_SONNET,
  'claude-3-5-sonnet-20241022': process.env.PUTER_MODEL_SONNET,
  'claude-3-5-sonnet-20240620': process.env.PUTER_MODEL_SONNET,
  'claude-opus-4-6':            process.env.PUTER_MODEL_OPUS,
  'claude-3-opus-20240229':     process.env.PUTER_MODEL_OPUS,
  // Other models Puter supports
  'gpt-4o':                     'gpt-4o',
  'gpt-4o-mini':                'gpt-4o-mini',
  'gemini-2.0-flash':           'gemini-2.0-flash',
  'o3-mini':                    'o3-mini',
  'o1':                         'o1',
};


function resolveModel(requested) {
  return MODEL_MAP[requested] || process.env.DEFAULT_MODEL;
}


function flattenSystem(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.filter(s => s.type === 'text' && s.text).map(s => s.text).join('\n\n');
  }
  return String(system);
}


function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (c.type === 'text') return c.text || '';
      if (c.type === 'tool_use') return `[Tool: ${c.name} | Input: ${JSON.stringify(c.input)}]`;
      if (c.type === 'tool_result') {
        const inner = Array.isArray(c.content)
          ? c.content.map(x => x.text || '').join('')
          : String(c.content || '');
        return `[Tool Result id=${c.tool_use_id}]: ${inner}`;
      }
      return '';
    }).join('\n');
  }
  return String(content || '');
}


// Parse XML tool calls from Puter's text response into Anthropic tool_use blocks
function parseToolCalls(text) {
  const contentBlocks = [];
  const toolUseBlocks = [];


  // Extract <function_calls> block
  const funcCallMatch = text.match(/<function_calls>([\s\S]*?)<\/function_calls>/);


  if (funcCallMatch) {
    // Text before tool call
    const before = text.slice(0, text.indexOf('<function_calls>')).trim();
    if (before) contentBlocks.push({ type: 'text', text: before });


    // Parse each <invoke>
    const invokeRegex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let match;
    while ((match = invokeRegex.exec(funcCallMatch[1])) !== null) {
      const toolName = match[1];
      const paramsBlock = match[2];
      const input = {};


      // Parse <parameter name="...">value</parameter>
      const paramRegex = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
        input[paramMatch[1]] = paramMatch[2].trim();
      }


      toolUseBlocks.push({
        type: 'tool_use',
        id: 'tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: toolName,
        input
      });
    }


    // Text after tool call
    const after = text.slice(text.indexOf('</function_calls>') + '</function_calls>'.length).trim();
    if (after) contentBlocks.push({ type: 'text', text: after });


    return {
      content: [...contentBlocks, ...toolUseBlocks],
      stop_reason: 'tool_use'
    };
  }


  // No tool calls — plain text response
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn'
  };
}


// Block WebSearch/WebFetch tools — return disabled message instead
function handleDisabledTools(content) {
  return content.map(block => {
    if (block.type === 'tool_use' && (block.name === 'WebSearch' || block.name === 'WebFetch')) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: [
          {
            type: 'text',
            text: 'Web search is disabled in this environment (Puter AI credits required). Please continue without using WebSearch/WebFetch.'
          }
        ]
      };
    }
    return block;
  });
}


app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy: 'puter-claude-proxy', version: '1.0.0' });
});


app.post('/v1/messages', async (req, res) => {
  const { messages, system, model: requestedModel, tools } = req.body;
  const model = resolveModel(requestedModel);


  const systemText = flattenSystem(system);
  const puterMessages = [];


  if (systemText) puterMessages.push({ role: 'system', content: systemText });


  for (const msg of messages) {
    puterMessages.push({ role: msg.role, content: flattenContent(msg.content) });
  }


  if (tools?.length) {
    const toolDesc = tools.map(t =>
      `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.input_schema)}`
    ).join('\n\n');
    const toolPrompt = `\n\n# CRITICAL INSTRUCTION - TOOL USE\nYou MUST use tools to interact with the filesystem. NEVER make up or hallucinate file contents.\n- To read a file: use the Read tool\n- To list files: use the Glob tool  \n- To search: use the Grep tool\n- To edit: use the Edit tool\n- To run commands: use the Bash tool\n\nALWAYS respond with ONLY this XML format when using a tool — no other text before it:\n<function_calls>\n<invoke name="ToolName">\n<parameter name="param_name">value</parameter>\n</invoke>\n</function_calls>\n\n# Tool Definitions\n${toolDesc}`;
    if (puterMessages[0]?.role === 'system') {
      puterMessages[0].content += toolPrompt;
    } else {
      puterMessages.unshift({ role: 'system', content: toolPrompt });
    }
  }


  if (DEBUG) {
    console.log('\n--- Incoming Request ---');
    console.log('Model:', requestedModel, '→', model);
    console.log('Tools:', tools?.map(t => t.name));
    console.log('Messages count:', puterMessages.length);
  }


  try {
    const response = await puter.ai.chat(puterMessages, { model });


    const rawText =
      response?.message?.content?.[0]?.text ||
      response?.text ||
      response?.message?.content ||
      '';


    if (DEBUG) console.log('Raw reply:', rawText.slice(0, 300));


    const { content, stop_reason } = parseToolCalls(rawText);


    // Block WebSearch/WebFetch tools
    const processedContent = handleDisabledTools(content);


    if (DEBUG) console.log('Parsed stop_reason:', stop_reason, '| blocks:', processedContent.map(c => c.type));


    res.json({
      id: 'msg_' + Date.now(),
      type: 'message',
      role: 'assistant',
      content: processedContent,
      model,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 100 }
    });


  } catch (err) {
    const code = err?.error?.code;
    const delegate = err?.error?.delegate;

    if (code === 'insufficient_funds' || delegate === 'usage-limited-chat') {
      console.error('💸 Blocked by Puter quota:', err.error);
      return res.status(402).json({
        type: 'error',
        error: {
          type: 'insufficient_funds',
          message: 'Puter AI quota exceeded for this account. Please wait for reset or use a different Puter account.'
        }
      });
    }

    console.error('❌ Unexpected error from Puter:', err);
    res.status(500).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: err?.message || 'Unknown error from Puter'
      }
    });
  }
});


// Models endpoint — Claude Code queries this to list available models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'claude-opus-4-6',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'Claude Opus 4.6 (via Puter)'
      },
      {
        id: 'claude-sonnet-4-6',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'Claude Sonnet 4.6 (via Puter)'
      },
      {
        id: 'claude-haiku-4-5',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'Claude Haiku 4.5 (via Puter)'
      },
      {
        id: 'gpt-4o',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'GPT-4o (via Puter)'
      },
      {
        id: 'gpt-4o-mini',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'GPT-4o Mini (via Puter)'
      },
      {
        id: 'gemini-2.0-flash',
        object: 'model',
        created: 1709251200,
        owned_by: 'puter-proxy',
        display_name: 'Gemini 2.0 Flash (via Puter)'
      }
    ]
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled promise rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`✅ puter-claude-proxy running at http://localhost:${PORT}`);
  console.log(`📡 Routing → Puter.js → Claude (free)`);
  console.log(`🔍 Debug: ${DEBUG} | Model: ${process.env.DEFAULT_MODEL}`);
});