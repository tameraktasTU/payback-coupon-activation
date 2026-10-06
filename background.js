const BADGE_COLORS = {
  idle: "#6b7280",
  scanning: "#2563eb",
  running: "#2563eb",
  success: "#15803d",
  already_done: "#15803d",
  cancelled: "#b45309",
  error: "#b91c1c"
};

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message?.type === "PAYBACK_FORCE_RELOAD") {
    const tabId = sender.tab?.id;
    const isPaybackUrl = (url) => /^https:\/\/(?:www\.)?payback\.de\//i.test(url || "");
    if (!Number.isInteger(tabId) || (sender.frameId != null && sender.frameId !== 0) ||
        !isPaybackUrl(sender.url || sender.tab?.url)) {
      return { reloaded: false, error: "Keine PAYBACK-Seite als Absender erkannt." };
    }
    try {
      const tab = await browser.tabs.get(tabId);
      if (!isPaybackUrl(tab.url) || (sender.url && sender.url !== tab.url)) {
        return { reloaded: false, error: "Die Seite wurde inzwischen gewechselt." };
      }
      await browser.tabs.reload(tabId, { bypassCache: true });
      return { reloaded: true };
    } catch (error) {
      return { reloaded: false, error: error?.message || "Neuladen fehlgeschlagen." };
    }
  }

  if (message?.type !== "PAYBACK_PROGRESS" || !sender.tab?.id) return;

  const tabId = sender.tab.id;
  const state = message.state || {};
  const phase = state.phase || "idle";

  let text = "";
  if (phase === "running" || phase === "scanning") {
    text = String(state.activated || 0);
  } else if (phase === "success") {
    text = "✓";
  } else if (phase === "already_done") {
    text = "✓";
  } else if (phase === "cancelled") {
    text = "⏸";
  } else if (phase === "error") {
    text = "!";
  }

  try {
    await browser.action.setBadgeText({ tabId, text });
    if (text) {
      await browser.action.setBadgeBackgroundColor({
        tabId,
        color: BADGE_COLORS[phase] || BADGE_COLORS.idle
      });
    }
  } catch (error) {
    console.debug("Badge konnte nicht aktualisiert werden:", error);
  }
});
