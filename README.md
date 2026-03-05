# CTO Agent Pack for OpenClaw

This repository contains a production-ready **CTO Factory agent** for OpenClaw — an AI engineering manager that builds and operates other OpenClaw agents on your behalf.

It does not write code directly — it delegates all implementation to **Codex CLI** (`codex exec`) through a strict delivery pipeline:

`INTAKE → INTAKE_SURVEY → RESEARCH → PREFLIGHT → PROVIDER_MODEL_PREFLIGHT → BACKUP → CODE → TEST → CONFIG_QA → CONTEXT_COMPRESS → MEMORY_GARDEN → READY_FOR_APPLY → APPLY → SMOKE → DONE/ROLLBACK`

## What's inside

- `workspace-factory/` — agent personality, rules, and prompts (`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `PROMPTS.md`, `USER.md`, `TOOLS.md`)
- `workspace-factory/skills/` — modular skills (`factory-codegen`, `factory-create-agent`, `factory-config-qa`, `factory-openclaw-ops`, `factory-gateway-restart`, etc.)
- `workspace-factory/scripts/` — operational helper scripts (e.g., detached gateway restart with callback)

## Prerequisites

Before installation, prepare:

1. **Server access** with a sudo-capable user
2. **Network access** to GitHub and npm registries
3. **LLM provider API key** (OpenAI / OpenRouter / Anthropic, etc.)
4. **Telegram bot token** if you want Telegram integration

## Automated Script Order

Run scripts from the repository root, as files (do not paste script contents into the shell):

```bash
cd /path/to/cto-agent
chmod +x scripts/lib/common.sh scripts/00_bootstrap_dependencies.sh scripts/01_install_openclaw.sh scripts/02_setup_telegram_pairing.sh scripts/03_deploy_cto_agent.sh

# 0) Base OS dependencies (Ubuntu/Debian)
./scripts/00_bootstrap_dependencies.sh

# 1) Install OpenClaw + Codex + local runtime config
./scripts/01_install_openclaw.sh

# 2) Optional: Telegram pairing
./scripts/02_setup_telegram_pairing.sh

# 3) Deploy CTO factory agent and bind topic
./scripts/03_deploy_cto_agent.sh
```

`scripts/01_install_openclaw.sh` will ask how to set `OPENCLAW_GATEWAY_TOKEN`:
- auto-generate (recommended)
- enter manually

You can force mode in advance:

```bash
# always auto-generate (useful for CI/non-interactive runs)
export GATEWAY_TOKEN_MODE=auto

# require manual token input (or pre-set OPENCLAW_GATEWAY_TOKEN)
export GATEWAY_TOKEN_MODE=manual
```

## Zero-to-Server Bootstrap (copy-paste on clean Ubuntu)

If the server is fresh and does not even have `git`, run this single command first:

```bash
sudo bash -lc 'apt-get update -qq && apt-get install -y -qq ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/smart-spine/cto-agent/openclaw-root-monorepo/scripts/00_bootstrap_dependencies.sh | bash'
```

What it does:
- installs base dependencies (`git`, `python3`, `jq`, `rsync`, etc.)
- clones this repository to `$HOME/cto-agent`
- prints the exact next commands to continue (`01 -> 02 -> 03`)

## Installation

> **This README is designed to be fed to a code agent (e.g., Cursor, Windsurf, Claude Code, etc.).**
> The code agent should read this file and execute the steps in order, asking the user for any missing values.

### Step 0: Set variables

```bash
export CTO_REPO="/absolute/path/to/this/cloned/repo"
export OC_ROOT="$HOME/.openclaw"
```

### Step 1: Preflight checks

Verify that the following commands succeed:

```bash
openclaw --version
codex --version
python3 --version
jq --version
rsync --version
```

If `codex` is not found, stop and tell the user:
> "Codex CLI is required for the CTO agent to work. Install it with `npm install -g @openai/codex`, then authenticate on this server using an OpenAI API key (`printenv OPENAI_API_KEY | codex login --with-api-key`)."

### Step 2: Backup (if existing OpenClaw)

If `$OC_ROOT/openclaw.json` already exists, create a timestamped backup:

```bash
cp "$OC_ROOT/openclaw.json" "$OC_ROOT/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)"
```

### Step 3: Copy workspace files

```bash
mkdir -p "$OC_ROOT/workspace-factory"
mkdir -p "$OC_ROOT/agents/cto-factory/agent"

# Sync workspace (preserve .cto-brain/ memory if it already exists)
rsync -a --exclude='.cto-brain/' "$CTO_REPO/workspace-factory/" "$OC_ROOT/workspace-factory/"
```

### Step 4: Configure `openclaw.json`

> **IMPORTANT**: Do NOT replace the entire `openclaw.json`. Merge the CTO agent into the existing config.
> If `openclaw.json` does not exist, create a minimal one first using `openclaw onboard` or by building it manually.

#### 4a. Add `cto-factory` to the `agents.list` array

Insert a new object into the `agents.list` array. If `cto-factory` already exists, update it in place.

```json
{
  "id": "cto-factory",
  "default": false,
  "name": "CTO Factory",
  "workspace": "/absolute/path/to/.openclaw/workspace-factory",
  "agentDir": "/absolute/path/to/.openclaw/agents/cto-factory/agent",
  "model": {
    "primary": "openrouter/openai/gpt-5.3-codex"
  }
}
```

#### 4b. Add a binding for the CTO agent

Insert a new binding into the `bindings` array. This tells OpenClaw which chat/channel the CTO agent should listen on.

```json
{
  "agentId": "cto-factory",
  "match": {
    "channel": "telegram",
    "accountId": "default",
    "peer": {
      "kind": "group",
      "id": "-1003633569118:topic:654"
    }
  }
}
```

> For console-only usage (no Telegram), use:
> ```json
> { "agentId": "cto-factory", "match": { "channel": "console" } }
> ```

#### 4c. Enable agent-to-agent communication (recommended)

Add or merge into the root `tools` section:

```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["cto-factory"]
    },
    "sessions": {
      "visibility": "all"
    }
  }
}
```

If existing `allow` list already has agents, append `"cto-factory"` to it — do not replace.

#### 4d. Configure the channel (if Telegram)

If the user chose Telegram, ensure the `channels.telegram` section exists with:

- `enabled: true`
- `accounts.default.botToken` set to `"${TELEGRAM_BOT_TOKEN}"` (env reference, not plaintext)
- The appropriate group/topic added to the allowlist
- The Telegram user ID that should be allowed to interact with the agent

#### 4e. Create the model catalog

Create `$OC_ROOT/agents/cto-factory/agent/models.json` if it does not exist. Use the provider actually configured in your OpenClaw instance.

### Step 5: Set up secrets

Create or update `$OC_ROOT/.env` with the necessary API keys:

```dotenv
OPENROUTER_API_KEY=your_openrouter_api_key
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

