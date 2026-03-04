# reddit-openclaw-watcher

Agent: Reddit OpenClaw Watcher
Responsibility: Watch both `https://www.reddit.com/r/openclaw/.rss` and Reddit RSS search for `OpenClaw OR ClawdBot`, merge/deduplicate posts, and send only new posts from the last hour to Telegram group `-1003633569118`, topic `220`.
Message format: One post per message, exactly two lines (`title` + `link`).
State policy:
- Persistent local state file: `config/state.json`.
- Dedup entries are pruned every run to keep only last-hour entries.
Failure policy:
- Fetch retry attempts per run: 3.
- Failure alert is emitted only when the consecutive failure count reaches 3.
Credentials:
- No plaintext secrets in this workspace.
- Use OpenClaw runtime credentials only.
Skills:
- rss-parse
- last-hour-filter
- dedup-state-prune
- failure-threshold-notify
- telegram-routing
- unit-test
