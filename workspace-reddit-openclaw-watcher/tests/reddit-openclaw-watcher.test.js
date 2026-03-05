const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_SUBREDDIT_RSS_URL,
  FAILURE_NOTIFY_THRESHOLD,
  buildFeedUrls,
  filterRecentPosts,
  mergeAndDeduplicatePosts,
  parseRssFeed,
  pruneStateEntries,
  runWatcher,
  selectNewPosts,
  shouldNotifyFailure,
} = require("../tools/reddit-openclaw-watcher.js");

function mkStateFile(initialState) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reddit-openclaw-watcher-"));
  const stateFile = path.join(directory, "state.json");
  if (initialState) {
    fs.writeFileSync(stateFile, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  }
  return stateFile;
}

function makeResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return body;
    },
  };
}

test("buildFeedUrls returns subreddit+search defaults and respects explicit urls", () => {
  const defaults = buildFeedUrls({});
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0], DEFAULT_SUBREDDIT_RSS_URL);
  assert.equal(defaults[1], "https://www.reddit.com/search.rss?q=OpenClaw%20OR%20ClawdBot&sort=new");

  const explicit = buildFeedUrls({
    urls: [" https://example.test/one ", "", "https://example.test/two", "https://example.test/one"],
  });
  assert.deepEqual(explicit, ["https://example.test/one", "https://example.test/two"]);
});

