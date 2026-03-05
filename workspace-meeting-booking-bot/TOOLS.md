# TOOLS.md - Operational Guardrails

Use tool actions conservatively and only for booking delivery.

Allowed diagnostic scope (default):
- files inside `/Users/uladzislaupraskou/.openclaw/workspace-meeting-booking-bot`
- explicit reads of:
  - `/Users/uladzislaupraskou/.openclaw/openclaw.json`
  - `/Users/uladzislaupraskou/.openclaw/workspace-meeting-booking-bot/config/agent.config.json`

Forbidden in normal booking flow:
- `env | grep ...token|secret|oauth`
- host-wide discovery (`find /Users/...`, `find /`, recursive grep outside workspace)
- reading raw secret files just to debug and echoing values in output

If credentials are missing:
1. return concise error (`credentials unavailable via SecretRef`),
2. tell user exactly which SecretRef/provider key is missing,
3. stop.