> **NEVER** put plaintext API keys into `openclaw.json`. Always use environment variable references.

### Step 6: Validate

```bash
cd "$OC_ROOT"
openclaw config validate --json
```

This must return valid output. If it fails, fix the errors before proceeding.

### Step 7: Start the gateway

**Fresh install:**
```bash
openclaw gateway start
```

**Existing install (already running):**
```bash
openclaw gateway restart
```

Then verify:
```bash
openclaw gateway status
```

Expect to see `RPC probe: ok` in the output.

### Step 8: Smoke test

Send a test message to the CTO agent:

```bash
openclaw agent --agent cto-factory --message "Run preflight and report status" --json
```

If the agent responds with a status report, the installation is complete.

## LLM execution contract (strict)

If an LLM code agent is executing this installation, it MUST:

1. **Preflight**: confirm `openclaw`, `codex`, `python3`, `jq`, and `rsync` are available.
   - If `codex` is not found, stop and inform the user that Codex CLI must be installed and authenticated with an OpenAI API key on this host.
2. **CTO code policy**: all implementation code changes must be produced via Codex CLI (`codex exec`) and then tested.
3. **Ask the user** for any missing values (model, channel, IDs, and tokens) before modifying config.
4. **Backup**: copy existing `openclaw.json` to a timestamped backup.
5. **Sync files**: copy `workspace-factory/` and ensure `agents/cto-factory/agent/` dir exists.
6. **Merge config**: insert the CTO agent into `openclaw.json` without deleting or overwriting existing agents, bindings, or channel configs.
7. **Validate**: `openclaw config validate --json` must pass cleanly.
8. **Start or restart** the gateway.
9. **Smoke check**: send a test message and confirm the agent responds.

If any step fails, **stop and report the exact failing command and error output**. Do not attempt to proceed.

## Security notes

- Keep `.env`, `secrets/`, `credentials/`, `identity/`, and runtime session files out of git.
- Never place API tokens directly into `openclaw.json` — use `"${ENV_VAR_NAME}"` references.
- Use environment-backed SecretRef fields whenever possible.