test("parseRssFeed parses RSS item blocks and Atom entry blocks", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <root>
      <channel>
        <item>
          <title><![CDATA[OpenClaw &amp; release]]></title>
          <link>https://www.reddit.com/r/openclaw/comments/a1/openclaw_release/</link>
          <guid>t3_a1</guid>
          <pubDate>Wed, 04 Mar 2026 10:40:00 GMT</pubDate>
        </item>
      </channel>
      <feed>
        <entry>
          <title>ClawdBot mention</title>
          <id>t3_b2</id>
          <updated>2026-03-04T10:50:00Z</updated>
          <link rel="alternate" href="https://www.reddit.com/r/openclaw/comments/b2/clawdbot_mention/" />
        </entry>
      </feed>
    </root>`;

  const posts = parseRssFeed(xml);

  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], {
    id: "t3_a1",
    title: "OpenClaw & release",
    link: "https://www.reddit.com/r/openclaw/comments/a1/openclaw_release/",
    publishedAtMs: Date.parse("2026-03-04T10:40:00.000Z"),
    publishedAt: "2026-03-04T10:40:00.000Z",
  });
  assert.equal(posts[1].id, "t3_b2");
  assert.equal(
    posts[1].link,
    "https://www.reddit.com/r/openclaw/comments/b2/clawdbot_mention/",
  );
});

test("filterRecentPosts keeps only posts from the last hour", () => {
  const nowMs = Date.parse("2026-03-04T11:00:00.000Z");

  const recentPosts = filterRecentPosts(
    [
      { id: "new", publishedAtMs: Date.parse("2026-03-04T10:59:00.000Z") },
      { id: "edge", publishedAtMs: Date.parse("2026-03-04T10:00:00.000Z") },
      { id: "old", publishedAtMs: Date.parse("2026-03-04T09:59:59.000Z") },
      { id: "invalid", publishedAtMs: null },
    ],
    nowMs,
  );

  assert.deepEqual(
    recentPosts.map((post) => post.id),
    ["edge", "new"],
  );
});

test("dedup and pruning keep only last-hour entries and only unseen posts", () => {
  const nowMs = Date.parse("2026-03-04T11:00:00.000Z");

  const pruned = pruneStateEntries(
    [
      { id: "old", seenAt: "2026-03-04T08:59:59.000Z" },
      { id: "seen", seenAt: "2026-03-04T10:30:00.000Z" },
      { id: "seen-dup", seenAt: "invalid-date" },
    ],
    nowMs,
  );

  assert.deepEqual(pruned, [{ id: "seen", seenAt: "2026-03-04T10:30:00.000Z" }]);

  const newPosts = selectNewPosts(
    [
      { id: "seen", title: "Already known", link: "https://example.com/seen" },
      { id: "new", title: "New mention", link: "https://example.com/new" },
      { id: "new", title: "Duplicate mention", link: "https://example.com/new" },
    ],
    pruned,
  );

  assert.equal(newPosts.length, 1);
  assert.equal(newPosts[0].id, "new");
});

test("mergeAndDeduplicatePosts deduplicates across feed collections by id or link", () => {
  const merged = mergeAndDeduplicatePosts([
    [
      { id: "one", title: "One", link: "https://example.test/one" },
      { id: "same-id", title: "First same id", link: "https://example.test/same-id-a" },
      { id: "same-link-a", title: "First same link", link: "https://example.test/same-link" },
    ],
    [
      { id: "two", title: "Two", link: "https://example.test/two" },
      { id: "same-id", title: "Second same id", link: "https://example.test/same-id-b" },
      { id: "same-link-b", title: "Second same link", link: "https://example.test/same-link" },
    ],
  ]);

  assert.deepEqual(
    merged.map((post) => post.id),
    ["one", "same-id", "same-link-a", "two"],
  );
});

test("runWatcher polls both feeds, merges+dedups, and persists pruned state", async () => {
  const nowMs = Date.parse("2026-03-04T11:00:00.000Z");
  const stateFile = mkStateFile({
    updatedAt: "2026-03-04T10:40:00.000Z",
    consecutiveFailures: 0,
    entries: [
      { id: "seen", seenAt: "2026-03-04T10:40:00.000Z" },
      { id: "expired", seenAt: "2026-03-04T09:30:00.000Z" },
    ],
  });

  const subredditUrl = "https://example.test/subreddit.rss";
  const searchUrl = "https://example.test/search.rss";
  const subredditRss = `<?xml version="1.0"?>
    <rss>
      <channel>
        <item>
          <title>Seen mention</title>
          <link>https://www.reddit.com/r/openclaw/comments/seen/</link>
          <guid>seen</guid>
          <pubDate>Wed, 04 Mar 2026 10:45:00 GMT</pubDate>
        </item>
        <item>
          <title>Subreddit fresh</title>
          <link>https://www.reddit.com/r/openclaw/comments/sub-new/</link>
          <guid>sub-new</guid>
          <pubDate>Wed, 04 Mar 2026 10:55:00 GMT</pubDate>
        </item>
        <item>
          <title>Duplicate by id (subreddit wins)</title>
          <link>https://www.reddit.com/r/openclaw/comments/dup-id-primary/</link>
          <guid>dup-id</guid>
          <pubDate>Wed, 04 Mar 2026 10:56:00 GMT</pubDate>
        </item>
        <item>
          <title>Duplicate by link (subreddit wins)</title>
          <link>https://www.reddit.com/r/openclaw/comments/same-link/</link>
          <guid>link-a</guid>
          <pubDate>Wed, 04 Mar 2026 10:58:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`;

  const searchRss = `<?xml version="1.0"?>
    <rss>
      <channel>
        <item>
          <title>Search fresh</title>
          <link>https://www.reddit.com/r/openclaw/comments/search-new/</link>
          <guid>search-new</guid>
          <pubDate>Wed, 04 Mar 2026 10:54:00 GMT</pubDate>
        </item>
        <item>
          <title>Duplicate by id (search loses)</title>
          <link>https://www.reddit.com/r/openclaw/comments/dup-id-secondary/</link>
          <guid>dup-id</guid>
          <pubDate>Wed, 04 Mar 2026 10:56:30 GMT</pubDate>
        </item>
        <item>
          <title>Duplicate by link (search loses)</title>
          <link>https://www.reddit.com/r/openclaw/comments/same-link/</link>
          <guid>link-b</guid>
          <pubDate>Wed, 04 Mar 2026 10:58:30 GMT</pubDate>
        </item>
      </channel>
    </rss>`;

  const callsByUrl = new Map();
  const fetchImpl = async (url) => {
    const calls = (callsByUrl.get(url) || 0) + 1;
    callsByUrl.set(url, calls);

    if (url === subredditUrl && calls < 3) {
      throw new Error("temporary network failure");
    }

    if (url === subredditUrl) {
      return makeResponse(subredditRss);
    }
    if (url === searchUrl) {
      return makeResponse(searchRss);
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const first = await runWatcher({
    fetchImpl,
    stateFile,
    nowMs,
    urls: [subredditUrl, searchUrl],
    fetchAttempts: 3,
    retryDelayMs: 0,
  });

  assert.equal(callsByUrl.get(subredditUrl), 3);
  assert.equal(callsByUrl.get(searchUrl), 1);
  assert.equal(first.status, "ok");
  assert.equal(first.attemptsUsed, 4);
  assert.deepEqual(first.urls, [subredditUrl, searchUrl]);
  assert.equal(first.newCount, 4);
  assert.equal(first.recentCount, 5);
  assert.deepEqual(first.telegramMessages, [
    "Search fresh\nhttps://www.reddit.com/r/openclaw/comments/search-new/",
    "Subreddit fresh\nhttps://www.reddit.com/r/openclaw/comments/sub-new/",
    "Duplicate by id (subreddit wins)\nhttps://www.reddit.com/r/openclaw/comments/dup-id-primary/",
    "Duplicate by link (subreddit wins)\nhttps://www.reddit.com/r/openclaw/comments/same-link/",
  ]);
  assert.deepEqual(
    first.newPosts.map((post) => post.id),
    ["search-new", "sub-new", "dup-id", "link-a"],
  );

  const second = await runWatcher({
    fetchImpl: async (url) => {
      if (url === subredditUrl) {
        return makeResponse(subredditRss);
      }
      if (url === searchUrl) {
        return makeResponse(searchRss);
      }
      throw new Error(`unexpected url: ${url}`);
    },
    stateFile,
    nowMs: nowMs + 30 * 1000,
    urls: [subredditUrl, searchUrl],
    fetchAttempts: 1,
    retryDelayMs: 0,
  });

  assert.equal(second.status, "ok");
  assert.equal(second.newCount, 0);
  assert.deepEqual(second.telegramMessages, []);

  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persisted.consecutiveFailures, 0);
  assert.deepEqual(
    persisted.entries.map((entry) => entry.id).sort(),
    ["dup-id", "link-a", "search-new", "seen", "sub-new"],
  );
});

test("failure threshold notifier fires only on third consecutive failure", async () => {
  const stateFile = mkStateFile({
    updatedAt: null,
    consecutiveFailures: 0,
    entries: [],
  });

  const fetchImpl = async () => {
    throw new Error("source unavailable");
  };

  const first = await runWatcher({
    fetchImpl,
    stateFile,
    nowMs: Date.parse("2026-03-04T11:00:00.000Z"),
    url: "https://example.test/rss",
    fetchAttempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(first.status, "error");
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.notifyFailure, false);
  assert.equal(first.telegramMessages.length, 0);

  const second = await runWatcher({
    fetchImpl,
    stateFile,
    nowMs: Date.parse("2026-03-04T12:00:00.000Z"),
    url: "https://example.test/rss",
    fetchAttempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.notifyFailure, false);

  const third = await runWatcher({
    fetchImpl,
    stateFile,
    nowMs: Date.parse("2026-03-04T13:00:00.000Z"),
    url: "https://example.test/rss",
    fetchAttempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(third.consecutiveFailures, FAILURE_NOTIFY_THRESHOLD);
  assert.equal(third.notifyFailure, true);
  assert.equal(third.telegramMessages.length, 1);
  assert.match(third.telegramMessages[0], /failed 3 consecutive runs/i);

  const fourth = await runWatcher({
    fetchImpl,
    stateFile,
    nowMs: Date.parse("2026-03-04T14:00:00.000Z"),
    url: "https://example.test/rss",
    fetchAttempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(fourth.consecutiveFailures, 4);
  assert.equal(fourth.notifyFailure, false);
  assert.equal(fourth.telegramMessages.length, 0);

  assert.equal(shouldNotifyFailure(2, 3), true);
  assert.equal(shouldNotifyFailure(3, 4), false);
});
