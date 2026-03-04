#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STATE_FILE = path.join(__dirname, "..", "config", "state.json");

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

async function fetchLatest(base, fetchImpl) {
  const url = `https://open.er-api.com/v6/latest/${base}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function getRates(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const prevState = readState(stateFile);

  const [usdPayload, eurPayload] = await Promise.all([
    fetchLatest("USD", fetchImpl),
    fetchLatest("EUR", fetchImpl),
  ]);

  const usdEur = toNumber(usdPayload?.rates?.EUR);
  const eurPln = toNumber(eurPayload?.rates?.PLN);

  const result = {
    pairs: {
      "USD/EUR": {
        rate: usdEur,
        prev: toNumber(prevState?.pairs?.["USD/EUR"]?.rate),
      },
      "EUR/PLN": {
        rate: eurPln,
        prev: toNumber(prevState?.pairs?.["EUR/PLN"]?.rate),
      },
    },
  };

  for (const pair of Object.keys(result.pairs)) {
    const entry = result.pairs[pair];
    entry.trend = trendSymbol(entry.prev, entry.rate);
  }

  writeState(
    {
      updatedAt: new Date().toISOString(),
      pairs: {
        "USD/EUR": { rate: result.pairs["USD/EUR"].rate },
        "EUR/PLN": { rate: result.pairs["EUR/PLN"].rate },
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
  getRates(parsed)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`get-rate failed: ${error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_STATE_FILE,
  getRates,
  parseArgs,
  readState,
  trendSymbol,
  writeState,
};
