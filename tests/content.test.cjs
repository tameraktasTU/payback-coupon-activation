const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Minimal page fixture exercising the unmodified content script through its
// public extension messages, including activation, scrolling and stale tabs.
function page({ inactive, active = 0, counter = "explicit", pathname = "/coupons", lazy, reloadError } = {}) {
  let listener;
  let now = 0;
  const scrolls = [];
  const clicks = [];
  const reloads = [];
  const reloadTimers = new Map();
  let timerId = 0;

  class Element {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = {};
      this.style = {};
      this.id = "";
      this.className = "";
      this.text = "";
      this.scrollHeight = 2000;
    }
    get textContent() { return [this.text, ...this.children.map((child) => child.textContent)].join(" "); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get innerText() { return this.textContent; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return name in this.attributes; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children.forEach((child) => { child.parentElement = null; }); this.children = []; this.append(...children); }
    contains(other) { return this === other || this.children.some((child) => child.contains(other)); }
    remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    getBoundingClientRect() { return { width: 200, height: 40 }; }
    scrollIntoView() {}
    click() { clicks.push(this); this.onClick?.(); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((part) => part.trim());
      const matches = (el, part) => {
        if (part === "[aria-label]" || part === "[title]") return el.hasAttribute(part.slice(1, -1));
        if (part === '[role="button"]') return el.getAttribute("role") === "button";
        if (part.startsWith('input[type="')) return el.tagName === "INPUT" && el.getAttribute("type") === part.split('"')[1];
        if (part.startsWith('a[href*="')) return el.tagName === "A" && (el.href || "").includes(part.split('"')[1]);
        return el.tagName.toLowerCase() === part;
      };
      const found = [];
      const visit = (node) => node.children.forEach((child) => {
        if (selectors.some((part) => matches(child, part))) found.push(child);
        visit(child);
      });
      visit(this);
      return found;
    }
  }
  class Input extends Element {}
  class Anchor extends Element {}
  const root = new Element("html");
  const body = root.appendChild(new Element("body"));
  const labels = body.appendChild(new Element("p"));
  if (counter === "explicit") labels.textContent = `Aktiviert (${active}) Nicht aktiviert (${inactive})`;
  if (counter === "total") labels.textContent = `Aktiviert (${active}) Alle Coupons (${active + inactive})`;
  if (counter === "tab") labels.textContent = `Aktiviert (${active}) Coupons (${active + inactive})`;
  const cards = body.appendChild(new Element("section"));
  const document = {
    body, documentElement: root,
    contains: (el) => root.contains(el),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => tag === "a" ? new Anchor(tag) : new Element(tag)
  };
  const window = {
    scrollY: 0, innerHeight: 800,
    scrollTo({ top }) { this.scrollY = top; },
    scrollBy({ top }) {
      scrolls.push(top);
      this.scrollY += top;
      lazy?.(fixture);
      lazy = null;
    }
  };
  function card(text, { succeeds = true, marker = true, tag = "button", aria, nested = false } = {}) {
    const container = cards.appendChild(new Element("article"));
    if (marker) container.className = "coupon-card";
    container.text = "PAYBACK Gewinnspiel oder Einkauf mit Punkten";
    const button = tag === "a" ? new Anchor(tag) : new Element(tag);
    button.textContent = text;
    if (aria) button.setAttribute("aria-label", aria);
    if (nested) {
      const wrapper = container.appendChild(new Element("div"));
      wrapper.setAttribute("role", "button");
      wrapper.appendChild(button);
    } else container.appendChild(button);
    // Opening code entry leaves the offer's CTA unchanged; normal coupons
    // switch to the activated badge after a successful click.
    if (succeeds && !(text || aria || "").includes("Code")) button.onClick = () => { button.textContent = "Aktiviert"; };
    return button;
  }
  const fixture = {
    card, clicks, scrolls, reloads, reloadTimers,
    send: (type) => listener({ type }),
    async flushReload() {
      const callbacks = [...reloadTimers.values()];
      reloadTimers.clear();
      for (const callback of callbacks) await callback();
    }
  };
  vm.runInNewContext(source, {
    window, document, location: { pathname },
    Element, HTMLElement: Element, HTMLInputElement: Input, HTMLAnchorElement: Anchor,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) {
      if (ms === 6500) return; // Overlay cleanup has no bearing on the run.
      if (ms === 1500) {
        const id = ++timerId;
        reloadTimers.set(id, callback);
        return id;
      }
      now += ms;
      queueMicrotask(callback);
    },
    clearTimeout: (id) => reloadTimers.delete(id),
    browser: { runtime: {
      sendMessage: (message) => {
        if (message.type !== "PAYBACK_FORCE_RELOAD") return Promise.resolve();
        reloads.push(message);
        return reloadError ? Promise.reject(new Error(reloadError)) : Promise.resolve({ reloaded: true });
      },
      onMessage: { addListener(fn) { listener = fn; } }
    } },
    console: { ...console, warn() {} }
  });
  return fixture;
}

