const $ = (id) => document.getElementById(id);
let activeTabId = null;
let pollTimer = null;
let supported = false;
let waitingForReload = false;

const TERMINAL_PHASES = new Set(["success", "already_done", "cancelled", "error"]);
const PAYBACK_COUPON_URL = "https://www.payback.de/coupons";

const PHASE_UI = {
  idle: ["Bereit", "idle"],
  scanning: ["Coupons werden geprüft", "running"],
  running: ["Coupons werden aktiviert", "running"],
  success: ["Fertig", "success"],
  already_done: ["Alles erledigt", "success"],
  cancelled: ["Gestoppt", "cancelled"],
  error: ["Prüfung unvollständig", "error"]
};

function isPaybackUrl(url = "") {
  return /^https:\/\/(?:www\.)?payback\.de\//i.test(url);
}

function render(state = {}) {
  waitingForReload = Boolean(state.reloadPending);
  const phase = state.phase || "idle";
  const [title, dotClass] = PHASE_UI[phase] || PHASE_UI.idle;
  const isRunning = phase === "running" || phase === "scanning";

  // Keep the primary status calm while a run is active. content.js may emit
  // detailed batch messages several times per second; showing each one made
  // the popup feel jumpy even though the underlying work was healthy.
  const stableMessage = phase === "running"
    ? "Offene Coupons werden automatisch in kleinen, sicheren Batches aktiviert."
    : phase === "scanning"
      ? "Die PAYBACK-Seite wird nach offenen Coupons durchsucht."
      : (state.message || "Bereit.");

  $("statusTitle").textContent = title;
  $("statusMessage").textContent = stableMessage;
  $("statusDot").className = `dot ${dotClass}`;
  $("statusCard").classList.toggle("is-running", isRunning);

  const progress = Number(state.progress || 0);
  $("progressBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  $("progressLabel").textContent = `${progress} %`;
  $("remainingLabel").textContent = `${Number(state.remaining || 0)} offen`;

  const activeTotal = Number(state.pageActivatedTotal ?? state.alreadyActivated ?? 0);
  const inactiveTotal = Number(state.pageInactiveTotal ?? state.remaining ?? 0);
  const activatedThisRun = Number(state.activated || 0);
  const failedThisRun = Number(state.failed || 0);
  $("pageActivatedTotal").textContent = String(activeTotal);
  $("pageInactiveTotal").textContent = String(inactiveTotal);
  $("activated").textContent = String(activatedThisRun);
  $("failed").textContent = String(failedThisRun);

  const target = Math.max(
    Number(state.activationTarget || 0),
    activatedThisRun + failedThisRun + inactiveTotal
  );
  const processed = target > 0
    ? Math.min(target, activatedThisRun + failedThisRun)
    : activatedThisRun + failedThisRun;
  $("processedCount").textContent = target > 0 ? `${processed} / ${target}` : String(processed);
  $("runSuccessCount").textContent = String(activatedThisRun);
  $("runErrorCount").textContent = String(failedThisRun);
  $("runSummary").classList.toggle("hidden", !isRunning);

  $("startButton").disabled = !supported || isRunning || Boolean(state.reloadPending);
  $("startButton").textContent = state.reloadPending
    ? "Seite wird neu geladen …"
    : ["success", "already_done", "cancelled", "error"].includes(phase)
    ? "Erneut prüfen"
    : "Coupons aktivieren";
  $("cancelButton").classList.toggle("hidden", !isRunning);
}

async function ensureContentScript() {
  if (!activeTabId || !supported) return;
  try {
    await browser.tabs.sendMessage(activeTabId, { type: "PAYBACK_GET_STATUS" });
  } catch (_) {
    await browser.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"]
    });
  }
}

async function sendToTab(type) {
  if (!activeTabId) throw new Error("Kein aktiver Tab.");
  await ensureContentScript();
  return browser.tabs.sendMessage(activeTabId, { type });
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  if (pollTimer || !supported) return;
  pollTimer = setInterval(refreshStatus, 450);
}

async function refreshStatus() {
  if (!supported) return;
  try {
    const state = await sendToTab("PAYBACK_GET_STATUS");
    render(state);
    if (TERMINAL_PHASES.has(state?.phase) && !state.reloadPending) stopPolling();
    else if (state.reloadPending) startPolling();
    return state;
  } catch (error) {
    // The old content script disappears during the automatic reload. Keep
    // its completion visible and let the next poll reach the fresh page.
    if (waitingForReload) return;
    $("statusTitle").textContent = "Verbindung fehlgeschlagen";
    $("statusMessage").textContent = "Die PAYBACK-Seite konnte nicht angesprochen werden. Lade den Tab einmal neu und versuche es erneut.";
    $("statusDot").className = "dot error";
    $("startButton").disabled = true;
  }
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;
  supported = Boolean(tab && isPaybackUrl(tab.url || ""));

  $("unsupported").classList.toggle("hidden", supported);
  $("statusCard").classList.toggle("hidden", !supported);
  $("startButton").disabled = !supported;

  if (supported) {
    const state = await refreshStatus();
    if (!TERMINAL_PHASES.has(state?.phase) || state.reloadPending) startPolling();
  }
}

$("startButton").addEventListener("click", async () => {
  try {
    $("startButton").disabled = true;
    startPolling();
    await sendToTab("PAYBACK_START");
    await refreshStatus();
  } catch (error) {
    render({ phase: "error", message: "Start fehlgeschlagen. Lade die PAYBACK-Seite einmal neu und versuche es erneut." });
  }
});

$("cancelButton").addEventListener("click", async () => {
  try {
    await sendToTab("PAYBACK_CANCEL");
    await refreshStatus();
  } catch (_) {}
});

$("couponPageButton").addEventListener("click", async () => {
  try {
    await browser.tabs.create({ url: PAYBACK_COUPON_URL });
    window.close();
  } catch (_) {
    // Fallback, falls das Öffnen eines Tabs unerwartet fehlschlägt.
    window.open(PAYBACK_COUPON_URL, "_blank", "noopener,noreferrer");
  }
});

window.addEventListener("unload", () => {
  stopPolling();
});

init();
