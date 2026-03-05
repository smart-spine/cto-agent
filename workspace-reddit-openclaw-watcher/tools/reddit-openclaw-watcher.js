#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const FAILURE_NOTIFY_THRESHOLD = 3;
const DEFAULT_QUERY = "OpenClaw OR ClawdBot";
const DEFAULT_SUBREDDIT_RSS_URL = "https://www.reddit.com/r/openclaw/.rss";

const DEFAULT_STATE_FILE = path.join(__dirname, "..", "config", "state.json");

function buildRedditSearchRssUrl(query = DEFAULT_QUERY) {
  return `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new`;
}

function sanitizeUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveQuery(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return DEFAULT_QUERY;
}

function buildFeedUrls(options = {}) {
  if (Array.isArray(options.urls) && options.urls.length > 0) {
    return Array.from(
      new Set(
        options.urls
          .map((url) => sanitizeUrl(url))
          .filter((url) => typeof url === "string"),
      ),
    );
  }

  const query = resolveQuery(options.query);
  const subredditUrl = sanitizeUrl(options.subredditUrl) || DEFAULT_SUBREDDIT_RSS_URL;
  const searchUrl = sanitizeUrl(options.url) || buildRedditSearchRssUrl(query);
  return Array.from(new Set([subredditUrl, searchUrl]));
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function decodeHtmlEntities(value) {
  if (typeof value !== "string") {
    return "";
  }

  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const raw = isHex ? entity.slice(2) : entity.slice(1);
      const parsed = Number.parseInt(raw, isHex ? 16 : 10);
      if (!Number.isFinite(parsed)) {
        return full;
      }
      return String.fromCodePoint(parsed);
    }

    if (Object.prototype.hasOwnProperty.call(named, entity)) {
      return named[entity];
    }

    return full;
  });
}

function stripCdata(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return decodeHtmlEntities(stripTags(stripCdata(value))).replace(/\s+/g, " ").trim();
}

function extractTagText(block, tagName) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(regex);
  if (!match) {
    return null;
  }
  const normalized = normalizeText(match[1]);
  return normalized || null;
}

function extractLink(block) {
  const alternateHrefMatch = block.match(
    /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i,
  );
  if (alternateHrefMatch) {
    return decodeHtmlEntities(alternateHrefMatch[1]).trim();
  }

  const hrefMatch = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (hrefMatch) {
    return decodeHtmlEntities(hrefMatch[1]).trim();
  }

  const inlineMatch = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (inlineMatch) {
    return decodeHtmlEntities(normalizeText(inlineMatch[1]));
  }

  return null;
}