test("stale Nicht aktiviert (187): clicks code entry once and finishes all 186 activations", async () => {
  const fixture = page({ inactive: 187, active: 274 });
  const manual = fixture.card("Zur Code-Eingabe");
  for (let i = 0; i < 186; i += 1) fixture.card("Jetzt aktivieren");
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "success");
  assert.equal(result.activated, 186);
  assert.equal(result.pageActivatedTotal, 460);
  assert.equal(result.activationTarget, 186);
  assert.equal(result.remaining, 0);
  assert.equal(result.progress, 100);
  assert.equal(result.codeEntryRequired, 1);
  assert.equal(result.codeEntryClicked, 1);
  assert.match(result.message, /1 Angebot zur Code-Eingabe einmal angeklickt/);
  assert.equal(fixture.clicks.filter((button) => button === manual).length, 1);
  assert.equal(fixture.scrolls.length, 0);
  assert.equal((await fixture.send("PAYBACK_GET_STATUS")).remaining, 0);
  assert.equal((await fixture.send("PAYBACK_START")).phase, "already_done");
  assert.equal(fixture.clicks.length, 187);
  assert.equal(fixture.scrolls.length, 0);
});

for (const active of [0, 274]) {
  test(`only a manual offer remains (${active} already active): stops without searching`, async () => {
    const fixture = page({ inactive: 1, active });
    fixture.card("Zur Code-Eingabe");
    const result = await fixture.send("PAYBACK_START");
    assert.equal(result.phase, "already_done");
    assert.equal(result.remaining, 0);
    assert.equal(result.activated, 0);
    assert.equal(result.pageActivatedTotal, active);
    assert.equal(result.codeEntryClicked, 1);
    assert.equal(fixture.clicks.length, 1);
    assert.equal(fixture.scrolls.length, 0);
  });
}

test("a manual offer loaded during scrolling reduces the target exactly once", async () => {
  const fixture = page({ inactive: 2, lazy: (current) => current.card("Zur Code-Eingabe") });
  fixture.card("Jetzt aktivieren");
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "success");
  assert.equal(result.activated, 1);
  assert.equal(result.codeEntryRequired, 1);
  assert.equal(result.activationTarget, 1);
  assert.equal(result.remaining, 0);
  assert.equal(fixture.scrolls.length, 1);
  assert.equal(result.codeEntryClicked, 1);
  assert.equal(fixture.clicks.length, 2);
});

test("failed activation still stays open when the manual offer is excluded", async () => {
  const fixture = page({ inactive: 2 });
  const manual = fixture.card("Zur Code-Eingabe");
  fixture.card("Jetzt aktivieren", { succeeds: false });
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "error");
  assert.equal(result.activated, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.codeEntryRequired, 1);
  assert.equal(result.codeEntryClicked, 1);
  const retry = await fixture.send("PAYBACK_START");
  assert.equal(retry.phase, "error");
  assert.equal(retry.remaining, 1);
  assert.equal(retry.codeEntryClicked, 0);
  assert.equal(fixture.clicks.filter((button) => button === manual).length, 1);
});

