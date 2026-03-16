# puter-claude-proxy

A tiny Node.js proxy that lets you run **Claude Code** (the Claude CLI) against **Claude models hosted on Puter.js** instead of using your own Anthropic API key.

This is a **proof-of-concept v1**: it works, but it is constrained by Puter's own per-user AI quotas and should be treated as a **demo / experimental bridge**, not as a production way to get "infinite free Claude Code."

---

## What this does

- Exposes an **Anthropic-compatible `/v1/messages` API** on `http://localhost:3456`.
- Forwards requests to **Puter's `puter.ai.chat`** using your Puter account and auth token.
- Transparently maps Claude Code's model IDs (Haiku / Sonnet / Opus) to Puter's Claude models.
- Converts Puter's plain-text responses (with XML tool calls) into **Anthropic tool_use / tool_result blocks** so Claude Code's tool system works.
- Hard-disables Claude Code's built-in `WebSearch` / `WebFetch` tools to avoid burning Puter AI credits unnecessarily.
- Returns a clear 402 error when Puter's per-user AI quota is exhausted.

---

## What this does *not* do

- It does **not** give you truly unlimited Claude Code usage.
- It does **not** bypass Puter's `usage-limited-chat` quotas or billing model.
- It does **not** provide reliable web search from Claude Code; web tools are effectively disabled.

> Think of it as: "Run Claude Code on top of your own Puter account, with zero Anthropic billing for you as the developer, but subject to Puter's small per-user AI quotas."

---

## Requirements

- Node.js 18+ (tested with Node 22)
- A Puter account (free) at https://puter.com
- Claude Code CLI installed (`claude` command available)
- A Claude web / console account to complete the CLI login once (free tier is fine)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/codedpool/puter-claude-proxy.git
cd puter-claude-proxy
npm install
```

### 2. Get a Puter auth token (browser-based auth)

```bash
node auth.js
```

- A browser window will open.
- Log in or sign up to **Puter** in that window.
- When done, the script will print a token:

```
✅ Auth token received!

Add this to your .env file:
PUTER_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

Copy that value.

### 3. Create `.env`

```env
# Puter auth
PUTER_AUTH_TOKEN=PASTE_TOKEN_FROM_AUTH_JS

# Default model
DEFAULT_MODEL=claude-sonnet-4-6

# Claude tier mapping
PUTER_MODEL_HAIKU=claude-haiku-4-5
PUTER_MODEL_SONNET=claude-sonnet-4-6
PUTER_MODEL_OPUS=claude-opus-4-6

# Debug logging
DEBUG=true
PORT=3456
```

> Tip: To save Puter quota, map all tiers to Sonnet:
> ```env
> PUTER_MODEL_HAIKU=claude-sonnet-4-6
> PUTER_MODEL_SONNET=claude-sonnet-4-6
> PUTER_MODEL_OPUS=claude-sonnet-4-6
> ```

---

## How it works

### High-level flow

```
Claude Code CLI → puter-claude-proxy (/v1/messages) → puter.ai.chat → Claude (Haiku/Sonnet/Opus)
```

- Claude Code thinks it is talking to an Anthropic `/v1/messages` endpoint.
- The proxy converts the incoming Anthropic-style payload into a **Puter.js chat history** plus a `model` ID.
- It calls `puter.ai.chat(puterMessages, { model })`.
- Puter runs the request against Claude (or returns a quota error).
- The proxy parses Puter's response (text with optional XML tool calls), converts tool invocations into Anthropic `tool_use` blocks, and returns a normal Anthropic message object back to Claude Code.

### Model routing

The proxy maps Claude Code model IDs to Puter model names via `MODEL_MAP` in `server.js`. Supported models include Claude Haiku, Sonnet, Opus, GPT-4o, GPT-4o-mini, Gemini 2.0 Flash, o3-mini, and o1.

### Tool prompting and XML parsing

Claude Code sends a list of tools (Read, Edit, Bash, Glob, etc.). The proxy:

1. Builds a system prompt listing all tools with descriptions and JSON schemas.
2. Tells Claude to respond with tools in an XML envelope:

```xml
<function_calls>
  <invoke name="ToolName">
    <parameter name="param_name">value</parameter>
  </invoke>
</function_calls>
```

3. Parses that XML from Puter's text output and converts each invocation into an Anthropic `tool_use` block.
4. Returns the result to Claude Code with `stop_reason: 'tool_use'` when tools are present.

### WebSearch / WebFetch are disabled

Claude Code's tool list includes `WebFetch` and `WebSearch`. Using these via Puter quickly triggers paid web usage and hits quotas. The proxy post-processes responses and converts any `WebSearch` / `WebFetch` tool_use blocks into a `tool_result` with a disabled message, so Claude continues without burning credits.

### Error handling

The proxy distinguishes between:

