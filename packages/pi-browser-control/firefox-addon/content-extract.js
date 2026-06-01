/**
 * pi-browser-control content extraction script.
 *
 * Injected into the target tab via browser.tabs.executeScript().
 * Returns the full page text and all hyperlinks.
 *
 * The LAST expression in this script is returned as the result.
 */

(function extractContent() {
  const fullText = document.body ? document.body.innerText : "";

  const linkElements = document.querySelectorAll("a[href]");
  const links = [];
  for (const a of linkElements) {
    const url = a.href;
    const text = (a.textContent ?? "").trim();
    if (url && url.startsWith("http")) {
      links.push({ url, text });
    }
  }

  return { fullText, links };
})();