test("a recreated manual card with the same coupon ID cannot hide an unconfirmed coupon", async () => {
  let original;
  const fixture = page({ inactive: 2, lazy: (current) => {
    original.parentElement.remove();
    const replacement = current.card("Zur Code-Eingabe");
    replacement.parentElement.setAttribute("data-coupon-id", "joker");
  } });
  original = fixture.card("Zur Code-Eingabe");
  original.parentElement.setAttribute("data-coupon-id", "joker");
  fixture.card("Jetzt aktivieren", { succeeds: false });
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "error");
  assert.equal(result.codeEntryRequired, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.codeEntryClicked, 1);
  assert.equal(fixture.clicks.filter((button) => button.getAttribute("role") !== "button" && button.textContent.includes("Code")).length, 1);
});

test("nested controls count once while separate identical manual cards remain distinct", async () => {
  const fixture = page({ inactive: 3 });
  fixture.card("Zur Code-Eingabe", { tag: "a", nested: true });
  fixture.card("", { aria: " Zur  Code‑Eingabe " });
  fixture.card("Jetzt teilnehmen");
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "success");
  assert.equal(result.codeEntryRequired, 2);
  assert.equal(result.activated, 1);
  assert.equal(result.activationTarget, 1);
  assert.equal(result.codeEntryClicked, 2);
  assert.equal(fixture.clicks.length, 3);
});

for (const counter of ["explicit", "total", "tab", "none"]) {
  test(`manual offers are excluded from the ${counter} counter without hiding normal coupons`, async () => {
    const fixture = page({ inactive: 2, active: 10, counter });
    fixture.card("Zur Code-Eingabe");
    fixture.card("Jetzt aktivieren");
    const status = await fixture.send("PAYBACK_GET_STATUS");
    assert.equal(status.remaining, 1);
    const result = await fixture.send("PAYBACK_START");
    assert.equal(result.phase, "success");
    assert.equal(result.activated, 1);
    assert.equal(result.remaining, 0);
  });
}

test("code entry outside the coupon context does not reduce the inactive count", async () => {
  const fixture = page({ inactive: 2, pathname: "/aktionen" });
  fixture.card("Zur Code-Eingabe", { marker: false });
  fixture.card("Jetzt aktivieren");
  const result = await fixture.send("PAYBACK_GET_STATUS");
  assert.equal(result.codeEntryRequired, 0);
  assert.equal(result.remaining, 2);
  assert.equal(fixture.clicks.length, 0);
});

test("coupon-page counters provide context when cards have no recognizable attributes", async () => {
  const fixture = page({ inactive: 2 });
  fixture.card("Zur Code-Eingabe", { marker: false });
  fixture.card("Jetzt teilnehmen", { marker: false });
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "success");
  assert.equal(result.activated, 1);
  assert.equal(result.codeEntryRequired, 1);
  assert.equal(result.codeEntryClicked, 1);
  assert.equal(fixture.clicks.length, 2);
});

test("status reads do not click code entry", async () => {
  const fixture = page({ inactive: 1 });
  fixture.card("Zur Code-Eingabe");
  await fixture.send("PAYBACK_GET_STATUS");
  await fixture.send("PAYBACK_GET_STATUS");
  assert.equal(fixture.clicks.length, 0);
});

test("a newly added code-entry offer is clicked on recheck without repeating the old offer", async () => {
  const fixture = page({ inactive: 1 });
  const original = fixture.card("Zur Code-Eingabe");
  await fixture.send("PAYBACK_START");
  const added = fixture.card("Zur Code-Eingabe");
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "already_done");
  assert.equal(result.remaining, 0);
  assert.equal(result.activated, 0);
  assert.equal(fixture.clicks.filter((button) => button === original).length, 1);
  assert.equal(fixture.clicks.filter((button) => button === added).length, 1);
});

test("disabled code-entry controls are clicked once after they become enabled", async () => {
  const fixture = page({ inactive: 1 });
  const manual = fixture.card("Zur Code-Eingabe");
  manual.setAttribute("disabled", "");
  await fixture.send("PAYBACK_START");
  assert.equal(fixture.clicks.length, 0);
  delete manual.attributes.disabled;
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "already_done");
  assert.equal(result.codeEntryClicked, 1);
  assert.equal(fixture.clicks.length, 1);
  await fixture.send("PAYBACK_START");
  assert.equal(fixture.clicks.length, 1);
});

