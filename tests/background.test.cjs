const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const paybackUrl = "https://www.payback.de/coupons";

function background({ url = paybackUrl, reloadError } = {}) {
  let listener;
  const reloads = [];
  vm.runInNewContext(source, {
    browser: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      tabs: {
        get: async (id) => ({ id, url }),
        reload: async (id, options) => {
          reloads.push({ id, ...options });
          if (reloadError) throw new Error(reloadError);
        }
      },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
    }, console
  });
  return {
    reloads,
    send: (sender = { tab: { id: 42, url: paybackUrl }, url: paybackUrl, frameId: 0 }) =>
      listener({ type: "PAYBACK_FORCE_RELOAD" }, sender)
  };
}

test("reloads the sending PAYBACK tab with the cache bypassed", async () => {
  const fixture = background();
  assert.equal((await fixture.send()).reloaded, true);
  assert.deepEqual(fixture.reloads, [{ id: 42, bypassCache: true }]);
});

test("does not reload another tab, a changed page, or requests without a PAYBACK main-frame sender", async () => {
  for (const sender of [
    {},
    { tab: { id: 42 }, url: "https://example.com/", frameId: 0 },
    { tab: { id: 42 }, url: "https://www.payback.de.example.com/coupons", frameId: 0 },
    { tab: { id: 42 }, url: paybackUrl, frameId: 1 }
  ]) {
    const fixture = background();
    assert.equal((await fixture.send(sender)).reloaded, false);
    assert.equal(fixture.reloads.length, 0);
  }
  for (const url of ["https://example.com/", "https://www.payback.de/aktionen"]) {
    const fixture = background({ url });
    assert.equal((await fixture.send()).reloaded, false);
    assert.equal(fixture.reloads.length, 0);
  }
});

test("returns a reload failure to the content script", async () => {
  const fixture = background({ reloadError: "Tab geschlossen" });
  const result = await fixture.send();
  assert.equal(result.reloaded, false);
  assert.equal(result.error, "Tab geschlossen");
});
