# Google OAuth One-Time Bootstrap

Goal: exchange a Google OAuth authorization code for a long-lived refresh token, then store it in a SecretRef-compatible file.

## Prerequisites

- `client_secret.json` from Google Cloud OAuth client config.
- An authorization code generated with `access_type=offline` and `prompt=consent`.
- A secure output path for refresh token file (outside git, file mode `600`).

## Run

```bash
cd /Users/uladzislaupraskou/.openclaw/workspace-meeting-booking-bot
node tools/bootstrap-google-oauth-refresh-token.js \
  --auth-code '<AUTH_CODE>' \
  --client-secret-file /secure/path/client_secret.json \
  --refresh-token-file /secure/path/google-oauth-refresh-token.json \
  --redirect-uri 'http://localhost:8080/oauth2callback'
```

Notes:
- `--redirect-uri` can be omitted if it exists in `client_secret.json` under `installed.redirect_uris[0]` or `web.redirect_uris[0]`.
- Script output never prints token values.

## SecretRef Mapping

`config/agent.config.json` expects:
- `credentials.clientSecret` from provider `google-client-secret-file`, id `value`
- `credentials.refreshToken` from provider `google-oauth-refresh-token-file`, id `value`

Refresh token file format:

```json
{
  "value": "<refresh_token>"
}
```
