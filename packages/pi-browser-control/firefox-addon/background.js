/**
 * pi-browser-control Firefox background script.
 *
 * On load: connects to the native messaging host (pi_browser_control daemon).
 * Handles requests from the daemon and replies with tab data.
 *
 * Protocol (NM frames: [UInt32 native-endian length][UTF-8 JSON]):
 *   daemon → addon: { correlationId, op, params? }
 *   addon → daemon: { correlationId, ok, result|error }
 *
 * Ops:
 *   listTabs       → browser.tabs.query({}) → { tabs:[{id,url,title,lastAccessed}] }
 *   getTabContent  → executeScript with content-extract.js → { tabId, fullText, totalLength, isTruncated, links? }
 *   ping           → { addon:"ready", version }
 *
 * Note: console.log is fine here — we run in the browser extension context,
 * not in the daemon process. stdout is Firefox's, not the NM stream.
 */

/* global browser */

// ---------------------------------------------------------------------------
// URL normalization helper
// ---------------------------------------------------------------------------

/**
 * Normalize a URL per the pi-browser-control spec:
 *  1. Remove fragment.
 *  2. Sort query parameters alphabetically by name (stable).
 *  3. Return null for null/empty, unparseable, or non-http/https URLs.
 *  4. Values are re-encoded via URLSearchParams form-encoding (`%20`→`+`, etc.), so output is canonicalized rather than byte-preserved.
 */
function normalizeUrl(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Remove fragment
  parsed.hash = "";
  // Sort query params by name (stable: preserve relative order of same-named params)
  const entries = [...parsed.searchParams.entries()];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  parsed.search = "";
  entries.forEach(([k, v]) => parsed.searchParams.append(k, v));
  return parsed.toString();
}

const NM_HOST_NAME = "pi_browser_control";
const ADDON_VERSION = "0.1.0";
const CONTENT_CHUNK_MAX = 900 * 1024; // ~900 KB per response
const EXTRACT_TIMEOUT_MS = 5000; // fail fast if executeScript stalls (e.g. streaming SPA)

let port = null;

// ---------------------------------------------------------------------------
// Connect to native messaging host
// ---------------------------------------------------------------------------

function connect() {
  port = browser.runtime.connectNative(NM_HOST_NAME);
  console.log("[pi-browser-control] connected to native host");

  port.onMessage.addListener(handleMessage);

  port.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError;
    console.warn("[pi-browser-control] disconnected from native host", err?.message);
    port = null;
    // Reconnect after a delay
    setTimeout(connect, 3000);
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const { correlationId, op, params } = msg;

  try {
    let result;

    if (op === "ping") {
      result = { addon: "ready", version: ADDON_VERSION };

    } else if (op === "listTabs") {
      const tabs = await browser.tabs.query({});
      result = {
        tabs: tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          index: t.index,
          url: t.url,
          normalizedUrl: normalizeUrl(t.url),
          title: t.title,
          favIconUrl: t.favIconUrl ?? null,
          status: t.status,
          active: t.active,
          pinned: t.pinned,
          hidden: t.hidden,
          discarded: t.discarded,
          incognito: t.incognito,
          audible: t.audible,
          mutedInfo: t.mutedInfo ? { muted: t.mutedInfo.muted, reason: t.mutedInfo.reason ?? null } : null,
          isArticle: t.isArticle,
          isInReaderMode: t.isInReaderMode,
          lastAccessed: t.lastAccessed,
          cookieStoreId: t.cookieStoreId ?? null,
        })),
      };

    } else if (op === "getTabContent") {
      const tabId = params?.tabId;
      const offset = params?.offset ?? 0;

      if (typeof tabId !== "number") {
        sendReply(correlationId, false, null, { code: "TAB_NOT_FOUND", message: "tabId is required" });
        return;
      }

      // Verify the tab exists
      let tab;
      try {
        tab = await browser.tabs.get(tabId);
      } catch {
        sendReply(correlationId, false, null, { code: "TAB_NOT_FOUND", message: `Tab ${tabId} not found` });
        return;
      }

      // Protect privileged pages (about:, chrome:, etc.)
      const url = tab.url ?? "";
      if (url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("moz-extension:")) {
        sendReply(correlationId, false, null, { code: "TAB_PROTECTED", message: `Tab ${tabId} is a protected page` });
        return;
      }

      // Discarded (unloaded) tabs have no content process, so executeScript
      // would hang until the daemon deadline. Fail fast with clear guidance.
      // Firefox unloads inactive tabs aggressively, so this is common when
      // many tabs are open.
      if (tab.discarded) {
        sendReply(correlationId, false, null, { code: "TAB_DISCARDED", message: `Tab ${tabId} is unloaded (discarded). Switch to it in Firefox to load it, then retry — or choose a loaded tab.` });
        return;
      }

      // Inject content script. Two changes vs the naive call:
      //  - runAt: "document_end" so we don't wait for the load event + idle
      //    network period (streaming/SPA tabs may never reach idle).
      //  - race against a timeout: executeScript can still hang (frozen tab,
      //    huge DOM, blocked main thread). Fail fast instead of letting the
      //    daemon deadline (~60s) expire. The tab's status/discarded state is
      //    included to make the failure diagnosable.
      let extracted;
      try {
        const exec = browser.tabs.executeScript(tabId, {
          file: "content-extract.js",
          runAt: "document_end",
        });
        const TIMEOUT = Symbol("timeout");
        const timer = new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), EXTRACT_TIMEOUT_MS));
        const raced = await Promise.race([exec, timer]);
        if (raced === TIMEOUT) {
          sendReply(correlationId, false, null, {
            code: "EXTRACTION_TIMEOUT",
            message: `Tab ${tabId} did not return content within ${EXTRACT_TIMEOUT_MS / 1000}s (status=${tab.status ?? "?"}, discarded=${String(tab.discarded)}). The page may be still loading or unresponsive; switch to it in Firefox and retry, or choose another tab.`,
          });
          return;
        }
        extracted = raced?.[0];
      } catch (e) {
        sendReply(correlationId, false, null, { code: "EXTRACTION_FAILED", message: String(e) });
        return;
      }

      if (!extracted || typeof extracted.fullText !== "string") {
        sendReply(correlationId, false, null, { code: "EXTRACTION_FAILED", message: "Content script returned no data" });
        return;
      }

      const fullTextAll = extracted.fullText;
      const totalLength = fullTextAll.length;

      // Slice the chunk at the requested offset
      const chunk = fullTextAll.slice(offset, offset + CONTENT_CHUNK_MAX);
      const isTruncated = offset + CONTENT_CHUNK_MAX < totalLength;

      result = {
        tabId,
        fullText: chunk,
        totalLength,
        isTruncated,
        // Links only on first call (offset === 0)
        ...(offset === 0 ? { links: extracted.links ?? [] } : {}),
      };

    } else {
      sendReply(correlationId, false, null, { code: "INTERNAL", message: `Unknown op: ${String(op)}` });
      return;
    }

    sendReply(correlationId, true, result, null);

  } catch (e) {
    sendReply(correlationId, false, null, { code: "INTERNAL", message: String(e) });
  }
}

// ---------------------------------------------------------------------------
// Send reply over native messaging
// ---------------------------------------------------------------------------

function sendReply(correlationId, ok, result, error) {
  if (!port) {
    console.warn("[pi-browser-control] port not available, cannot send reply");
    return;
  }
  if (ok) {
    port.postMessage({ correlationId, ok: true, result });
  } else {
    port.postMessage({ correlationId, ok: false, error });
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connect();