function parsePublishedAtMs(block) {
  const tags = ["pubDate", "published", "updated"];
  for (const tag of tags) {
    const value = extractTagText(block, tag);
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractBlocks(xml) {
  const blocks = [];
  const patterns = [/<item\b[\s\S]*?<\/item>/gi, /<entry\b[\s\S]*?<\/entry>/gi];

  for (const pattern of patterns) {
    const matches = xml.match(pattern);
    if (matches) {
      blocks.push(...matches);
    }
  }

  return blocks;
}

function parseRssFeed(xml) {
  if (typeof xml !== "string" || !xml.trim()) {
    return [];
  }

  const blocks = extractBlocks(xml);
  const posts = [];

  for (const block of blocks) {
    const title = extractTagText(block, "title");
    const link = extractLink(block);
    const guid = extractTagText(block, "guid") || extractTagText(block, "id");
    const publishedAtMs = parsePublishedAtMs(block);

    if (!title || !link) {
      continue;
    }

    const id = guid || link;
    posts.push({
      id,
      title,
      link,
      publishedAtMs,
      publishedAt: Number.isFinite(publishedAtMs)
        ? new Date(publishedAtMs).toISOString()
        : null,
    });
  }

  return posts;
}

function mergeAndDeduplicatePosts(postsCollections) {
  const collections = Array.isArray(postsCollections) ? postsCollections : [];
  const merged = [];
  const seenIds = new Set();
  const seenLinks = new Set();

  for (const posts of collections) {
    if (!Array.isArray(posts)) {
      continue;
    }

    for (const post of posts) {
      if (!post || typeof post !== "object") {
        continue;
      }

      const id = typeof post.id === "string" ? post.id : null;
      const link = typeof post.link === "string" ? post.link : null;

      if ((id && seenIds.has(id)) || (link && seenLinks.has(link))) {
        continue;
      }

      if (id) {
        seenIds.add(id);
      }
      if (link) {
        seenLinks.add(link);
      }
      merged.push(post);
    }
  }

  return merged;
}

function filterRecentPosts(posts, nowMs = Date.now(), windowMs = ONE_HOUR_MS) {
  const minTime = nowMs - windowMs;
  return posts
    .filter((post) => Number.isFinite(post.publishedAtMs))
    .filter((post) => post.publishedAtMs >= minTime && post.publishedAtMs <= nowMs)
    .sort((a, b) => a.publishedAtMs - b.publishedAtMs);
}

function pruneStateEntries(entries, nowMs = Date.now(), windowMs = ONE_HOUR_MS) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const minTime = nowMs - windowMs;
  return entries
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => {
      const seenAtMs = Date.parse(entry.seenAt || "");
      if (!Number.isFinite(seenAtMs)) {
        return null;
      }
      return {
        id: entry.id,
        seenAt: new Date(seenAtMs).toISOString(),
        seenAtMs,
      };
    })
    .filter((entry) => entry && entry.seenAtMs >= minTime && entry.seenAtMs <= nowMs)
    .map((entry) => ({ id: entry.id, seenAt: entry.seenAt }));
}

function selectNewPosts(recentPosts, stateEntries) {
  const knownIds = new Set(
    (Array.isArray(stateEntries) ? stateEntries : [])
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => entry.id),
  );

  const emittedIds = new Set();
  const selected = [];

  for (const post of recentPosts) {
    if (knownIds.has(post.id) || emittedIds.has(post.id)) {
      continue;
    }
    emittedIds.add(post.id);
    selected.push(post);
  }

  return selected;
}

function mergeEntries(prunedEntries, recentPosts, nowIso) {
  const byId = new Map();

  for (const entry of prunedEntries) {
    byId.set(entry.id, entry.seenAt);
  }

  for (const post of recentPosts) {
    byId.set(post.id, nowIso);
  }

  return Array.from(byId.entries())
    .map(([id, seenAt]) => ({ id, seenAt }))
    .sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt));
}

function shouldNotifyFailure(previousFailures, nextFailures, threshold = FAILURE_NOTIFY_THRESHOLD) {
  return previousFailures < threshold && nextFailures >= threshold;
}

function buildTelegramMessages(posts) {
  return posts.map((post) => `${post.title}\n${post.link}`);
}

function defaultState() {
  return {
    updatedAt: null,
    consecutiveFailures: 0,
    entries: [],
  };
}

function readState(stateFile = DEFAULT_STATE_FILE) {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return defaultState();
    }

    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      consecutiveFailures: toFiniteNumber(parsed.consecutiveFailures, 0),
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return defaultState();
  }
}

function writeState(state, stateFile = DEFAULT_STATE_FILE) {
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchTextWithRetry(url, fetchImpl, options = {}) {
  const attempts = toFiniteNumber(options.attempts, DEFAULT_FETCH_ATTEMPTS);
  const retryDelayMs = toFiniteNumber(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "openclaw-reddit-openclaw-watcher/1.0",
        },
      });

      if (!response || !response.ok) {
        const status = response && typeof response.status === "number"
          ? response.status
          : "unknown";
        throw new Error(`HTTP ${status}`);
      }

      const text = await response.text();
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("empty response body");
      }

      return {
        text,
        attemptsUsed: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(retryDelayMs);
      }
    }
  }

  throw new Error(`fetch failed after ${attempts} attempts: ${lastError.message}`);
}