test("successful activation schedules one delayed reload after all clicks are confirmed", async () => {
  const fixture = page({ inactive: 2, active: 10 });
  fixture.card("Jetzt aktivieren");
  fixture.card("Jetzt aktivieren");
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "success");
  assert.equal(result.activated, 2);
  assert.equal(result.reloadPending, true);
  assert.match(result.message, /ohne Cache neu geladen/);
  assert.equal(fixture.reloads.length, 0);
  assert.equal(fixture.reloadTimers.size, 1);
  await fixture.send("PAYBACK_GET_STATUS");
  assert.equal(fixture.reloadTimers.size, 1);
  await fixture.flushReload();
  assert.equal(fixture.reloads.length, 1);
  await fixture.send("PAYBACK_START");
  await fixture.flushReload();
  assert.equal(fixture.reloads.length, 1);
  assert.equal(fixture.clicks.length, 2);
});

test("already completed coupons reload once after an explicit run, with no automatic run on a fresh page", async () => {
  const fixture = page({ inactive: 0, active: 10 });
  assert.equal((await fixture.send("PAYBACK_GET_STATUS")).phase, "idle");
  assert.equal(fixture.reloadTimers.size, 0);
  const result = await fixture.send("PAYBACK_START");
  assert.equal(result.phase, "already_done");
  assert.equal(result.reloadPending, true);
  await fixture.flushReload();
  assert.equal(fixture.reloads.length, 1);
  const reloaded = page({ inactive: 0, active: 10 });
  await reloaded.send("PAYBACK_GET_STATUS");
  await reloaded.flushReload();
  assert.equal(reloaded.clicks.length, 0);
  assert.equal(reloaded.reloads.length, 0);
});

test("failed or cancelled activations never request an automatic reload", async () => {
  const failed = page({ inactive: 1 });
  failed.card("Jetzt aktivieren", { succeeds: false });
  assert.equal((await failed.send("PAYBACK_START")).phase, "error");
  await failed.flushReload();
  assert.equal(failed.reloads.length, 0);

  const cancelled = page({ inactive: 2 });
  const button = cancelled.card("Jetzt aktivieren");
  button.onClick = () => cancelled.send("PAYBACK_CANCEL");
  cancelled.card("Jetzt aktivieren");
  assert.equal((await cancelled.send("PAYBACK_START")).phase, "cancelled");
  await cancelled.flushReload();
  assert.equal(cancelled.reloads.length, 0);
});

test("a queued reload can be cancelled and rechecking replaces rather than duplicates its timer", async () => {
  const fixture = page({ inactive: 1 });
  fixture.card("Jetzt aktivieren");
  await fixture.send("PAYBACK_START");
  await fixture.send("PAYBACK_START");
  assert.equal(fixture.reloadTimers.size, 1);
  const stopped = await fixture.send("PAYBACK_CANCEL");
  assert.equal(stopped.reloadPending, false);
  await fixture.flushReload();
  assert.equal(fixture.reloads.length, 0);
});

test("reload failures keep the completed result and explain how to reload manually", async () => {
  const fixture = page({ inactive: 1, reloadError: "Tab geschlossen" });
  fixture.card("Jetzt aktivieren");
  await fixture.send("PAYBACK_START");
  await fixture.flushReload();
  const result = await fixture.send("PAYBACK_GET_STATUS");
  assert.equal(result.phase, "success");
  assert.equal(result.activated, 1);
  assert.equal(result.reloadPending, false);
  assert.match(result.message, /Neuladen fehlgeschlagen.*Strg \+ F5/);
});

test("a page without recognized coupons does not reload", async () => {
  const fixture = page({ counter: "none", pathname: "/" });
  await fixture.send("PAYBACK_START");
  await fixture.flushReload();
  assert.equal(fixture.reloads.length, 0);
});
