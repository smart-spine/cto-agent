#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STATE_FILE = path.join(__dirname, "..", "config", "state.json");
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true";

function toNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

function readState(stateFile = DEFAULT_STATE_FILE) {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state, stateFile = DEFAULT_STATE_FILE) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function trendSymbol(previous, current) {
  if (previous == null || current == null) {
    return "🆕";
  }
  if (current > previous) {
    return "⬆️";
  }
  if (current < previous) {
    return "⬇️";
  }
  return "⏸️";
}

async function fetchSimplePrice(fetchImpl) {
  const response = await fetchImpl(COINGECKO_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function getCryptoSnapshot(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const prevState = readState(stateFile);
  const payload = await fetchSimplePrice(fetchImpl);

  const result = {
    pairs: {
      "BTC/USD": {
        price: toNumber(payload?.bitcoin?.usd),
        change24h: toNumber(payload?.bitcoin?.usd_24h_change),
        prev: toNumber(prevState?.pairs?.["BTC/USD"]?.price),
      },
      "ETH/USD": {
        price: toNumber(payload?.ethereum?.usd),
        change24h: toNumber(payload?.ethereum?.usd_24h_change),
        prev: toNumber(prevState?.pairs?.["ETH/USD"]?.price),
      },
    },
  };

  for (const pair of Object.keys(result.pairs)) {
    const entry = result.pairs[pair];
    entry.trend = trendSymbol(entry.prev, entry.price);
  }

  writeState(
    {
      updatedAt: new Date().toISOString(),
      pairs: {
        "BTC/USD": {
          price: result.pairs["BTC/USD"].price,
          change24h: result.pairs["BTC/USD"].change24h,
        },
        "ETH/USD": {
          price: result.pairs["ETH/USD"].price,
          change24h: result.pairs["ETH/USD"].change24h,
        },
      },
    },
    stateFile,
  );

  return result;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state-file" && i + 1 < argv.length) {
      out.stateFile = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  getCryptoSnapshot(parsed)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`get-crypto-snapshot failed: ${error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  COINGECKO_URL,
  DEFAULT_STATE_FILE,
  getCryptoSnapshot,
  parseArgs,
  readState,
  trendSymbol,
  writeState,
};
