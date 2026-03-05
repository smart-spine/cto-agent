const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getRates, trendSymbol } = require("./get-rate.js");

function mkStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forex-bot-"));
  return path.join(dir, "state.json");
}

test("trendSymbol returns expected arrows", () => {
  assert.equal(trendSymbol(null, 1.0), "🆕");
  assert.equal(trendSymbol(1.0, 1.1), "⬆️");
  assert.equal(trendSymbol(1.1, 1.0), "⬇️");
  assert.equal(trendSymbol(1.1, 1.1), "⏸️");
});

test("getRates stores state and reports trend for USD/EUR and EUR/PLN", async () => {
  const stateFile = mkStateFile();
  const values = {
    USD: { rates: { EUR: 0.91 } },
    EUR: { rates: { PLN: 4.3 } },
  };

  const fetchImpl = async (url) => {
    const base = String(url).split("/").pop();
    return {
      ok: true,
      async json() {
        return values[base];
      },
    };
  };

  const first = await getRates({ fetchImpl, stateFile });
  assert.equal(first.pairs["USD/EUR"].trend, "🆕");
  assert.equal(first.pairs["EUR/PLN"].trend, "🆕");

  values.USD.rates.EUR = 0.92;
  values.EUR.rates.PLN = 4.29;

  const second = await getRates({ fetchImpl, stateFile });
  assert.equal(second.pairs["USD/EUR"].trend, "⬆️");
  assert.equal(second.pairs["EUR/PLN"].trend, "⬇️");

  values.USD.rates.EUR = 0.92;
  values.EUR.rates.PLN = 4.29;

  const third = await getRates({ fetchImpl, stateFile });
  assert.equal(third.pairs["USD/EUR"].trend, "⏸️");
  assert.equal(third.pairs["EUR/PLN"].trend, "⏸️");

  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(persisted.pairs["USD/EUR"].rate, 0.92);
  assert.equal(persisted.pairs["EUR/PLN"].rate, 4.29);
});
