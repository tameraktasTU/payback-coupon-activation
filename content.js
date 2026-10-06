(() => {
  if (window.__paybackCouponActivatorV2Loaded) return;
  window.__paybackCouponActivatorV2Loaded = true;

  const state = {
    phase: "idle",
    message: "Bereit.",
    found: 0,
    activated: 0,
    alreadyActivated: 0,
    pageActivatedTotal: 0,
    pageInactiveTotal: 0,
    pageTotal: 0,
    activationTarget: 0,
    failed: 0,
    skipped: 0,
    codeEntryRequired: 0,
    codeEntryClicked: 0,
    remaining: 0,
    progress: 0,
    reloadPending: false,
    startedAt: null,
    updatedAt: Date.now()
  };

  let running = false;
  let cancelRequested = false;
  let overlay = null;
  let handledButtons = new WeakSet();
  let handledActivationKeys = new Set();
  let codeEntryButtons = new WeakSet();
  let codeEntryKeys = new Set();
  // Keep click history until the page reloads, including cancelled/error runs.
  const clickedCodeEntryButtons = new WeakSet();
  const clickedCodeEntryKeys = new Set();
  let initialActivatedTotal = 0;
  let initialInactiveTotal = 0;
  let initialPageTotal = 0;
  let hasReliableInitialInactiveCount = false;
  let reloadTimer = null;
  let reloadRequested = false;
  let reloadCompletionMessage = "";

  // Small parallel batches are substantially faster than activating every
  // coupon strictly one after another, while still avoiding a burst of dozens
  // of clicks against PAYBACK at once.
  const ACTIVATION_BATCH_SIZE = 5;
  const BATCH_CLICK_STAGGER_MS = 70;
  const BATCH_PAUSE_MS = 180;
  const MAX_RUN_MS = 4 * 60 * 1000;
  const RELOAD_DELAY_MS = 1500;
  const TERMINAL_PHASES = new Set(["success", "already_done", "cancelled", "error"]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

  function snapshot() {
    return { ...state };
  }

  function computeProgress() {
    const activated = Math.max(0, Number(state.activated || 0));
    const denominator = Math.max(
      Number(state.activationTarget || 0),
      activated + Number(state.remaining || 0),
      1
    );
    state.progress = Math.min(100, Math.round((activated / denominator) * 100));
    if (["success", "already_done"].includes(state.phase)) state.progress = 100;
  }

  function updateState(patch = {}, notify = true) {
    if (["success", "already_done"].includes(patch.phase) && patch.message && state.codeEntryRequired > 0) {
      const count = state.codeEntryRequired;
      patch.message += state.codeEntryClicked > 0
        ? ` ${state.codeEntryClicked} Angebot${state.codeEntryClicked === 1 ? "" : "e"} zur Code-Eingabe einmal angeklickt. Die Code-Eingabe bleibt manuell.`
        : ` ${count} Angebot${count === 1 ? " erfordert" : "e erfordern"} eine manuelle Code-Eingabe.`;
    }
    Object.assign(state, patch, { updatedAt: Date.now() });
    computeProgress();
    renderOverlay();
    if (notify) {
      browser.runtime.sendMessage({ type: "PAYBACK_PROGRESS", state: snapshot() }).catch(() => {});
    }
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.disabled === true;
  }

  function elementText(el) {
    if (el instanceof HTMLInputElement) return normalize(el.value || el.getAttribute("aria-label") || el.title);
    return normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || el.title);
  }

  function textCandidates(el) {
    const candidates = [];
    if (el instanceof HTMLInputElement) candidates.push(el.value);
    candidates.push(el.innerText, el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title"));
    return [...new Set(candidates.map(normalize).filter(Boolean))];
  }

  function hasCouponLikeAncestor(el) {
    let node = el;
    for (let depth = 0; depth < 8 && node instanceof Element; depth += 1) {
      const marker = normalize([
        node.id,
        typeof node.className === "string" ? node.className : "",
        node.getAttribute?.("data-testid"),
        node.getAttribute?.("data-test-id"),
        node.getAttribute?.("data-component"),
        node.getAttribute?.("data-coupon-id"),
        node.getAttribute?.("data-offer-id"),
        node.getAttribute?.("data-campaign-id"),
        node.getAttribute?.("data-promotion-id")
      ].filter(Boolean).join(" "));

      if (/(?:^|[\s_-])(coupon|ecoupon|offer|promotion|campaign|voucher|card)(?:$|[\s_-])/.test(marker)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function isParticipationButton(el, text) {
    const matches = text === "jetzt teilnehmen" ||
      text === "teilnehmen" ||
      text.startsWith("jetzt teilnehmen ");
    if (!matches) return false;

    return isCouponContext(el);
  }

  function isCouponContext(el) {
    // Participation and manual code-entry offers need coupon context so an
    // unrelated campaign CTA cannot affect activation or counting.
    // Coupon/card attributes on an ancestor are the
    // strongest signal; on the dedicated coupon page an explicit open coupon
    // counter is accepted as a fallback.
    if (hasCouponLikeAncestor(el)) return true;
    if (!/\/coupons(?:\/|$)/i.test(location.pathname)) return false;

    // Do not call pageCouponCounters() here: its DOM fallback itself uses
    // activationControls(), which would recurse back into this function. Read
    // only PAYBACK's visible counter labels for this safety fallback.
    const pageText = document.body?.innerText || document.body?.textContent || "";
    const explicitOpenMatch = pageText.match(/(?:nicht\s+aktiviert|aktivierbar|offen)\s*\(\s*([0-9][0-9.\s]*)\s*\)/i);
    if (explicitOpenMatch) {
      const openCount = parseLocalizedCount(explicitOpenMatch[1]);
      return openCount !== null && openCount > 0;
    }

    const couponMatch = pageText.match(/(?<!alle\s)\bcoupons?\s*\(\s*([0-9][0-9.\s]*)\s*\)/i);
    const activeMatch = pageText.match(/(?<!nicht\s)\baktiviert\s*\(\s*([0-9][0-9.\s]*)\s*\)/i);
    const couponCount = couponMatch ? parseLocalizedCount(couponMatch[1]) : null;
    const activeCount = activeMatch ? parseLocalizedCount(activeMatch[1]) : 0;
    if (couponCount === null) return false;

    // PAYBACK uses "Coupons (N)" either as total or as the open-tab count.
    // Derive the same conservative open count as the main counter parser.
    const openCount = activeCount > 0 && couponCount >= activeCount
      ? Math.max(0, couponCount - activeCount)
      : couponCount;
    return openCount > 0;
  }

  function isCodeEntryButton(el) {
    return textCandidates(el).some((text) => /^zur code[\s\-‐‑–]*eingabe[.!]?$/.test(text)) &&
      isCouponContext(el);
  }

  function codeEntryControls() {
    const controls = interactiveElements().filter(isCodeEntryButton);
    // A link nested in a role="button" wrapper is one manual offer.
    return controls.filter((el) => !controls.some((other) => other !== el && el.contains(other)));
  }

  function codeEntryKeyFor(button) {
    // Virtualized lists may recreate a manual card at a different DOM path.
    // Prefer its coupon/offer ID so that it is still deducted only once.
    let node = button;
    for (let depth = 0; depth < 8 && node instanceof Element; depth += 1) {
      for (const name of ["data-coupon-id", "data-couponid", "data-offer-id", "data-offerid"]) {
        const value = node.getAttribute(name);
        if (value) return `${name}:${value}`;
      }
      node = node.parentElement;
    }
    return activationKeyFor(button);
  }

  function pendingCodeEntryControls() {
    return codeEntryControls().filter((button) => isVisible(button) && !isDisabled(button) &&
      !clickedCodeEntryButtons.has(button) && !clickedCodeEntryKeys.has(codeEntryKeyFor(button)));
  }

  async function processCodeEntryOffers() {
    let added = 0;
    for (const button of codeEntryControls()) {
      const key = codeEntryKeyFor(button);
      if (!codeEntryButtons.has(button) && !codeEntryKeys.has(key)) {
        codeEntryButtons.add(button);
        codeEntryKeys.add(key);
        added += 1;
      }
      if (cancelRequested) break;
      if (!document.contains(button) || !isVisible(button) || isDisabled(button) ||
          clickedCodeEntryButtons.has(button) || clickedCodeEntryKeys.has(key)) continue;

      // Record the attempt before clicking: an unchanged/recreated button or a
      // retry must never trigger the same code-entry action a second time.
      clickedCodeEntryButtons.add(button);
      clickedCodeEntryKeys.add(key);
      try {
        button.click();
        state.codeEntryClicked += 1;
      } catch (error) {
        console.warn("Code-Eingabe konnte nicht geöffnet werden:", error);
      }
      await sleep(BATCH_CLICK_STAGGER_MS);
    }
    state.codeEntryRequired += added;
    // Opening code entry does not confirm coupon activation. These offers
    // stay outside the activation target even if their buttons remain unchanged.
    state.activationTarget = Math.max(state.activated + state.failed, state.activationTarget - added);
  }

  function isActivationButton(el) {
    return textCandidates(el).some((text) => {
      if (text.length > 90) return false;
      return text === "aktivieren" ||
        text === "coupon aktivieren" ||
        text === "jetzt aktivieren" ||
        text.startsWith("jetzt aktivieren ") ||
        text.startsWith("coupon aktivieren ") ||
        isParticipationButton(el, text);
    });
  }

  function isActivatedIndicator(el) {
    return textCandidates(el).some((text) => {
      if (text.length > 90 || text.includes("nicht aktiviert")) return false;
      return text === "aktiviert" ||
        text === "coupon aktiviert" ||
        text === "bereits aktiviert" ||
        /^(?:✓\s*)?(?:coupon\s+)?(?:bereits\s+)?aktiviert(?:\s*[✓✔])?[.!]?$/.test(text);
    });
  }

  function interactiveElements() {
    return [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
  }

  // PAYBACK renders the "Aktiviert" state as a normal badge/text element on
  // some versions of the coupon overview. Looking only at buttons therefore
  // misses already activated coupons and makes the scanner scroll forever.
  function statusElements() {
    return [...document.querySelectorAll('button, [role="button"], span, p, div, strong, em, small')];
  }

  function activationControls() {
    return interactiveElements().filter((el) => !isDisabled(el) && isActivationButton(el));
  }

  function activationButtons() {
    return activationControls().filter((el) => isVisible(el));
  }

  function activatedIndicators() {
    return statusElements().filter((el) => isVisible(el) && isActivatedIndicator(el));
  }

  function activatedSignatures() {
    return new Set(activatedIndicators().map(signatureFor));
  }

  function parseLocalizedCount(value) {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    if (!digits) return null;
    const parsed = Number.parseInt(digits, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // PAYBACK shows the real total in the filter/tab label, e.g.
  // "Aktiviert (411)". Counting DOM badges only tells us how many coupon
  // cards are currently rendered/visible (often just 1 due to virtualization).
  function textSourcesForCounters() {
    const sources = [];
    const bodyText = document.body?.innerText || document.body?.textContent || "";
    if (bodyText) sources.push(bodyText);

    for (const el of document.querySelectorAll('[aria-label], [title]')) {
      const aria = el.getAttribute("aria-label");
      const title = el.getAttribute("title");
      if (aria) sources.push(aria);
      if (title) sources.push(title);
    }
    return sources;
  }

  function bestCountForPatterns(sources, patterns) {
    let best = 0;
    for (const source of sources) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(String(source))) !== null) {
          const count = parseLocalizedCount(match[1]);
          if (count !== null) best = Math.max(best, count);
          if (!pattern.global) break;
        }
      }
    }
    return best;
  }

  function countInfoForPatterns(sources, patterns) {
    let found = false;
    let count = 0;
    for (const source of sources) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(String(source))) !== null) {
          const parsed = parseLocalizedCount(match[1]);
          if (parsed !== null) {
            found = true;
            count = Math.max(count, parsed);
          }
          if (!pattern.global) break;
        }
      }
    }
    return { found, count };
  }

  // Read PAYBACK's own filter/tab counters. This is more reliable than
  // counting rendered cards because the site virtualizes long coupon lists.
  // Known examples include "Aktiviert (411)". For the open count we support
  // explicit labels such as "Nicht aktiviert (12)" / "Aktivierbar (12)" and
  // PAYBACK's compact open-tab label "Coupons (12)".
  function pageCouponCounters() {
    const sources = textSourcesForCounters();

    // Remove explicit "nicht aktiviert" labels before looking for the shorter
    // word "aktiviert", so an inactive counter can never be mistaken for the
    // active total even if it is numerically larger.
    const activatedSources = sources.map((source) => String(source).replace(
      /\b(?:noch\s+)?nicht\s+aktiviert\s*\(\s*[0-9][0-9.\s]*\s*\)/gi,
      ""
    ));

    const activatedInfo = countInfoForPatterns(activatedSources, [
      /\baktiviert\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi
    ]);
    const inactiveInfo = countInfoForPatterns(sources, [
      /\b(?:noch\s+)?nicht\s+aktiviert\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi,
      /\baktivierbar\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi,
      /\b(?:offen|verfügbar)\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi
    ]);
    const couponTabInfo = countInfoForPatterns(sources, [
      /(?<!alle\s)\bcoupons?\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi
    ]);
    const totalInfo = countInfoForPatterns(sources, [
      /\balle\s+coupons?\s*\(\s*([0-9][0-9.\s]*)\s*\)/gi
    ]);

    const activated = activatedInfo.count;
    let inactive = 0;
    let total = 0;

    if (inactiveInfo.found) {
      // Explicit open label: no ambiguity.
      inactive = inactiveInfo.count;
      total = activated + inactive;
    } else if (totalInfo.found && totalInfo.count >= activated) {
      // Explicit grand total.
      total = totalInfo.count;
      inactive = Math.max(0, total - activated);
    } else if (couponTabInfo.found) {
      // PAYBACK currently uses a compact "Coupons (N)" label. Depending on
      // layout/account state N can behave like the grand total or the open tab
      // count. If N is at least the activated count, it can consistently be
      // interpreted as total; otherwise it cannot be a total and is treated as
      // the open count. This handles e.g. Coupons (427) + Aktiviert (411) => 16
      // open, as well as Coupons (16) + Aktiviert (411) => 16 open.
      if (activated > 0 && couponTabInfo.count >= activated) {
        total = couponTabInfo.count;
        inactive = Math.max(0, total - activated);
      } else {
        inactive = couponTabInfo.count;
        total = activated + inactive;
      }
    } else {
      inactive = activationControls().length;
      total = activated + inactive;
    }

    const rawInactive = inactive;
    const codeEntryRequired = codeEntryControls().length;
    if (inactiveInfo.found || totalInfo.found || couponTabInfo.found) {
      inactive = Math.max(0, inactive - codeEntryRequired);
    } else {
      total += codeEntryRequired;
    }

    return {
      activated,
      inactive,
      rawInactive,
      codeEntryRequired,
      total,
      hasActivatedCounter: activatedInfo.found,
      hasInactiveCounter: inactiveInfo.found || couponTabInfo.found,
      hasExplicitInactiveCounter: inactiveInfo.found,
      hasCouponTabCounter: couponTabInfo.found,
      hasTotalCounter: totalInfo.found
    };
  }

  function activatedTotalFromPage() {
    return pageCouponCounters().activated;
  }

  function refreshPageCounters(notify = false) {
    const counters = pageCouponCounters();

    // PAYBACK does not update its aggregate tab counters after activating a
    // coupon until the page is reloaded. Never let those stale DOM values
    // overwrite the extension's own live/terminal counters during or after a
    // run. On a fresh page (idle state), however, they are the best baseline.
    if (running || TERMINAL_PHASES.has(state.phase)) {
      if (notify) updateState({}, true);
      else {
        state.updatedAt = Date.now();
        computeProgress();
      }
      return counters;
    }

    const patch = {
      pageActivatedTotal: counters.activated,
      pageInactiveTotal: counters.inactive,
      pageTotal: counters.total,
      alreadyActivated: counters.activated,
      codeEntryRequired: counters.codeEntryRequired,
      remaining: counters.inactive,
      found: counters.total
    };

    if (notify) {
      updateState(patch, true);
    } else {
      Object.assign(state, patch, { updatedAt: Date.now() });
      computeProgress();
    }
    return counters;
  }

  function liveRunCounts(activatedThisRun = state.activated) {
    const activatedNow = Math.max(0, Number(activatedThisRun) || 0);
    const activeTotal = Math.max(0, initialActivatedTotal + activatedNow);
    const target = Math.max(0, Number(state.activationTarget) || 0);
    const remaining = hasReliableInitialInactiveCount
      ? Math.max(0, initialInactiveTotal - state.codeEntryRequired - activatedNow)
      : Math.max(0, target - activatedNow);
    const total = Math.max(initialPageTotal, activeTotal + remaining);
    return { activeTotal, remaining, total };
  }

  function unhandledVisibleActivationButtons() {
    return activationButtons().filter((button) =>
      !handledButtons.has(button) && !handledActivationKeys.has(activationKeyFor(button))
    );
  }

  function reconcileActivationTargetWithVisibleButtons(buttons = unhandledVisibleActivationButtons()) {
    if (!buttons.length) return false;

    const minimumTarget = state.activated + state.failed + buttons.length;
    if (minimumTarget <= state.activationTarget) return false;

    // A visible open button is stronger evidence than an aggregate counter.
    // If PAYBACK's initial counter under-reported the list, widen the target
    // instead of finishing too early.
    hasReliableInitialInactiveCount = false;
    state.activationTarget = minimumTarget;
    return true;
  }

  function countActivatedIndicators() {
    return Math.max(activatedSignatures().size, activatedTotalFromPage());
  }

  async function confirmAllLoadedCouponsAreActivated() {
    // Fast exit before any scrolling. If PAYBACK exposes its own counters,
    // trust those: active > 0 and open === 0 means there is nothing to do.
    const firstCounters = pageCouponCounters();
    const firstOpenCount = activationControls().length;
    const firstActivated = activatedSignatures();
    if (firstCounters.inactive > 0 || firstOpenCount !== 0 ||
        (firstCounters.activated === 0 && firstActivated.size === 0)) return false;

    await sleep(450);

    const secondCounters = pageCouponCounters();
    const secondOpenCount = activationControls().length;
    const secondActivated = activatedSignatures();
    if (secondCounters.inactive > 0 || secondOpenCount !== 0 ||
        (secondCounters.activated === 0 && secondActivated.size === 0)) return false;

    if (firstCounters.activated > 0 || secondCounters.activated > 0) {
      return firstCounters.activated > 0 &&
        firstCounters.activated === secondCounters.activated &&
        secondCounters.inactive === 0;
    }

    return [...firstActivated].every((signature) => secondActivated.has(signature));
  }

  function scanPreActivatedIndicators(activatedThisRun = state.activated) {
    const paybackTotal = activatedTotalFromPage();
    if (initialActivatedTotal <= 0 && paybackTotal > 0) {
      // If PAYBACK's aggregate label appears only after the first activation,
      // subtract exactly the number activated in this run. This also works for
      // duplicate/identical coupons because it is count-based, not key-based.
      initialActivatedTotal = Math.max(0, paybackTotal - activatedThisRun);
    }
    if (initialActivatedTotal > 0) return initialActivatedTotal;

    // Fallback for layouts without an aggregate "Aktiviert (N)" label.
    return Math.max(0, countActivatedIndicators() - activatedThisRun);
  }

  function stableElementPath(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; depth < 7 && node instanceof Element; depth += 1) {
      const parent = node.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      const id = node.id ? `#${node.id}` : "";
      const testId = node.getAttribute?.("data-testid") || node.getAttribute?.("data-test-id") || "";
      parts.unshift(`${node.tagName.toLowerCase()}${id}${testId ? `[${testId}]` : ""}:${index}`);
      if (id) break;
      node = parent;
    }
    return parts.join(">");
  }

  function signatureFor(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i += 1) {
      const text = normalize(node.innerText || node.textContent || "");
      if (text.length >= 20 && text.length <= 1500) {
        const cleaned = text
          .replace(/jetzt aktivieren/g, "")
          .replace(/coupon aktivieren/g, "")
          .replace(/jetzt teilnehmen/g, "")
          .replace(/\bteilnehmen\b/g, "")
          .replace(/\baktivieren\b/g, "")
          .replace(/bereits aktiviert/g, "")
          .replace(/coupon aktiviert/g, "")
          .replace(/\baktiviert\b/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600);
        if (cleaned) return cleaned;
      }
      node = node.parentElement;
    }

    // Deterministic fallback: never use the current time here. The previous
    // timestamp fallback made the same badge look different between checks.
    return `${elementText(el)}|${stableElementPath(el)}`;
  }

  function identityHintFor(el) {
    const preferredAttributes = [
      "data-coupon-id",
      "data-couponid",
      "data-offer-id",
      "data-offerid",
      "data-campaign-id",
      "data-campaignid",
      "data-promotion-id",
      "data-promotionid",
      "data-id"
    ];

    let node = el;
    for (let depth = 0; depth < 8 && node instanceof Element; depth += 1) {
      if (node.id) return `id:${node.id}`;

      for (const name of preferredAttributes) {
        const value = node.getAttribute(name);
        if (value) return `${name}:${value}`;
      }

      // Coupon detail links often contain a stable backend identifier even if
      // the button itself does not expose one.
      if (node instanceof HTMLAnchorElement && node.href) return `href:${node.href}`;
      const detailLink = node.querySelector?.('a[href*="coupon" i], a[href*="offer" i], a[href*="aktion" i]');
      if (detailLink instanceof HTMLAnchorElement && detailLink.href) return `href:${detailLink.href}`;

      node = node.parentElement;
    }
    return "";
  }

  // IMPORTANT: activation identity must distinguish two coupons that have the
  // same visible text. v2.0.4 used signatureFor() alone, so two identical
  // coupons collapsed into one entry and only the first one was clicked.
  function activationKeyFor(el) {
    const hint = identityHintFor(el);
    const semantic = signatureFor(el);
    // Keep the DOM path even when an ID-like hint exists. Some layouts put a
    // shared ID/data-id on a parent container; the path makes simultaneous
    // duplicate coupons distinct while the hint keeps the key stable/readable.
    return `${hint ? `${hint}|` : ""}${semantic}|path:${stableElementPath(el)}`;
  }

  function ensureOverlay() {
    if (overlay && document.contains(overlay)) return overlay;

    overlay = document.createElement("div");
    overlay.id = "payback-coupon-activator-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "18px",
      right: "18px",
      width: "320px",
      zIndex: "2147483647",
      padding: "14px",
      borderRadius: "14px",
      background: "rgba(17,24,39,.96)",
      color: "#fff",
      font: "13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      boxShadow: "0 16px 40px rgba(0,0,0,.30)",
      backdropFilter: "blur(8px)"
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function setStyles(element, styles) {
    Object.assign(element.style, styles);
    return element;
  }

  function makeTextElement(tagName, text, styles = {}) {
    const element = document.createElement(tagName);
    element.textContent = String(text ?? "");
    setStyles(element, styles);
    return element;
  }

  function makeStat(value, label) {
    const wrapper = document.createElement("div");
    wrapper.append(
      makeTextElement("b", value, {
        display: "block",
        fontSize: "15px"
      }),
      makeTextElement("span", label, {
        color: "#9ca3af",
        fontSize: "11px"
      })
    );
    return wrapper;
  }

  function renderOverlay() {
    if (!running && !["success", "already_done", "cancelled", "error"].includes(state.phase)) return;
    const el = ensureOverlay();
    const statusIcon = state.phase === "error" ? "⚠" : state.phase === "cancelled" ? "⏸" : ["success", "already_done"].includes(state.phase) ? "✓" : "↻";
    const title = state.phase === "already_done" ? "Alles erledigt"
      : state.phase === "success" ? "Fertig"
        : state.phase === "error" ? "Fehler"
          : state.phase === "cancelled" ? "Gestoppt"
            : state.phase === "running" ? "Coupons werden aktiviert"
              : "Coupons werden geprüft";

    // Build the overlay only with DOM APIs. This avoids dynamic HTML parsing and
    // keeps all state-derived values in textContent/style properties.
    el.replaceChildren();

    const header = setStyles(document.createElement("div"), {
      display: "flex",
      gap: "10px",
      alignItems: "flex-start"
    });
    const icon = makeTextElement("div", statusIcon, {
      fontSize: "20px",
      lineHeight: "1"
    });
    const textArea = setStyles(document.createElement("div"), {
      minWidth: "0",
      flex: "1"
    });
    const stableOverlayMessage = state.phase === "running"
      ? "Automatische Batch-Aktivierung läuft."
      : state.phase === "scanning"
        ? "Suche nach offenen Coupons …"
        : state.message;

    textArea.append(
      makeTextElement("div", title, {
        fontWeight: "750",
        fontSize: "14px",
        marginBottom: "3px"
      }),
      makeTextElement("div", stableOverlayMessage, {
        color: "#d1d5db"
      })
    );
    header.append(icon, textArea);

    const progressTrack = setStyles(document.createElement("div"), {
      height: "6px",
      background: "#374151",
      borderRadius: "99px",
      overflow: "hidden",
      margin: "12px 0 10px"
    });
    const progressFill = setStyles(document.createElement("div"), {
      height: "100%",
      width: `${Math.max(0, Math.min(100, Number(state.progress) || 0))}%`,
      background: "#60a5fa",
      transition: "width .2s ease"
    });
    progressTrack.appendChild(progressFill);

    const stats = setStyles(document.createElement("div"), {
      display: "grid",
      gridTemplateColumns: "repeat(3,1fr)",
      gap: "8px",
      textAlign: "center"
    });
    stats.append(
      makeStat(state.pageActivatedTotal ?? state.alreadyActivated ?? 0, "aktiviert gesamt"),
      makeStat(state.pageInactiveTotal ?? state.remaining ?? 0, "nicht aktiviert"),
      makeStat(state.activated, "neu aktiviert")
    );

    el.append(header, progressTrack, stats);
  }

  function couponContainerFor(button) {
    let node = button;
    for (let depth = 0; depth < 8 && node instanceof Element; depth += 1) {
      const text = normalize(node.innerText || node.textContent || "");
      if (text.length >= 20 && text.length <= 1800 &&
          (text.includes("aktivieren") || text.includes("aktiviert") || text.includes("teilnehmen"))) {
        return node;
      }
      node = node.parentElement;
    }
    return button.parentElement || button;
  }

  function containerShowsActivated(button, container) {
    if (!(container instanceof Element) || !document.contains(container)) return false;
    const nodes = [container, ...container.querySelectorAll('button, [role="button"], span, p, div, strong, em, small')];
    return nodes.some((el) => el !== button && isActivatedIndicator(el));
  }

  async function verifyActivation(button, container) {
    const started = Date.now();
    while (Date.now() - started < 4200) {
      if (cancelRequested) return false;
      if (!document.contains(button)) return true;
      if (isActivatedIndicator(button) || isDisabled(button)) return true;
      if (!isActivationButton(button)) return true;
      if (containerShowsActivated(button, container)) return true;
      await sleep(160);
    }
    return false;
  }

  async function activateBatch(buttons, discovered) {
    const candidates = [];

    for (const button of buttons.slice(0, ACTIVATION_BATCH_SIZE)) {
      if (cancelRequested) break;
      if (!document.contains(button) || !isVisible(button) || isDisabled(button) || !isActivationButton(button)) continue;
      const activationKey = activationKeyFor(button);
      if (handledButtons.has(button) || handledActivationKeys.has(activationKey)) continue;

      handledButtons.add(button);
      handledActivationKeys.add(activationKey);
      discovered.add(activationKey);
      candidates.push({ button, container: couponContainerFor(button), activationKey });
    }

    if (!candidates.length) return 0;

    candidates[0].button.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(80);

    const clicked = [];
    for (const candidate of candidates) {
      if (cancelRequested) break;
      const { button } = candidate;
      if (!document.contains(button) || isDisabled(button) || !isActivationButton(button)) {
        updateState({ skipped: state.skipped + 1 });
        continue;
      }

      try {
        button.click();
        clicked.push(candidate);
      } catch (error) {
        console.warn("Coupon-Aktivierung fehlgeschlagen:", error);
        updateState({ failed: state.failed + 1 });
      }
      await sleep(BATCH_CLICK_STAGGER_MS);
    }

    updateState({
      phase: "running",
      message: `${clicked.length} Coupon${clicked.length === 1 ? "" : "s"} werden parallel bestätigt …`
    });

    const results = await Promise.all(clicked.map(({ button, container }) => verifyActivation(button, container)));
    const succeeded = results.filter(Boolean).length;
    const failed = results.length - succeeded;
    const nextActivated = state.activated + succeeded;

    await sleep(180);
    const liveCounts = liveRunCounts(nextActivated);
    updateState({
      activated: nextActivated,
      failed: state.failed + failed,
      alreadyActivated: initialActivatedTotal,
      pageActivatedTotal: liveCounts.activeTotal,
      pageInactiveTotal: liveCounts.remaining,
      pageTotal: liveCounts.total,
      remaining: liveCounts.remaining,
      found: Math.max(state.found, liveCounts.total, discovered.size),
      message: failed
        ? `${succeeded} aktiviert, ${failed} in diesem Batch nicht bestätigt.`
        : `${succeeded} Coupon${succeeded === 1 ? "" : "s"} in diesem Batch aktiviert.`
    });

    await sleep(BATCH_PAUSE_MS);
    return clicked.length;
  }

  function clearScheduledReload() {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = null;
    state.reloadPending = false;
  }

  function scheduleReloadAfterCompletion() {
    if (running || cancelRequested || reloadRequested || reloadTimer !== null ||
        !["success", "already_done"].includes(state.phase) || state.remaining !== 0 ||
        state.failed !== 0 || state.pageTotal === 0) return;

    reloadCompletionMessage = state.message;
    updateState({
      reloadPending: true,
      message: `${reloadCompletionMessage} Die Seite wird gleich ohne Cache neu geladen.`
    });
    // Return the completed run to the popup before navigating. Status polling
    // never schedules a reload, and a fresh content script never auto-starts.
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      if (running || cancelRequested) {
        updateState({ reloadPending: false, message: reloadCompletionMessage });
        return;
      }
      reloadRequested = true;
      try {
        const result = await browser.runtime.sendMessage({ type: "PAYBACK_FORCE_RELOAD" });
        if (!result?.reloaded) throw new Error(result?.error || "Keine Bestätigung erhalten.");
      } catch (error) {
        reloadRequested = false;
        updateState({
          reloadPending: false,
          message: `${reloadCompletionMessage} Automatisches Neuladen fehlgeschlagen. Bitte mit Strg + F5 neu laden.`
        });
        console.warn("PAYBACK-Seite konnte nicht neu geladen werden:", error);
      }
    }, RELOAD_DELAY_MS);
  }

  async function runActivator() {
    if (running) return snapshot();

    // PAYBACK leaves its tab counters stale until F5. If this content script
    // has already completed a run and still sees no activation controls, do
    // not start another full scan just because the page text still contains
    // the old "Nicht aktiviert (N)" value. A real page reload resets this
    // content script and therefore also resets this guard.
    if (TERMINAL_PHASES.has(state.phase) && state.remaining === 0 && activationControls().length === 0 &&
        pendingCodeEntryControls().length === 0) {
      updateState({
        phase: "already_done",
        pageInactiveTotal: 0,
        remaining: 0,
        message: "Alle Coupons sind bereits aktiviert."
      });
      return snapshot();
    }

    running = true;
    cancelRequested = false;
    handledButtons = new WeakSet();
    handledActivationKeys = new Set();
    codeEntryButtons = new WeakSet();
    codeEntryKeys = new Set();
    initialActivatedTotal = 0;
    initialInactiveTotal = 0;
    initialPageTotal = 0;
    hasReliableInitialInactiveCount = false;
    const originalY = window.scrollY;
    const runStartedAt = Date.now();
    let stableBottomRounds = 0;
    let lastHeight = -1;
    let discovered = new Set();

    updateState({
      phase: "scanning",
      message: "Suche nach Coupons …",
      found: 0,
      activated: 0,
      alreadyActivated: 0,
      pageActivatedTotal: 0,
      pageInactiveTotal: 0,
      pageTotal: 0,
      activationTarget: 0,
      failed: 0,
      skipped: 0,
      codeEntryRequired: 0,
      codeEntryClicked: 0,
      remaining: 0,
      progress: 0,
      startedAt: Date.now()
    });

    try {
      window.scrollTo({ top: 0, behavior: "auto" });
      await sleep(600);
      const initialCounters = pageCouponCounters();
      await processCodeEntryOffers();
      const initialVisibleOpen = activationControls().length;
      initialActivatedTotal = initialCounters.activated;
      initialInactiveTotal = initialCounters.rawInactive;
      initialPageTotal = initialCounters.total;
      hasReliableInitialInactiveCount = Boolean(
        initialCounters.hasExplicitInactiveCounter ||
        initialCounters.hasTotalCounter ||
        (initialCounters.hasCouponTabCounter && initialCounters.activated > 0)
      );

      const initialTarget = hasReliableInitialInactiveCount
        ? Math.max(0, initialInactiveTotal - state.codeEntryRequired)
        : Math.max(initialCounters.inactive, initialVisibleOpen);

      updateState({
        pageActivatedTotal: initialActivatedTotal,
        pageInactiveTotal: initialTarget,
        pageTotal: Math.max(initialPageTotal, initialActivatedTotal + initialTarget),
        activationTarget: initialTarget,
        found: Math.max(initialPageTotal, initialActivatedTotal + initialTarget),
        remaining: initialTarget,
        alreadyActivated: initialActivatedTotal
      });

      // Fast path for the common case where every coupon is already active.
      // Previously the extension still scrolled through the whole page and
      // waited for several stable-bottom rounds before reaching this result.
      if (await confirmAllLoadedCouponsAreActivated()) {
        const alreadyActivated = scanPreActivatedIndicators();
        updateState({
          phase: "already_done",
          found: Math.max(state.found, alreadyActivated),
          alreadyActivated,
          pageActivatedTotal: alreadyActivated,
          pageInactiveTotal: 0,
          pageTotal: Math.max(state.pageTotal, alreadyActivated),
          remaining: 0,
          message: `Alle ${alreadyActivated} Coupons sind bereits aktiviert. Prüfung beendet – kein Scrollen nötig.`
        });
        return snapshot();
      }

      for (let round = 0; round < 120; round += 1) {
        if (cancelRequested) break;
        if (Date.now() - runStartedAt > MAX_RUN_MS) {
          throw new Error("Sicherheitsabbruch: Die Prüfung hat länger als 4 Minuten gedauert.");
        }

        await processCodeEntryOffers();
        const buttons = activationButtons();
        const visibleKeys = buttons.map(activationKeyFor);
        visibleKeys.forEach((key) => discovered.add(key));

        let pendingButtons = unhandledVisibleActivationButtons();

        if (!hasReliableInitialInactiveCount) {
          state.activationTarget = Math.max(
            state.activationTarget,
            discovered.size,
            state.activated + state.failed + pendingButtons.length
          );
        } else {
          reconcileActivationTargetWithVisibleButtons(pendingButtons);
        }

        const liveBeforeBatch = liveRunCounts();
        updateState({
          phase: pendingButtons.length ? "running" : "scanning",
          found: Math.max(state.found, discovered.size, liveBeforeBatch.total),
          alreadyActivated: initialActivatedTotal,
          pageActivatedTotal: liveBeforeBatch.activeTotal,
          pageInactiveTotal: liveBeforeBatch.remaining,
          pageTotal: liveBeforeBatch.total,
          remaining: liveBeforeBatch.remaining,
          message: pendingButtons.length
            ? `${pendingButtons.length} offene Coupon${pendingButtons.length === 1 ? "" : "s"} in diesem Abschnitt gefunden.`
            : "Prüfe weitere Coupons …"
        });

        let processedThisRound = 0;

        while (pendingButtons.length && !cancelRequested) {
          updateState({
            phase: "running",
            found: Math.max(state.found, discovered.size, state.pageTotal),
            message: `Aktiviere bis zu ${Math.min(ACTIVATION_BATCH_SIZE, pendingButtons.length)} Coupons gleichzeitig …`
          });

          processedThisRound += await activateBatch(pendingButtons, discovered);
          await processCodeEntryOffers();
          pendingButtons = unhandledVisibleActivationButtons();
          reconcileActivationTargetWithVisibleButtons(pendingButtons);
        }

        const pendingAfterBatch = unhandledVisibleActivationButtons();
        reconcileActivationTargetWithVisibleButtons(pendingAfterBatch);
        const liveAfterBatch = liveRunCounts();

        // PAYBACK's own "Nicht aktiviert (N)" label stays unchanged until F5.
        // The extension therefore finishes from its frozen baseline + verified
        // successes. If the derived remaining count is zero and no new open
        // control is visible, there is nothing left to scan or scroll for.
        if (liveAfterBatch.remaining === 0 && pendingAfterBatch.length === 0) {
          updateState({
            phase: state.activated > 0 ? "success" : "already_done",
            alreadyActivated: initialActivatedTotal,
            pageActivatedTotal: liveAfterBatch.activeTotal,
            pageInactiveTotal: 0,
            pageTotal: liveAfterBatch.total,
            remaining: 0,
            message: state.activated > 0
              ? `Fertig. ${state.activated} Coupon${state.activated === 1 ? "" : "s"} neu aktiviert.`
              : "Alle Coupons sind bereits aktiviert."
          });
          return snapshot();
        }

        const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        const nearBottom = window.scrollY + window.innerHeight >= height - 100;

        if (nearBottom && height === lastHeight && processedThisRound === 0) stableBottomRounds += 1;
        else stableBottomRounds = 0;
        lastHeight = height;

        if (stableBottomRounds >= 3) break;

        if (!nearBottom) {
          window.scrollBy({ top: Math.max(540, window.innerHeight * 0.82), behavior: "auto" });
        } else {
          window.scrollTo({ top: height, behavior: "auto" });
        }
        await sleep(650);
      }

      if (cancelRequested) {
        const cancelledCounts = liveRunCounts();
        updateState({
          phase: "cancelled",
          pageActivatedTotal: cancelledCounts.activeTotal,
          pageInactiveTotal: cancelledCounts.remaining,
          pageTotal: cancelledCounts.total,
          remaining: cancelledCounts.remaining,
          message: "Vorgang wurde gestoppt. Du kannst ihn jederzeit fortsetzen."
        });
        return snapshot();
      }

      window.scrollTo({ top: 0, behavior: "auto" });
      await sleep(700);

      await processCodeEntryOffers();
      const finalPendingButtons = unhandledVisibleActivationButtons();
      reconcileActivationTargetWithVisibleButtons(finalPendingButtons);
      const finalLiveCounts = liveRunCounts();
      const activatedIndicatorCount = countActivatedIndicators();
      const pageMentionsCoupons = normalize(document.body?.innerText || "").includes("coupon");

      if (finalLiveCounts.remaining === 0 && finalPendingButtons.length === 0 && state.activated === 0 && activatedIndicatorCount > 0) {
        updateState({
          phase: "already_done",
          alreadyActivated: initialActivatedTotal || activatedIndicatorCount,
          pageActivatedTotal: finalLiveCounts.activeTotal || activatedIndicatorCount,
          pageInactiveTotal: 0,
          pageTotal: finalLiveCounts.total || activatedIndicatorCount,
          remaining: 0,
          message: "Alle erkannten Coupons sind bereits aktiviert."
        });
      } else if (finalLiveCounts.remaining === 0 && finalPendingButtons.length === 0 && state.activated > 0) {
        updateState({
          phase: "success",
          alreadyActivated: initialActivatedTotal,
          pageActivatedTotal: finalLiveCounts.activeTotal,
          pageInactiveTotal: 0,
          pageTotal: finalLiveCounts.total,
          remaining: 0,
          message: state.failed
            ? `${state.activated} aktiviert. ${state.failed} Coupon${state.failed === 1 ? "" : "s"} konnten nicht bestätigt werden.`
            : `Alle gefundenen Coupons wurden geprüft. ${state.activated} neu aktiviert.`
        });
      } else if (finalLiveCounts.remaining > 0 || finalPendingButtons.length > 0) {
        const remaining = Math.max(finalLiveCounts.remaining, finalPendingButtons.length);
        updateState({
          phase: "error",
          alreadyActivated: initialActivatedTotal,
          pageActivatedTotal: finalLiveCounts.activeTotal,
          pageInactiveTotal: remaining,
          pageTotal: Math.max(finalLiveCounts.total, finalLiveCounts.activeTotal + remaining),
          remaining,
          message: `${remaining} Coupon${remaining === 1 ? "" : "s"} konnten nicht sicher als aktiviert bestätigt werden. Bitte erneut versuchen.`
        });
      } else {
        updateState({
          phase: "already_done",
          pageInactiveTotal: 0,
          remaining: 0,
          message: pageMentionsCoupons
            ? "Keine offenen Coupon-Buttons gefunden. Es gibt aktuell nichts zu aktivieren."
            : "Keine Coupons erkannt. Öffne bitte die PAYBACK-Couponübersicht und starte erneut."
        });
      }

      return snapshot();
    } catch (error) {
      console.error("PAYBACK Coupon Activation:", error);
      updateState({
        phase: "error",
        message: `Unerwarteter Fehler: ${error?.message || "Unbekannter Fehler"}`
      });
      return snapshot();
    } finally {
      running = false;
      window.scrollTo({ top: originalY, behavior: "auto" });
      if (overlay) {
        setTimeout(() => {
          if (!running && overlay) {
            overlay.remove();
            overlay = null;
          }
        }, 6500);
      }
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "PAYBACK_GET_STATUS") {
      refreshPageCounters(false);
      return Promise.resolve(snapshot());
    }
    if (message?.type === "PAYBACK_START") {
      if (reloadRequested) return Promise.resolve(snapshot());
      clearScheduledReload();
      return runActivator().then(() => {
        scheduleReloadAfterCompletion();
        return snapshot();
      });
    }
    if (message?.type === "PAYBACK_CANCEL") {
      if (state.reloadPending && !reloadRequested) {
        clearScheduledReload();
        updateState({ message: `${reloadCompletionMessage} Automatisches Neuladen gestoppt.` });
        return Promise.resolve(snapshot());
      }
      cancelRequested = true;
      updateState({ message: "Stoppe nach dem aktuellen Schritt …" });
      return Promise.resolve(snapshot());
    }
  });
})();