- `status: 401` → invalid/expired `PUTER_AUTH_TOKEN` → regenerate with `node auth.js`
- `code: insufficient_funds` / `delegate: usage-limited-chat` → **Puter quota exceeded** → returns 402 with a clear message
- Everything else → 500 `api_error`

Proxy logs:
```
💸 Blocked by Puter quota: { ... }    ← quota hit
❌ Unexpected error from Puter: ...   ← other errors
--- Incoming Request ---              ← successful request
Raw reply: ...                        ← successful response
```

---

## Using with Claude Code

### 1. Start the proxy

```bash
cd puter-claude-proxy
node server.js
```

You should see:
```
✅ puter-claude-proxy running at http://localhost:3456
📡 Routing → Puter.js → Claude (free)
🔍 Debug: true | Model: claude-sonnet-4-6
```

### 2. Point Claude Code at the proxy

In the terminal where you run `claude` (Git Bash / Linux / Mac):

```bash
cd /your-project-repo
export ANTHROPIC_API_KEY="dummy"
export ANTHROPIC_BASE_URL="http://localhost:3456"
claude
```

On Windows PowerShell:
```powershell
$env:ANTHROPIC_API_KEY = "dummy"
$env:ANTHROPIC_BASE_URL = "http://localhost:3456"
claude
```

Then run `/login` in the Claude Code CLI and choose **Anthropic Console account**. Complete the browser OAuth once. After that, all Claude Code API traffic goes to your proxy instead of `https://api.anthropic.com`.

### 3. Example prompts that work well

```
scan this repo and summarize the main folders and their responsibilities, don't use web search
```
```
open src/core/streaming.ts and explain how streaming works
```
```
list all routes in src/app/api and suggest improvements
```

Avoid prompts that invite web search ("look up", "latest", "search for") to stay under Puter's quota.

---

## Quota, limitations, and honest expectations

### Puter's "free unlimited" vs reality

Puter markets Claude integration as "free unlimited" via Puter.js. In practice this is a **User Pays / usage-limited** model:

- Each logged-in Puter user gets some amount of AI usage.
- Heavier calls (long context, complex tool use, web search) go through a backend called `usage-limited-chat`.
- Once that internal quota is exceeded, Puter returns `insufficient_funds` (402).

Your proxy surfaces this clearly back to Claude Code as a 402 error.

### Analogy

Think of it like **mobile data on a prepaid SIM**:
- You (the developer) build the app and host nothing — zero infra cost.
- Every user watches video using **their own data plan** (Puter AI credits).
- When their data runs out, the app stops loading — not because your code broke, but because their plan is exhausted.

### What this means in practice

- You do **not** need an Anthropic API key or billing.
- Each Puter account has a **small, hidden AI quota**, especially for Opus calls and web tools.
- Once exhausted, switch Puter accounts or wait for a quota reset.
- Best used as a **local experiment / demo**, not a long-term production Claude Code setup.

---

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/messages` | POST | Main Anthropic-compatible messages endpoint |
| `/v1/models` | GET | Returns list of available models |
| `/health` | GET | Health check: `{ status: 'ok' }` |

---

## v1 Status

- ✅ Claude Code can run against Claude models hosted on Puter via a small Node proxy
- ✅ Tool prompting and XML-to-tool_use conversion works for filesystem tools
- ✅ WebSearch / WebFetch disabled to avoid quota burn
- ✅ Puter quota errors (402) surfaced clearly back to the client
- ✅ Multi-model routing (Haiku / Sonnet / Opus / GPT-4o / Gemini)
- ⚠ Subject to very limited Puter per-user quotas, especially for Opus and heavy usage
- ⚠ Not recommended as a primary daily Claude Code setup

### Future directions (not in v1)

- Multi-provider routing (Puter + OpenRouter + direct Anthropic)
- Configurable per-provider model maps
- Streaming support
- Better structured logging

---

## Switching back to default Claude Code

If you want to stop using the proxy and go back to normal Claude Code (talking directly to Anthropic), just unset the two env vars before starting `claude`.

**Git Bash / Linux / Mac:**
```bash
unset ANTHROPIC_API_KEY
unset ANTHROPIC_BASE_URL
claude
```

**Windows PowerShell:**
```powershell
Remove-Item Env:ANTHROPIC_API_KEY
Remove-Item Env:ANTHROPIC_BASE_URL
claude
```

Without `ANTHROPIC_BASE_URL` set, Claude Code goes back to talking directly to `https://api.anthropic.com` with your real Anthropic account — completely normal behavior, no proxy involved.

To switch back to proxy mode anytime:
```bash
export ANTHROPIC_API_KEY="dummy"
export ANTHROPIC_BASE_URL="http://localhost:3456"
claude
```

You can freely switch between the two depending on whether you want to use your real Anthropic quota or route through Puter.

---

## License

MIT