async function runWatcher(options = {}) {
  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const windowMs = toFiniteNumber(options.windowMs, ONE_HOUR_MS);
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const feedUrls = buildFeedUrls(options);
  const primaryUrl = feedUrls[feedUrls.length - 1];
  const fetchImpl = options.fetchImpl || global.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }
  if (feedUrls.length === 0) {
    throw new Error("at least one feed URL is required");
  }

  const previousState = readState(stateFile);
  const prunedEntries = pruneStateEntries(previousState.entries, nowMs, windowMs);

  try {
    const feedResults = await Promise.all(
      feedUrls.map((url) => fetchTextWithRetry(url, fetchImpl, {
        attempts: options.fetchAttempts,
        retryDelayMs: options.retryDelayMs,
      })),
    );

    const parsedByFeed = feedResults.map((result) => parseRssFeed(result.text));
    const parsedPosts = mergeAndDeduplicatePosts(parsedByFeed);
    const recentPosts = filterRecentPosts(parsedPosts, nowMs, windowMs);
    const newPosts = selectNewPosts(recentPosts, prunedEntries);

    const state = {
      updatedAt: nowIso,
      consecutiveFailures: 0,
      entries: mergeEntries(prunedEntries, recentPosts, nowIso),
    };
    writeState(state, stateFile);

    return {
      status: "ok",
      checkedAt: nowIso,
      url: primaryUrl,
      urls: feedUrls,
      attemptsUsed: feedResults.reduce((total, result) => total + result.attemptsUsed, 0),
      totalParsed: parsedPosts.length,
      recentCount: recentPosts.length,
      newCount: newPosts.length,
      newPosts: newPosts.map((post) => ({
        id: post.id,
        title: post.title,
        link: post.link,
        publishedAt: post.publishedAt,
      })),
      telegramMessages: buildTelegramMessages(newPosts),
      consecutiveFailures: 0,
    };
  } catch (error) {
    const nextFailures = previousState.consecutiveFailures + 1;
    const notifyFailure = shouldNotifyFailure(
      previousState.consecutiveFailures,
      nextFailures,
      toFiniteNumber(options.failureNotifyThreshold, FAILURE_NOTIFY_THRESHOLD),
    );

    const state = {
      updatedAt: nowIso,
      consecutiveFailures: nextFailures,
      entries: prunedEntries,
    };
    writeState(state, stateFile);

    const failureMessage = `reddit-openclaw-watcher failed ${nextFailures} consecutive runs: ${error.message}`;

    return {
      status: "error",
      checkedAt: nowIso,
      url: primaryUrl,
      urls: feedUrls,
      error: error.message,
      consecutiveFailures: nextFailures,
      notifyFailure,
      failureMessage: notifyFailure ? failureMessage : null,
      telegramMessages: notifyFailure ? [failureMessage] : [],
    };
  }
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-file" && index + 1 < argv.length) {
      options.stateFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--url" && index + 1 < argv.length) {
      options.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--query" && index + 1 < argv.length) {
      options.query = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--now-ms" && index + 1 < argv.length) {
      options.nowMs = toFiniteNumber(argv[index + 1], undefined);
      index += 1;
      continue;
    }

    if (arg === "--fetch-attempts" && index + 1 < argv.length) {
      options.fetchAttempts = toFiniteNumber(argv[index + 1], undefined);
      index += 1;
      continue;
    }

    if (arg === "--retry-delay-ms" && index + 1 < argv.length) {
      options.retryDelayMs = toFiniteNumber(argv[index + 1], undefined);
      index += 1;
      continue;
    }
  }

  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runWatcher(options)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`reddit-openclaw-watcher failed: ${error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_FETCH_ATTEMPTS,
  DEFAULT_QUERY,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_SUBREDDIT_RSS_URL,
  FAILURE_NOTIFY_THRESHOLD,
  ONE_HOUR_MS,
  buildFeedUrls,
  buildRedditSearchRssUrl,
  buildTelegramMessages,
  decodeHtmlEntities,
  fetchTextWithRetry,
  filterRecentPosts,
  mergeEntries,
  mergeAndDeduplicatePosts,
  parseArgs,
  parseRssFeed,
  pruneStateEntries,
  readState,
  runWatcher,
  selectNewPosts,
  shouldNotifyFailure,
  writeState,
};
