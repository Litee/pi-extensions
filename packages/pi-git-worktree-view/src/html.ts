/**
 * Returns the complete single-page application HTML string.
 * Everything — styles, markup, and script — is inlined.
 */
export function buildHtml(): string {
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Git Worktree View</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:          #1e1e1e;
    --panel:       #252526;
    --panel-border:#3c3c3c;
    --accent:      #007acc;
    --accent-dim:  #0e639c;
    --text:        #cccccc;
    --text-muted:  #858585;
    --text-dim:    #6a9955;
    --added-bg:    #1a3a1a;
    --added-fg:    #4ec94e;
    --removed-bg:  #3a1a1a;
    --removed-fg:  #f44747;
    --context-bg:  #1e1e1e;
  --linenr-bg:   #1c1c1c;
    --linenr-fg:   #5a5a5a;
    --absent-bg:   #161616;
    --absent-ln-bg:#131313;
    --selected-bg: #094771;
    --badge-M:     #e2c08d;
    --badge-A:     #4ec94e;
    --badge-D:     #f44747;
    --badge-R:     #c586c0;
    --badge-C:     #9cdcfe;
    --badge-U:     #f44747;
    --badge-Q:     #858585;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: var(--files-width, 280px) 4px 1fr;
    grid-template-areas:
      "worktrees worktrees worktrees"
      "files     resizer   diff";
    overflow: hidden;
  }

  /* ── WORKTREE PANEL ─────────────────────────────────── */
  #worktrees {
    grid-area: worktrees;
    background: var(--panel);
    border-bottom: 1px solid var(--panel-border);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    overflow-x: auto;
    flex-wrap: nowrap;
  }

  #worktrees-label {
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
    white-space: nowrap;
    margin-right: 6px;
    flex-shrink: 0;
  }

  .worktree-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 3px;
    border: 1px solid var(--panel-border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
    transition: border-color .15s, background .15s;
    font-size: 12px;
  }
  .worktree-chip:hover  { border-color: var(--accent); }
  .worktree-chip.active { background: var(--selected-bg); border-color: var(--accent); color: #fff; }
  .worktree-chip .branch {
    color: var(--text-muted);
    font-size: 11px;
  }
  .worktree-chip.active .branch { color: #9cdcfe; }

  /* ── FILES PANEL ────────────────────────────────────── */
  #files {
    grid-area: files;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 120px;
    max-width: 600px;
  }

  /* ── TREE VIEW ───────────────────────────────────────── */
  .tree-dir, .tree-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 12px;
    font-family: "Menlo", "Consolas", monospace;
    white-space: nowrap;
    overflow: hidden;
    border-left: 2px solid transparent;
    user-select: none;
  }
  .tree-dir:hover  { background: #2a2d2e; }
  .tree-file:hover { background: #2a2d2e; }
  .tree-file.active { background: var(--selected-bg); border-left-color: var(--accent); }

  .tree-toggle {
    flex-shrink: 0;
    width: 14px;
    font-size: 9px;
    color: var(--text-muted);
    text-align: center;
    transition: transform .12s;
  }
  .tree-toggle.open { transform: rotate(90deg); }

  .tree-icon {
    flex-shrink: 0;
    font-size: 11px;
  }

  .tree-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
  .tree-dir .tree-name { color: #c8c8c8; }

  .tree-children { display: contents; }
  .tree-children.collapsed { display: none; }

  #resizer {
    grid-area: resizer;
    width: 4px;
    background: var(--panel-border);
    cursor: col-resize;
    transition: background .15s;
    position: relative;
    z-index: 10;
  }
  #resizer:hover,
  #resizer.dragging { background: var(--accent); }

  #files-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--panel-border);
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
    flex-shrink: 0;
  }

  #files-list {
    overflow-y: auto;
    flex: 1;
  }

  /* ── TREE VIEW ─────────────────────────────────────── */
  .tree-dir, .tree-file {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 12px;
    font-family: "Menlo", "Consolas", monospace;
    white-space: nowrap;
    overflow: hidden;
    border-left: 2px solid transparent;
    user-select: none;
  }
  .tree-dir:hover  { background: #2a2d2e; }
  .tree-file:hover { background: #2a2d2e; }
  .tree-file.active { background: var(--selected-bg); border-left-color: var(--accent); }

  .tree-toggle {
    flex-shrink: 0;
    width: 12px;
    font-size: 8px;
    color: var(--text-muted);
    text-align: center;
    display: inline-block;
    transition: transform .12s;
  }
  .tree-toggle.open { transform: rotate(90deg); }

  .tree-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
  .tree-dir .tree-name { color: #c8c8c8; }

  .tree-children { display: contents; }
  .tree-children.collapsed { display: none; }

  .badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
    font-family: monospace;
  }
  .badge-M { background: #3a2d12; color: var(--badge-M); }
  .badge-A { background: #1a3a1a; color: var(--badge-A); }
  .badge-D { background: #3a1a1a; color: var(--badge-D); }
  .badge-R { background: #2d1a2d; color: var(--badge-R); }
  .badge-C { background: #1a2535; color: var(--badge-C); }
  .badge-U { background: #1a3a1a; color: var(--badge-A); }  /* untracked = green, like VS Code */
  .badge-Q { background: #252526; color: var(--badge-Q); border: 1px solid #444; }

  /* ── DIFF PANEL ─────────────────────────────────────── */
  #diff {
    grid-area: diff;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }

  #diff-header {
    padding: 8px 14px;
    border-bottom: 1px solid var(--panel-border);
    color: var(--text-muted);
    font-size: 12px;
    font-family: "Menlo", "Consolas", monospace;
    background: var(--panel);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  #diff-header .diff-filename { color: var(--text); }

  #diff-scroll {
    overflow: auto;
    flex: 1;
  }

  table.diff-table {
    width: 100%;
    border-collapse: collapse;
    font-family: "Menlo", "Consolas", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-table tr { vertical-align: top; }

  .diff-table .ln {
    width: 44px;
    min-width: 44px;
    text-align: right;
    padding: 0 8px;
    color: var(--linenr-fg);
    background: var(--linenr-bg);
    user-select: none;
    border-right: 1px solid var(--panel-border);
    white-space: nowrap;
    font-size: 11px;
  }

  .diff-table .code {
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .diff-table .divider {
    width: 1px;
    background: var(--panel-border);
    padding: 0;
  }

  /* added row: right side is green, left side (absent) is dimmed */
  .diff-table tr.added   .right-code { background: var(--added-bg);   color: var(--added-fg); }
  .diff-table tr.added   .left-code  { background: var(--absent-bg); }
  .diff-table tr.added   .left-ln    { background: var(--absent-ln-bg); }
  /* removed row: left side is red, right side (absent) is dimmed */
  .diff-table tr.removed .left-code  { background: var(--removed-bg); color: var(--removed-fg); }
  .diff-table tr.removed .right-code { background: var(--absent-bg); }
  .diff-table tr.removed .right-ln   { background: var(--absent-ln-bg); }
  /* context rows */
  .diff-table tr.context .left-code,
  .diff-table tr.context .right-code { background: var(--context-bg); }
  .diff-table tr.hunk td             { background: #1a2535; color: #569cd6; font-size: 11px; }

  /* placeholder / loading */
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 14px;
    flex-direction: column;
    gap: 8px;
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid var(--panel-border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: #424242; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }
</style>
</head>
<body>

<!-- WORKTREE BAR -->
<div id="worktrees">
  <span id="worktrees-label">Worktrees</span>
  <div id="worktree-chips"><span style="color:var(--text-muted);font-size:12px">Loading…</span></div>
</div>

<!-- FILES PANEL -->
<div id="files">
  <div id="files-header">Changed Files</div>
  <div id="files-list">
    <div class="placeholder" style="padding:24px 0">
      <span style="color:var(--text-muted);font-size:12px">Select a worktree</span>
    </div>
  </div>
</div>

<!-- RESIZER -->
<div id="resizer"></div>

<!-- DIFF PANEL -->
<div id="diff">
  <div id="diff-header">
    <span>Diff</span>
    <span id="diff-header-file" class="diff-filename"></span>
  </div>
  <div id="diff-scroll">
    <div class="placeholder">Select a file to view its diff</div>
  </div>
</div>

<script>
(function () {
  "use strict";

  // ── State ────────────────────────────────────────────
  let selectedWorktree = null;
  let selectedFile     = null;
  let lastFilesJson    = "";  // cache to skip re-render when data unchanged

  // ── Helpers ──────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function escHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function badgeClass(status) {
    const map = { M:"M", A:"A", D:"D", R:"R", C:"C", U:"U", "?":"U", " ":"Q" };
    return "badge badge-" + (map[status] ?? "Q");
  }

  function badgeTitle(status) {
    const map = { M:"Modified", A:"Added", D:"Deleted", R:"Renamed", C:"Copied", U:"Unmerged", "?":"Untracked", " ":"Ignored" };
    return map[status] ?? status;
  }

  function badgeLabel(status) {
    const map = { M:"M", A:"A", D:"D", R:"R", C:"C", U:"U", "?":"U", " ":"I" };
    return map[status] ?? status;
  }

  function showSpinner(containerId) {
    el(containerId).innerHTML =
      '<div class="placeholder"><div class="spinner"></div></div>';
  }

  // ── API calls ────────────────────────────────────────
  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ── Worktrees ────────────────────────────────────────
  async function loadWorktrees() {
    const worktrees = await fetchJson("/api/worktrees");
    const chips = el("worktree-chips");
    chips.innerHTML = "";

    for (const wt of worktrees) {
      const chip = document.createElement("button");
      chip.className = "worktree-chip" + (wt.isMain ? " active" : "");
      chip.innerHTML =
        "<span>" + escHtml(wt.name) + "</span>" +
        "<span class='branch'>" + escHtml(wt.branch || "(detached)") + "</span>";
      chip.dataset.path = wt.path;
      chip.addEventListener("click", () => selectWorktree(wt));
      chips.appendChild(chip);

      if (wt.isMain && !selectedWorktree) {
        selectWorktree(wt);
      }
    }
  }

  function selectWorktree(wt) {
    selectedWorktree = wt;
    selectedFile = null;
    lastFilesJson = "";  // force re-render for new worktree

    // Update chip highlights
    document.querySelectorAll(".worktree-chip").forEach(c => {
      c.classList.toggle("active", c.dataset.path === wt.path);
    });

    loadFiles(wt.path, { force: true });
    el("diff-header-file").textContent = "";
    el("diff-scroll").innerHTML = '<div class="placeholder">Select a file to view its diff</div>';
  }

  // ── Files (tree view) ─────────────────────────────────────

  function buildTree(files) {
    const root = { name: "", type: "dir", children: new Map() };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, type: "dir", children: new Map() });
        }
        node = node.children.get(part);
      }
      const fname = parts[parts.length - 1];
      node.children.set(fname, { name: fname, type: "file", file: f });
    }
    return root;
  }

  // Compress single-child directory chains: a/ → b/ → c/ becomes "a/b/c/"
  // Only compresses dirs with exactly one child that is also a dir (no files).
  function compressTree(node) {
    if (node.type === "file") return node;
    const compressed = new Map();
    for (const child of node.children.values()) {
      const c = compressTree(child);
      compressed.set(c.name, c);
    }
    node.children = compressed;
    const kids = [...node.children.values()];
    if (kids.length === 1 && kids[0].type === "dir") {
      const only = kids[0];
      node.name = node.name ? node.name + "/" + only.name : only.name;
      node.children = only.children;
    }
    return node;
  }

  async function loadFiles(worktreePath, { force = false } = {}) {
    const files = await fetchJson("/api/worktree-status?path=" + encodeURIComponent(worktreePath));
    const json = JSON.stringify(files);
    if (!force && json === lastFilesJson) return;  // nothing changed — skip re-render
    lastFilesJson = json;
    const list = el("files-list");
    if (files.length === 0) {
      list.innerHTML = '<div class="placeholder" style="padding:24px 0"><span style="color:var(--text-muted);font-size:12px">No changes</span></div>';
      return;
    }
    const root = buildTree(files);
    compressTree(root);
    list.innerHTML = "";
    for (const child of root.children.values()) {
      renderTreeNode(child, list, 0);
    }
  }

  function renderTreeNode(node, container, depth) {
    const indent = depth * 14 + 6;
    if (node.type === "dir") {
      const row = document.createElement("div");
      row.className = "tree-dir";
      row.style.paddingLeft = indent + "px";

      const toggle = document.createElement("span");
      toggle.className = "tree-toggle open";
      toggle.textContent = "▶";

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = node.name + "/";
      name.title = node.name + "/";

      row.append(toggle, name);

      const childWrap = document.createElement("div");
      childWrap.className = "tree-children";
      for (const child of node.children.values()) {
        renderTreeNode(child, childWrap, depth + 1);
      }

      row.addEventListener("click", () => {
        const open = toggle.classList.toggle("open");
        childWrap.classList.toggle("collapsed", !open);
      });

      container.appendChild(row);
      container.appendChild(childWrap);
    } else {
      const f = node.file;
      const row = document.createElement("div");
      row.className = "tree-file";
      row.style.paddingLeft = indent + "px";
      row.dataset.file = f.path;

      const spacer = document.createElement("span");
      spacer.style.cssText = "width:12px;flex-shrink:0";

      const badge = document.createElement("span");
      badge.className = badgeClass(f.status);
      badge.textContent = badgeLabel(f.status);
      badge.title = badgeTitle(f.status);

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = node.name;
      name.title = f.path;

      row.append(spacer, badge, name);
      row.addEventListener("click", () => selectFile(f));
      container.appendChild(row);
    }
  }

  function selectFile(f) {
    selectedFile = f;
    document.querySelectorAll(".tree-file").forEach(r => {
      r.classList.toggle("active", r.dataset.file === f.path);
    });
    el("diff-header-file").textContent = f.path;
    loadDiff(selectedWorktree.path, f.path, f.status);
  }

  // ── Diff ──────────────────────────────────────────────
  async function loadDiff(worktreePath, filePath, status) {
    showSpinner("diff-scroll");
    const url =
      "/api/diff" +
      "?worktree=" + encodeURIComponent(worktreePath) +
      "&file=" + encodeURIComponent(filePath) +
      "&status=" + encodeURIComponent(status);
    const data = await fetchJson(url);

    if (!data.lines || data.lines.length === 0) {
      el("diff-scroll").innerHTML = '<div class="placeholder">No diff available</div>';
      return;
    }

    renderDiff(data.lines);
  }

  function renderDiff(lines) {
    const scroll = el("diff-scroll");

    const table = document.createElement("table");
    table.className = "diff-table";

    for (const line of lines) {
      const tr = document.createElement("tr");
      tr.className = line.type;

      if (line.type === "hunk") {
        const td = document.createElement("td");
        td.colSpan = 5;
        td.textContent = line.header || "";
        tr.appendChild(td);
        table.appendChild(tr);
        continue;
      }

      // left line number
      const lln = document.createElement("td");
      lln.className = "ln";
      lln.textContent = line.leftNum != null ? String(line.leftNum) : "";

      // left code
      const lcode = document.createElement("td");
      lcode.className = "code left-code";
      lcode.innerHTML = escHtml(line.left ?? "");

      // divider
      const div = document.createElement("td");
      div.className = "divider";

      // right line number
      const rln = document.createElement("td");
      rln.className = "ln";
      rln.textContent = line.rightNum != null ? String(line.rightNum) : "";

      // right code
      const rcode = document.createElement("td");
      rcode.className = "code right-code";
      rcode.innerHTML = escHtml(line.right ?? "");

      tr.append(lln, lcode, div, rln, rcode);
      table.appendChild(tr);
    }

    scroll.innerHTML = "";
    scroll.appendChild(table);
  }

  // ── Resizer ───────────────────────────────────────────
  (function initResizer() {
    const resizer = el("resizer");
    const MIN_WIDTH = 120;
    const MAX_WIDTH = 600;
    const STORAGE_KEY = "gwv-files-width";

    function applyWidth(px) {
      document.body.style.setProperty("--files-width", px + "px");
    }

    // Restore persisted width
    const saved = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    if (!isNaN(saved)) applyWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved)));

    resizer.addEventListener("mousedown", function (e) {
      e.preventDefault();
      resizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const startX = e.clientX;
      const startWidth = el("files").getBoundingClientRect().width;

      function onMove(e) {
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + e.clientX - startX));
        applyWidth(newWidth);
      }

      function onUp() {
        resizer.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        const finalWidth = el("files").getBoundingClientRect().width;
        localStorage.setItem(STORAGE_KEY, String(Math.round(finalWidth)));
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  })();

  // ── Boot ──────────────────────────────────────────────
  loadWorktrees().catch(err => {
    el("worktree-chips").innerHTML =
      '<span style="color:var(--removed-fg);font-size:12px">Error: ' + escHtml(String(err)) + "</span>";
  });

  // Live reload via SSE; refresh the active worktree's file list (and diff)
  // whenever the server pushes a "refresh" event.
  (function initSse() {
    function connect() {
      const es = new EventSource("/api/events");
      es.addEventListener("refresh", () => {
        if (selectedWorktree) loadFiles(selectedWorktree.path).catch(() => {});
      });
      es.onerror = () => {
        es.close();
        setTimeout(connect, 3000); // reconnect after 3s
      };
    }
    connect();
  })();
})();
</script>
</body>
</html>`;
}
