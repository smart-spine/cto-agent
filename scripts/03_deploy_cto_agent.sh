#!/usr/bin/env bash

set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
if [[ -n "${SCRIPT_SOURCE}" && "${SCRIPT_SOURCE}" != "bash" && "${SCRIPT_SOURCE}" != "-" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
elif [[ -f "./scripts/lib/common.sh" ]]; then
  SCRIPT_DIR="$(cd "./scripts" && pwd)"
elif [[ -f "./lib/common.sh" ]]; then
  SCRIPT_DIR="$(pwd)"
else
  echo "[ERROR] Could not resolve script directory. Run from repo root: ./scripts/03_deploy_cto_agent.sh" >&2
  exit 1
fi
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json"
CTO_REPO_URL="${CTO_REPO_URL:-https://github.com/smart-spine/cto-agent.git}"
CTO_REPO_BRANCH="${CTO_REPO_BRANCH:-main}"
CTO_MODEL="${CTO_MODEL:-openai/gpt-5.2}"
BIND_GROUP_ID="${BIND_GROUP_ID:-}"
BIND_TOPIC_ID="${BIND_TOPIC_ID:-}"
TELEGRAM_ALLOWED_USER_ID="${TELEGRAM_ALLOWED_USER_ID:-}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

TMP_REPO_DIR=""

cleanup() {
  if [[ -n "${TMP_REPO_DIR}" && -d "${TMP_REPO_DIR}" ]]; then
    rm -rf "${TMP_REPO_DIR}"
  fi
}
trap cleanup EXIT

resolve_repo_branch() {
  local requested="$1"
  if git ls-remote --exit-code --heads "${CTO_REPO_URL}" "refs/heads/${requested}" >/dev/null 2>&1; then
    printf "%s" "${requested}"
    return 0
  fi
  if git ls-remote --exit-code --heads "${CTO_REPO_URL}" "refs/heads/main" >/dev/null 2>&1; then
    if [[ "${requested}" != "main" ]]; then
      log_warn "Requested branch '${requested}' not found. Falling back to 'main'."
    fi
    printf "main"
    return 0
  fi
  die "Could not resolve a valid branch in ${CTO_REPO_URL}."
}

clone_cto_repo() {
  local resolved_branch="$1"
  TMP_REPO_DIR="$(mktemp -d)"
  log_info "Cloning CTO repository branch '${resolved_branch}'."
  git clone --depth 1 --branch "${resolved_branch}" "${CTO_REPO_URL}" "${TMP_REPO_DIR}" >/dev/null
  [[ -d "${TMP_REPO_DIR}/workspace-factory" ]] || die "workspace-factory not found in cloned repo."
}

sync_cto_workspace() {
  local source_workspace="${TMP_REPO_DIR}/workspace-factory"
  local target_workspace="${OPENCLAW_HOME}/workspace-factory"
  ensure_dir "${target_workspace}"

  local target_has_memory="false"
  if [[ -d "${target_workspace}/.cto-brain" ]]; then
    target_has_memory="true"
  fi

  log_info "Syncing workspace-factory files."
  rsync -a --delete --exclude '.cto-brain/' "${source_workspace}/" "${target_workspace}/"

  if [[ -d "${source_workspace}/.cto-brain" ]]; then
    ensure_dir "${target_workspace}/.cto-brain"
    if [[ "${target_has_memory}" == "true" ]]; then
      log_info "Merging source memory into existing target .cto-brain without overwriting existing notes."
      rsync -a --ignore-existing "${source_workspace}/.cto-brain/" "${target_workspace}/.cto-brain/"
    else
      log_info "Copying .cto-brain memory seed from source repository."
      rsync -a "${source_workspace}/.cto-brain/" "${target_workspace}/.cto-brain/"
    fi
  else
    log_warn "Source repository does not contain .cto-brain (git-ignored). Existing target memory was preserved."
  fi
}

rewrite_hardcoded_paths() {
  local target_workspace="${OPENCLAW_HOME}/workspace-factory"
  log_info "Rewriting hardcoded local paths in copied CTO files."
  python3 - "${target_workspace}" "${OPENCLAW_HOME}" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
openclaw_home = sys.argv[2]
needle = "/Users/uladzislaupraskou/.openclaw"
extensions = {".md", ".sh", ".txt", ".json", ".yaml", ".yml"}
updated = 0

for path in root.rglob("*"):
    if not path.is_file():
        continue
    if path.suffix not in extensions:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        continue
    if needle not in text:
        continue
    path.write_text(text.replace(needle, openclaw_home), encoding="utf-8")
    updated += 1

print(updated)
PY
}

upsert_cto_agent_config() {
  local config_path="${OPENCLAW_CONFIG_PATH}"
  backup_file "${config_path}"
  python3 - "${config_path}" "${OPENCLAW_HOME}" "${CTO_MODEL}" <<'PY'
import json
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
openclaw_home = pathlib.Path(sys.argv[2])
cto_model = sys.argv[3]

data = json.loads(config_path.read_text(encoding="utf-8"))

agents = data.setdefault("agents", {})
if isinstance(agents, list):
    agents = {"list": agents}
    data["agents"] = agents

agent_list = agents.setdefault("list", [])
cto_payload = {
    "id": "cto-factory",
    "default": False,
    "name": "CTO Factory",
    "workspace": str(openclaw_home / "workspace-factory"),
    "agentDir": str(openclaw_home / "agents/cto-factory/agent"),
    "model": {"primary": cto_model},
    "identity": {
        "name": "CTO Factory Agent",
        "theme": "engineering",
        "emoji": "factory",
    },
}

found = False
for i, item in enumerate(agent_list):
    if isinstance(item, dict) and item.get("id") == "cto-factory":
        agent_list[i] = cto_payload
        found = True
        break
if not found:
    agent_list.append(cto_payload)

tools = data.setdefault("tools", {})
sessions = tools.setdefault("sessions", {})
sessions["visibility"] = "all"

agent_to_agent = tools.setdefault("agentToAgent", {})
agent_to_agent["enabled"] = True
allow = agent_to_agent.get("allow", [])
if not isinstance(allow, list):
    allow = []
for name in ("cto-factory", "main"):
    if name not in allow:
        allow.append(name)
agent_to_agent["allow"] = allow

config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
}

apply_cto_binding() {
  local group_id="$1"
  local topic_id="$2"
  local config_path="${OPENCLAW_CONFIG_PATH}"
  backup_file "${config_path}"
  python3 - "${config_path}" "${group_id}" "${topic_id}" "${TELEGRAM_ALLOWED_USER_ID}" "${TELEGRAM_BOT_TOKEN:-}" <<'PY'
import json
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
group_id = sys.argv[2]
topic_id = sys.argv[3]
allowed_uid = sys.argv[4].strip()
telegram_bot_token = sys.argv[5]

data = json.loads(config_path.read_text(encoding="utf-8"))

bindings = data.setdefault("bindings", [])
bindings = [b for b in bindings if not (isinstance(b, dict) and b.get("agentId") == "cto-factory")]
bindings.append(
    {
        "agentId": "cto-factory",
        "match": {
            "channel": "telegram",
            "accountId": "default",
            "peer": {"kind": "group", "id": f"{group_id}:topic:{topic_id}"},
        },
    }
)
data["bindings"] = bindings

channels = data.setdefault("channels", {})
telegram = channels.setdefault("telegram", {})
telegram["enabled"] = True
telegram.setdefault("commands", {})["native"] = True
default_account = telegram.setdefault("accounts", {}).setdefault("default", {})
if telegram_bot_token:
    default_account["botToken"] = telegram_bot_token
telegram.setdefault("groupPolicy", "allowlist")

groups = telegram.setdefault("groups", {})
group_cfg = groups.setdefault(group_id, {})
group_cfg.setdefault("groupPolicy", "allowlist")
topics = group_cfg.setdefault("topics", {})
topic_cfg = topics.setdefault(topic_id, {})
topic_cfg.setdefault("requireMention", False)
topic_cfg.setdefault("groupPolicy", "allowlist")

if allowed_uid:
    global_allow = set(str(x) for x in telegram.get("groupAllowFrom", []) if str(x).strip())
    global_allow.add(allowed_uid)
    telegram["groupAllowFrom"] = sorted(global_allow)
    group_allow = set(str(x) for x in group_cfg.get("allowFrom", []) if str(x).strip())
    group_allow.add(allowed_uid)
    group_cfg["allowFrom"] = sorted(group_allow)

config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
}

run_health_checks() {
  log_info "Running deployment health checks."
  local validate_out
  validate_out="$(with_openclaw_env openclaw config validate --json 2>&1 || true)"
  if ! printf "%s" "${validate_out}" | jq -e '.valid == true' >/dev/null 2>&1; then
    printf "%s\n" "${validate_out}" >&2
    die "openclaw config validate failed after CTO deployment."
  fi

  codex --version >/dev/null

  local cto_output=""
  if ! cto_output="$(with_openclaw_env openclaw agent --local --agent cto-factory --message "Reply with CTO_FACTORY_OK and one sentence status." --json --timeout 240 2>&1)"; then
    printf "%s\n" "${cto_output}" >&2
    die "CTO agent local call failed."
  fi
  if ! printf "%s" "${cto_output}" | grep -q "CTO_FACTORY_OK"; then
    log_warn "CTO local call succeeded but did not return CTO_FACTORY_OK marker."
  fi
}

collect_binding_inputs() {
  if [[ -n "${BIND_GROUP_ID}" && -n "${BIND_TOPIC_ID}" ]]; then
    return 0
  fi
  if [[ "${NON_INTERACTIVE}" == "true" ]]; then
    die "Set BIND_GROUP_ID and BIND_TOPIC_ID when NON_INTERACTIVE=true."
  fi
  read -r -p "Group ID: " BIND_GROUP_ID
  read -r -p "Topic ID: " BIND_TOPIC_ID
  [[ -n "${BIND_GROUP_ID}" ]] || die "Group ID is required."
  [[ -n "${BIND_TOPIC_ID}" ]] || die "Topic ID is required."
}

main() {
  require_cmd git
  require_cmd rsync
  require_cmd jq
  require_cmd python3
  require_cmd openclaw
  require_cmd codex

  [[ -f "${OPENCLAW_CONFIG_PATH}" ]] || die "Missing ${OPENCLAW_CONFIG_PATH}. Run Script 1 first."

  log_info "Stage 1/7: Resolving repository branch."
  local resolved_branch
  resolved_branch="$(resolve_repo_branch "${CTO_REPO_BRANCH}")"
  log_info "Using CTO source branch: ${resolved_branch}"

  log_info "Stage 2/7: Cloning CTO repository."
  clone_cto_repo "${resolved_branch}"

  log_info "Stage 3/7: Syncing CTO workspace files."
  sync_cto_workspace
  rewrite_hardcoded_paths
  ensure_dir "${OPENCLAW_HOME}/agents/cto-factory/agent"

  log_info "Stage 4/7: Applying CTO agent config patch."
  upsert_cto_agent_config

  log_info "Stage 5/7: Restarting gateway before health checks."
  restart_gateway_background
  if ! wait_for_gateway_health 90; then
    die "Gateway health check timed out during CTO deployment."
  fi

  log_info "Stage 6/7: Validating CTO deployment health."
  run_health_checks

  log_info "Stage 7/7: Applying Telegram binding for CTO."
  echo "Deploy ready. Please enter groupid and topic to bind the CTO bot"
  collect_binding_inputs
  apply_cto_binding "${BIND_GROUP_ID}" "${BIND_TOPIC_ID}"

  local validate_out
  validate_out="$(with_openclaw_env openclaw config validate --json 2>&1 || true)"
  if ! printf "%s" "${validate_out}" | jq -e '.valid == true' >/dev/null 2>&1; then
    printf "%s\n" "${validate_out}" >&2
    die "openclaw config validate failed after binding update."
  fi

  restart_gateway_background
  if ! wait_for_gateway_health 90; then
    die "Gateway health check timed out after binding update."
  fi

  log_info "CTO agent deployment completed successfully."
  log_info "Bound target: ${BIND_GROUP_ID}:topic:${BIND_TOPIC_ID}"
}

main "$@"
