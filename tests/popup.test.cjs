const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const settle = () => new Promise(setImmediate);

async function popup(initialState) {
  const elements = new Map();
  const polls = new Map();
  let timerId = 0;
  const fixture = {
    state: initialState, loading: false, polls,
    element(id) {
      if (!elements.has(id)) elements.set(id, {
        style: {}, classList: { toggle() {} }, addEventListener() {}, textContent: ""
      });
      return elements.get(id);
    },
    async poll() {
      for (const callback of [...polls.values()]) await callback();
    }
  };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => fixture.element(id) },
    window: { addEventListener() {} },
    setInterval(callback) { const id = ++timerId; polls.set(id, callback); return id; },
    clearInterval: (id) => polls.delete(id),
    browser: {
      tabs: {
        query: async () => [{ id: 42, url: "https://www.payback.de/coupons" }],
        sendMessage: async () => {
          if (fixture.loading) throw new Error("Content script unloaded");
          return fixture.state;
        }
      },
      scripting: { executeScript: async () => { throw new Error("Page is reloading"); } }
    }, console
  });
  await settle();
  return fixture;
}

test("popup remains connected through a pending reload and becomes usable on the fresh page", async () => {
  const fixture = await popup({ phase: "idle", message: "Bereit." });
  fixture.state = { phase: "success", reloadPending: true, message: "Die Seite wird neu geladen." };
  await fixture.poll();
  assert.equal(fixture.element("startButton").disabled, true);
  assert.equal(fixture.element("startButton").textContent, "Seite wird neu geladen …");
  assert.equal(fixture.polls.size, 1);
  fixture.loading = true;
  await fixture.poll();
  assert.equal(fixture.element("statusTitle").textContent, "Fertig");
  assert.equal(fixture.polls.size, 1);
  fixture.loading = false;
  fixture.state = { phase: "idle", reloadPending: false, message: "Bereit." };
  await fixture.poll();
  assert.equal(fixture.element("statusTitle").textContent, "Bereit");
  assert.equal(fixture.element("startButton").disabled, false);
  assert.equal(fixture.element("startButton").textContent, "Coupons aktivieren");
});

test("opening the popup during a scheduled reload starts polling; failed reloads restore the button", async () => {
  const fixture = await popup({ phase: "success", reloadPending: true });
  assert.equal(fixture.polls.size, 1);
  assert.equal(fixture.element("startButton").disabled, true);
  fixture.state = { phase: "success", reloadPending: false, message: "Bitte mit Strg + F5 neu laden." };
  await fixture.poll();
  assert.equal(fixture.polls.size, 0);
  assert.equal(fixture.element("startButton").disabled, false);
  assert.equal(fixture.element("startButton").textContent, "Erneut prüfen");
});
