const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getCryptoSnapshot, trendSymbol } = require("./get-crypto-snapshot.js");

function mkStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-monitor-"));
  return path.join(dir, "state.json");
}

test("trendSymbol returns expected arrows", () => {
  assert.equal(trendSymbol(null, 1), "🆕");
  assert.equal(trendSymbol(1, 2), "⬆️");
  assert.equal(trendSymbol(2, 1), "⬇️");
  assert.equal(trendSymbol(2, 2), "⏸️");
});

test("getCryptoSnapshot stores state and reports trend for BTC/USD and ETH/USD", async () => {
  const stateFile = mkStateFile();
  const values = {
    bitcoin: { usd: 60000, usd_24h_change: 2.4 },
    ethereum: { usd: 3000, usd_24h_change: -1.3 },
  };

  const fetchImpl = async (url) => {
    assert.match(String(url), /include_24hr_change=true/);
    return {
      ok: true,
      async json() {
        return JSON.parse(JSON.stringify(values));
      },
    };
  };

  const first = await getCryptoSnapshot({ fetchImpl, stateFile });
  assert.equal(first.pairs["BTC/USD"].trend, "🆕");
  assert.equal(first.pairs["ETH/USD"].trend, "🆕");
  assert.equal(first.pairs["BTC/USD"].change24h, 2.4);
  assert.equal(first.pairs["ETH/USD"].change24h, -1.3);

  values.bitcoin.usd = 60125;
  values.bitcoin.usd_24h_change = 2.8;
  values.ethereum.usd = 2990;
  values.ethereum.usd_24h_change = -1.7;

  const second = await getCryptoSnapshot({ fetchImpl, stateFile });
  assert.equal(second.pairs["BTC/USD"].trend, "⬆️");
  assert.equal(second.pairs["ETH/USD"].trend, "⬇️");

  const third = await getCryptoSnapshot({ fetchImpl, stateFile });
  assert.equal(third.pairs["BTC/USD"].trend, "⏸️");
  assert.equal(third.pairs["ETH/USD"].trend, "⏸️");

  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persisted.pairs["BTC/USD"].price, 60125);
  assert.equal(persisted.pairs["BTC/USD"].change24h, 2.8);
  assert.equal(persisted.pairs["ETH/USD"].price, 2990);
  assert.equal(persisted.pairs["ETH/USD"].change24h, -1.7);
});
