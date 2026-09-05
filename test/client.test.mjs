// Run: node test/client.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const src = readFileSync(fileURLToPath(new URL("../dist/dsh/client.js", import.meta.url)), "utf8");

// A fake localStorage is present for the whole run: Node 26 ships an experimental
// `localStorage` global that warns on first access, so override it up front (before
// any render touches it). In a real browser it's the native localStorage.
Object.defineProperty(globalThis, "localStorage", {
  value: (function () {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      clear: () => m.clear(),
    };
  })(),
  writable: true,
  configurable: true,
});

// 1) The factory's `require` is a param; the bundle is a classic script.
//    Compile it with fake window/require, throws SyntaxError if the body is bad.
const loaded = {};
const fakeReact = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useState: (i) => [typeof i === "function" ? i() : i, () => {}],
  useEffect: () => {},
  useRef: (i) => ({ current: i }),
  Fragment: "Fragment",
};
// The TSX build uses the automatic JSX runtime (react/jsx-runtime): the
// bundle calls jsx()/jsxs() with the children inside the props object.
// Emit the SAME {t, p, c} element shape the createElement fake produced, so
// every structural assertion below works unchanged.
const fakeJsxRuntime = {
  jsx: (t, p) => ({ t, p, c: p && p.children !== undefined ? (Array.isArray(p.children) ? p.children : [p.children]) : undefined }),
  jsxs: (t, p) => ({ t, p, c: p && p.children !== undefined ? (Array.isArray(p.children) ? p.children : [p.children]) : undefined }),
  Fragment: "Fragment",
};
const fakeRequire = (name) => {
  if (name === "react") return fakeReact;
  if (name === "react/jsx-runtime") return fakeJsxRuntime;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {}; // no icons → text fallback
  throw new Error("unexpected require: " + name);
};
new Function("window", "require", src)({ __ModuleLoader__: { load: (reg) => { loaded.reg = reg; } } }, fakeRequire);
assert.ok(loaded.reg && loaded.reg.id === "filestab", "bundle registered with id filestab");
assert.strictEqual(typeof loaded.reg.factory, "function", "factory is a function");

const mod = loaded.reg.factory(fakeRequire);
assert.strictEqual(mod.name, "filestab", "plugin name");
assert.deepStrictEqual(mod.inject, ["slots", "locale", "connection"], "service inject list");
assert.strictEqual(typeof mod.apply, "function", "apply present");

// 3) apply with a fake ctx: registers the tab, inject face wires rpc.call → unwrap.
let registered = null;
const ctx = {
  effect: (fn) => { try { fn(); } catch (e) { } },
  locale: { register: () => () => {}, bind: () => (k) => k },
  connection: {
    rpc: {
      call: (channel, endpoint, payload) => {
        assert.strictEqual(channel, "/filez-browse", "channel");
        if (endpoint === "diff") {
          assert.strictEqual(payload.sessionId, "sess-x", "diff: sessionId");
          assert.ok(typeof payload.relPath === "string", "diff: relPath");
          assert.ok(payload.base === "worktree" || payload.base === "commit", "diff: base whitelisted by the face caller");
          return Promise.resolve({ ok: true, value: { patch: "+x\n", truncated: false, base: payload.base } });
        }
        assert.strictEqual(endpoint, "list", "endpoint");
        return Promise.resolve({
          ok: true,
          value: { root: "/ws", relPath: payload.relPath, entries: [], truncated: false },
        });
      },
    },
  },
  slots: {
    inject: (slot, cb) => {
      assert.strictEqual(slot, "conversation.view", "slot");
      const r = cb();
      return typeof r === "function" ? r : () => {};
    },
    register: (opts, comp) => { registered = { opts, comp }; return () => {}; },
  },
};
mod.apply(ctx);
assert.ok(registered, "tab registered");
assert.strictEqual(registered.opts.id, "files", "tab id");
assert.strictEqual(registered.opts.order, 20, "tab order");
assert.strictEqual(typeof registered.opts.label, "function", "label is a function");
assert.strictEqual(typeof registered.comp, "function", "component is a function");

const face = registered.opts.inject("sess-x");
assert.ok(face.sessionId === "sess-x", "sessionId passed");
const listing = await face.listDirectory("sub");
assert.strictEqual(listing.relPath, "sub", "list relPath passed through");
assert.ok(Array.isArray(listing.entries), "list returns entries");
assert.strictEqual(typeof face.readFile, "undefined", "no readFile face method (file bytes come via the fileshow endpoint)");
const dres = await face.fetchDiff("sub/a.txt", "commit");
assert.ok(typeof dres.patch === "string" && dres.base === "commit", "fetchDiff unwraps the host diff value");

// 5) Render the component body with the fake React, catches reference/syntax
//    errors in the FilesView render path (two-pane body, rows, breadcrumb, footer).
const view = registered.comp({
  t: (k) => k,
  listDirectory: (p, s, h) => Promise.resolve({ root: "/ws", relPath: p, entries: [
    { name: "docs", path: "docs", isDirectory: true, hidden: false },
    { name: "a.txt", path: "a.txt", isDirectory: false, hidden: false, size: 11, mtime: Date.now() },
  ] }),
});
assert.ok(view && typeof view === "object", "FilesView renders an element (no throw)");
const H = mod.__test;
assert.ok(H && typeof H.renderMarkdown === "function", "markdown renderer exposed for test");
// BUG-008: the row meta is FILES ONLY — a stat'd file row gets size ·
// relative age; a directory row and a stat-less file (snapshot listing) get
// nothing. The row's title is the full detail (path — size — timestamp).
{
  const tag = (k) => ({ "files.ageNow": "now", "files.ageMin": "{n}m" })[k] || k;
  const m = H.fileRowMeta({ name: "a.txt", path: "a.txt", isDirectory: false, size: 11, mtime: Date.now() }, tag);
  assert.ok(m, "stat'd file row → meta");
  assert.strictEqual(m.label, "11 B · now", "meta label = size · relative age");
  assert.ok(/^a\.txt — 11 B — /.test(m.title), "row title = path — size — full timestamp: " + m.title);
  assert.strictEqual(H.fileRowMeta({ name: "docs", path: "docs", isDirectory: true, size: 4096, mtime: Date.now() }, tag), null, "directory row → no meta (scope: files only)");
  assert.strictEqual(H.fileRowMeta({ name: "a.txt", path: "a.txt", isDirectory: false }, tag), null, "stat-less file (snapshot listing) → no meta");
}
// renderMarkdown is markdown-it (html:false, linkify + fuzzyLink, breaks:false)
// plus the task-lists plugin; these pin its exact output for the invariants.
assert.strictEqual(H.renderMarkdown("# Hi\n\nA **bold** para."), "<h1>Hi</h1>\n<p>A <strong>bold</strong> para.</p>\n", "md: heading + bold");
assert.strictEqual(H.renderMarkdown("- one\n- two"), "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n", "md: unordered list");
assert.ok(H.renderMarkdown("> a quote").includes("<blockquote>"), "md: blockquote");
assert.strictEqual(H.renderMarkdown("```js\ncode()\n```"), "<pre><code class=\"language-js\"><span class=\"hljs-title function_\">code</span>()\n</code></pre>\n", "md: fenced code, highlighted");
assert.ok(H.renderMarkdown("```js\nfunction double(x) {\n  return x * 2; // a comment\n}\n```").includes('<span class="hljs-keyword">function</span>'), "md: tagged fence gets token spans");
assert.strictEqual(H.renderMarkdown("```\nplain fenced line one\nplain fenced line two\n```"), "<pre><code>plain fenced line one\nplain fenced line two\n</code></pre>\n", "md: untagged fence stays plain (auto-detect below threshold)");
assert.ok(H.renderMarkdown("```python\ndef double(x):\n    return x * 2\n```").includes('<span class="hljs-keyword">def</span>'), "md: python fence highlighted");
assert.ok(H.renderMarkdown("plain <script>x</script> text").includes("&lt;script&gt;"), "md: raw html escaped (html:false, safe by construction)");
assert.ok(!H.renderMarkdown("[x](javascript:alert(1))").includes("<a "), "md: javascript: link dropped");
assert.ok(H.renderMarkdown("[x](https://a.b)").includes('<a href="https://a.b" target="_blank" rel="noopener noreferrer">'), "md: safe link kept, opens in a new tab (BUG-012: a bare <a> click would navigate the dsh session's tab)");
assert.strictEqual(H.renderMarkdown("line one\nline two"), "<p>line one\nline two</p>\n", "md: soft break stays a soft break (GitHub file-view behavior, renders as space)");
assert.strictEqual(H.renderMarkdown("line one  \nline two"), "<p>line one<br>\nline two</p>\n", "md: hard break (two trailing spaces) -> <br>");
assert.strictEqual(H.renderMarkdown("line one\\\nline two"), "<p>line one<br>\nline two</p>\n", "md: hard break (backslash) -> <br>");
assert.strictEqual(H.renderMarkdown("| A | B |\n|---|---:|\n| 1 | 2 |"), "<table>\n<thead>\n<tr>\n<th>A</th>\n<th style=\"text-align:right\">B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td style=\"text-align:right\">2</td>\n</tr>\n</tbody>\n</table>\n", "md: gfm table + right alignment");
assert.strictEqual(H.renderMarkdown("| Pipe |\n|------|\n| a \\| b \\| c |"), "<table>\n<thead>\n<tr>\n<th>Pipe</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>a | b | c</td>\n</tr>\n</tbody>\n</table>\n", "md: one-column table, escaped pipes become literal");
assert.ok(H.renderMarkdown("| L | C | R |\n|:--|:-:|--:|\n| `x` | **b** | [t](https://e.com) |").includes('<td style="text-align:center"><strong>b</strong></td>\n<td style="text-align:right"><a href="https://e.com" target="_blank" rel="noopener noreferrer">t</a></td>'), "md: inline markdown in table cells");
assert.strictEqual(H.renderMarkdown("Setext level 2\n-------------"), "<h2>Setext level 2</h2>\n", "md: setext heading (pipe-less line is not a table)");
assert.ok(H.renderMarkdown("| A |\n|---|\n| 1 |\n\ntail para").includes("</table>\n<p>tail para</p>"), "md: blank line ends the table");
assert.ok(H.renderMarkdown("| A |\n|---|\n| 1 |\nplain continuation").includes("<td>plain continuation</td>"), "md: pipe-less line continues the table as a one-cell row");
assert.strictEqual(H.renderMarkdown("- [x] done\n- [ ] todo"), "<ul class=\"contains-task-list\">\n<li class=\"task-list-item\"><input class=\"task-list-item-checkbox\" checked=\"\" disabled=\"\" type=\"checkbox\"> done</li>\n<li class=\"task-list-item\"><input class=\"task-list-item-checkbox\" disabled=\"\" type=\"checkbox\"> todo</li>\n</ul>\n", "md: gfm task list (disabled checkboxes)");
assert.strictEqual(H.renderMarkdown("a ~~strike~~ b"), "<p>a <s>strike</s> b</p>\n", "md: strikethrough");
assert.strictEqual(H.renderMarkdown("Title\n==="), "<h1>Title</h1>\n", "md: setext h1");
assert.ok(H.renderMarkdown("9. first\n10. second").includes('<ol start="9">'), "md: ordered list start number");
assert.ok(H.renderMarkdown("    code()").includes("<pre><code>code()"), "md: indented code block");
assert.ok(H.renderMarkdown("[ref][1]\n\n[1]: https://x.dev").includes('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">ref</a>'), "md: reference link resolved, new tab");
assert.ok(H.renderMarkdown("see https://example.com now").includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'), "md: autolink (scheme), new tab");
assert.ok(H.renderMarkdown("GFM www form: www.example.com/plain").includes('<a href="http://www.example.com/plain" target="_blank" rel="noopener noreferrer">www.example.com/plain</a>'), "md: autolink (www form, fuzzyLink), new tab");
assert.ok(H.renderMarkdown("- a\n  - b\n- c").includes("<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>"), "md: nested list");
assert.strictEqual(H.renderMarkdown("\\*not italic\\*"), "<p>*not italic*</p>\n", "md: backslash escape");
assert.strictEqual(H.renderMarkdown("- - -"), "<hr>\n", "md: spaced dashes hr");
assert.strictEqual(H.formatBytes(512), "512 B", "bytes: B");
assert.strictEqual(H.formatBytes(2048), "2 KB", "bytes: KB");
assert.strictEqual(H.formatBytes(5 * 1024 * 1024), "5 MB", "bytes: MB");
assert.strictEqual(H.formatBytes(1536), "1.5 KB", "bytes: fractional KB");

// 7) Per-session view-state persistence (localStorage, installed at the top),
//    the building blocks for "a refresh restores the directory + selection".
const rootSeg = { name: "view.files", path: "" };
assert.deepStrictEqual(H.segmentsForPath(rootSeg, "").map((s) => s.path), [""], "segmentsForPath: empty → root only");
assert.deepStrictEqual(H.segmentsForPath(rootSeg, "a/b").map((s) => s.path), ["", "a", "a/b"], "segmentsForPath: path → chain");
assert.deepStrictEqual(H.segmentsForPath(rootSeg, "a/b/").map((s) => s.path), ["", "a", "a/b"], "segmentsForPath: trailing slash trimmed");
H.saveState("sess-p", "docs/sub", "docs/sub/note.md", 432);
const round = H.loadState("sess-p");
assert.strictEqual(round.path, "docs/sub", "loadState: restored path");
assert.strictEqual(round.selected, "docs/sub/note.md", "loadState: restored selection");
assert.strictEqual(round.leftW, 432, "loadState: restored divider width");
assert.strictEqual(H.loadState("sess-other"), null, "loadState: other session → null");
H.saveState("sess-p", "", null);
assert.strictEqual(H.loadState("sess-p").selected, null, "loadState: cleared selection → null");
assert.strictEqual(H.loadState("sess-p").leftW, null, "saveState without a width stores null (CSS default)");
// Render with a real sessionId + storage present, loadState runs in the state
// initializer, so this catches a throw in the restore path.
const view2 = registered.comp({ t: (k) => k, sessionId: "sess-p", listDirectory: (p) => Promise.resolve({ root: "/ws", relPath: p, entries: [] }) });
assert.ok(view2 && typeof view2 === "object", "FilesView renders with a sessionId (restore path, no throw)");
// A corrupt saved blob must not throw, loadState swallows the parse error.
globalThis.localStorage.setItem("filestab/files/sess-bad", "{not json");
const view3 = registered.comp({ t: (k) => k, sessionId: "sess-bad", listDirectory: (p) => Promise.resolve({ root: "/ws", relPath: p, entries: [] }) });
assert.ok(view3 && typeof view3 === "object", "FilesView renders over a corrupt saved state (no throw)");
// The divider's width lives in the --filez-left CSS var on the body element,
// not React state, no state churn during the drag.
const findDivider = (function find(node, out) {
  if (out === undefined) out = [];
  if (Array.isArray(node)) { for (const ch of node) find(ch, out); return out; }
  if (!node || typeof node !== "object") return out;
  if (node.p && node.p.className === "dswFiles_divider") out.push(node);
  if (node.c) find(node.c, out);
  return out;
})(view2);
assert.strictEqual(findDivider.length, 1, "FilesView renders one divider");
assert.strictEqual(findDivider[0].p.role, "separator", "divider: role=separator");
assert.strictEqual(typeof findDivider[0].p.onPointerDown, "function", "divider: draggable (onPointerDown)");
assert.strictEqual(typeof findDivider[0].p.onDoubleClick, "function", "divider: double-click reset");
// BUG-011: the collapsed-state cue at the pane edge — a restored collapsed
// session renders the accent rail (the "thickened divider") and the browse
// pane + divider unmount; the expanded view has no rail.
const findCls = (node, cls) => (function find(node, out) {
  if (out === undefined) out = [];
  if (Array.isArray(node)) { for (const ch of node) find(ch, out); return out; }
  if (!node || typeof node !== "object") return out;
  if (typeof node.p?.className === "string" && node.p.className.split(" ").includes(cls)) out.push(node);
  if (node.c) find(node.c, out);
  return out;
})(node);
globalThis.localStorage.setItem("filestab/files/sess-collapsed", JSON.stringify({ path: "", selected: null, leftW: null, rev: null, collapsed: true }));
const viewCollapsed = registered.comp({ t: (k) => k, sessionId: "sess-collapsed", listDirectory: (p) => Promise.resolve({ root: "/ws", relPath: p, entries: [] }) });
const rail = findCls(viewCollapsed, "dswFiles_collapsedRail");
assert.strictEqual(rail.length, 1, "collapsed: the pane-edge rail renders");
assert.strictEqual(rail[0].p.role, "button", "rail: role=button");
assert.strictEqual(rail[0].p["aria-label"], "files.expandNav", "rail: labeled as the expand action");
assert.strictEqual(typeof rail[0].p.onClick, "function", "rail: clickable (expands)");
assert.strictEqual(typeof rail[0].p.onKeyDown, "function", "rail: keyboard (Enter/Space)");
assert.strictEqual(findCls(rail[0], "dswFiles_railGlyph").length, 1, "rail: carries the pane glyph (the JetBrains-stripe idiom, not a bare color)");
assert.strictEqual(findCls(viewCollapsed, "dswFiles_divider").length, 0, "collapsed: the divider unmounts");
assert.strictEqual(findCls(view2, "dswFiles_collapsedRail").length, 0, "expanded: no rail");
assert.strictEqual(findCls(viewCollapsed, "dswFiles_collapseBtn").length, 0, "collapsed: the header button unmounts (one affordance per state — no double icon)");
assert.strictEqual(findCls(view2, "dswFiles_collapseBtn").length, 1, "expanded: the header button renders");
delete globalThis.localStorage;

// 8) Unified-diff parser (M2), table tests against the golden fixtures, which
//    are captured VERBATIM from jj 0.44's `jj diff --git` output.
const D = mod.__test;
const fx = (name) => readFileSync(fileURLToPath(new URL("./fixtures/diffs/" + name, import.meta.url)), "utf8");

{ const f = D.parseDiff(fx("modify.txt")).files[0];
  assert.strictEqual(f.oldPath, "mod.txt", "modify: old path from diff --git");
  assert.strictEqual(f.newPath, "mod.txt", "modify: new path from diff --git");
  assert.strictEqual(f.hunks.length, 1, "modify: one hunk");
  assert.deepStrictEqual(f.hunks[0].rows.map((r) => [r.k, r.oldNo, r.newNo]),
    [["ctx", 1, 1], ["del", 2, null], ["add", null, 2], ["ctx", 3, 3], ["ctx", 4, 4]],
    "modify: row kinds + numbers follow the real lines"); }

{ const f = D.parseDiff(fx("modify-multi.txt")).files[0];
  assert.strictEqual(f.hunks.length, 2, "modify-multi: two hunks");
  assert.strictEqual(f.hunks[0].rows.length, 8, "modify-multi: hunk 1 has all 8 rows (3ctx + del + add + 3ctx; the @@ ,7 is per-side)");
  assert.deepStrictEqual(D.gapAfter(f.hunks[0], f.hunks[1]), { old: [9, 31], new: [9, 31] },
    "modify-multi: gap between hunks computed from @@ headers alone"); }

{ const f = D.parseDiff(fx("add.txt")).files[0];
  assert.ok(f.isNew, "add: new-file flag");
  assert.strictEqual(f.oldPath, "/dev/null", "add: /dev/null old side");
  assert.strictEqual(f.hunks[0].oldStart, 0, "add: old side anchored at 0");
  assert.ok(f.hunks[0].rows.every((r) => r.k === "add") && f.hunks[0].rows.length === 2, "add: all rows are adds"); }

{ const f = D.parseDiff(fx("delete.txt")).files[0];
  assert.ok(f.isDeleted, "delete: deleted flag");
  assert.strictEqual(f.newPath, "/dev/null", "delete: /dev/null new side");
  assert.strictEqual(f.hunks[0].rows[0].k, "del", "delete: single del row"); }

{ const f = D.parseDiff(fx("rename.txt")).files[0];
  assert.strictEqual(f.renameFrom, "ren.txt", "rename: rename from");
  assert.strictEqual(f.renameTo, "renamed.txt", "rename: rename to");
  assert.strictEqual(f.hunks.length, 0, "rename: pure rename has no hunks"); }

{ const f = D.parseDiff(fx("rename-modified.txt")).files[0];
  assert.strictEqual(f.renameFrom, "big.txt", "rename+mod: rename headers");
  assert.strictEqual(f.renameTo, "big-renamed.txt", "rename+mod: rename to");
  assert.strictEqual(f.hunks.length, 1, "rename+mod: rename headers AND hunks");
  assert.deepStrictEqual(D.displayRows(f.hunks[0]).map((d) => d.type),
    ["ctx", "ctx", "ctx", "mod", "ctx", "ctx", "ctx"], "rename+mod: the changed line pairs into one mod row"); }

// C3: real-path identity. Deleted files carry the /dev/null placeholder in
// newPath (new files in oldPath), identity/display must resolve to the REAL
// path, or every deleted file collides (scroll-reset key) and the header
// prints "/dev/null" as the name.
{
  const base = { isNew: false, isDeleted: false, isBinary: false, modeFrom: null, modeTo: null, renameFrom: null, renameTo: null, hunks: [] };
  assert.strictEqual(D.realPathOf({ ...base, oldPath: "/dev/null", newPath: "brand.txt" }), "brand.txt", "new file → the real newPath");
  assert.strictEqual(D.realPathOf({ ...base, oldPath: "gone.txt", newPath: "/dev/null" }), "gone.txt", "deleted file → the real oldPath");
  assert.strictEqual(D.realPathOf({ ...base, oldPath: "same.txt", newPath: "same.txt" }), "same.txt", "modified → either side");
  const del = D.parseDiff(fx("delete.txt")).files[0];
  assert.strictEqual(D.realPathOf(del), del.oldPath, "a parsed deleted file resolves to its real path");
  assert.notStrictEqual(D.realPathOf(del), "/dev/null", "never the placeholder");
}

{ const f = D.parseDiff(fx("binary.txt")).files[0];
  assert.ok(f.isBinary, "binary: notice detected");
  assert.strictEqual(f.hunks.length, 0, "binary: no hunks"); }

{ const f = D.parseDiff(fx("chmod.txt")).files[0];
  assert.strictEqual(f.modeFrom, "100644", "chmod: old mode");
  assert.strictEqual(f.modeTo, "100755", "chmod: new mode");
  assert.strictEqual(f.hunks.length, 0, "chmod: mode-only, no hunks"); }

{ const rows = D.parseDiff(fx("no-newline.txt")).files[0].hunks[0].rows;
  assert.strictEqual(rows.length, 2, "no-newline: two rows (the \\ lines are markers, not rows)");
  assert.ok(rows[0].noNewline && rows[1].noNewline, "no-newline: marker attributed to each side"); }

{ const rows = D.parseDiff(fx("crlf.txt")).files[0].hunks[0].rows;
  assert.ok(rows[2].text.endsWith("\r"), "crlf: \\r kept on the add line (white-space:pre renders it)"); }

{ const f = D.parseDiff(fx("spaces.txt")).files[0];
  assert.strictEqual(f.newPath, "di r/sp aced.txt", "spaces: path with spaces survives the header regex"); }

{ assert.deepStrictEqual(D.parseDiff(fx("empty.txt")).files, [], "empty patch → no files"); }

// Truncation: cut the real multi-hunk patch mid-hunk (host 1 MB cap
// simulation). The parser must stay in sync, numbers follow the lines that
// are actually present, never the (now lying) hunk counts.
{ const full = fx("modify-multi.txt").split("\n");
  const idx = full.findIndex((l) => l.indexOf("@@ -32") === 0);
  const cut = full.slice(0, idx + 4).join("\n"); // hunk 2 header + only 3 of its 7 lines
  const f = D.parseDiff(cut).files[0];
  assert.strictEqual(f.hunks.length, 2, "truncated: the second @@ header still parses");
  assert.deepStrictEqual(f.hunks[1].rows.map((r) => [r.k, r.oldNo]),
    [["ctx", 32], ["ctx", 33], ["ctx", 34]], "truncated: numbers follow present lines, not hunk counts"); }

// A deleted line whose TEXT starts with `-- ` must stay a del row, the
// `--- `/`+++ ` header check is only valid before the first hunk of a section.
{ const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n---- a/fake\n+keep\n";
  const rows = D.parseDiff(patch).files[0].hunks[0].rows;
  assert.strictEqual(rows.length, 2, "content guard: two rows");
  assert.strictEqual(rows[0].k, "del", "content guard: `---- …` is a del row");
  assert.strictEqual(rows[0].text, "--- a/fake", "content guard: text kept verbatim"); }

// Hunk counts are never trusted, even when they disagree with the rows.
{ const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,9 @@\n ctx\n-x\n+y\n+z\n";
  const rows = D.parseDiff(patch).files[0].hunks[0].rows;
  assert.deepStrictEqual(rows.map((r) => [r.k, r.oldNo, r.newNo]),
    [["ctx", 1, 1], ["del", 2, null], ["add", null, 2], ["add", null, 3]],
    "hunk counts ignored; numbers follow the real lines"); }

// Gap math at the edges: zero-count hunks anchor at a phantom line 0 → the
// clamp keeps the range on real lines.
{ const h1 = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 };
  const h2 = { oldStart: 5, oldCount: 1, newStart: 10, newCount: 1 };
  assert.deepStrictEqual(D.gapAfter(h1, h2), { old: [1, 4], new: [3, 9] }, "gap: zero-count hunk anchors");
  assert.strictEqual(D.gapAfter(h1, h1), null, "gap: null when nothing is between"); }

// Mod pairing: order-pair the contiguous del run with the following add run;
// the surplus keeps its row with a blank opposite cell.
{ const mk = (k, n, t2) => ({ k, text: t2, oldNo: k === "add" ? null : n, newNo: k === "del" ? null : n, noNewline: false });
  assert.deepStrictEqual(D.displayRows({ rows: [mk("del", 1, "a"), mk("del", 2, "b"), mk("add", 1, "x")] }).map((d) => d.type),
    ["mod", "del"], "pairing: -a -b +c → one mod, surplus del kept");
  assert.deepStrictEqual(D.displayRows({ rows: [mk("del", 1, "a"), mk("add", 1, "x"), mk("add", 2, "y")] }).map((d) => d.type),
    ["mod", "add"], "pairing: surplus add kept");
  assert.deepStrictEqual(D.displayRows({ rows: [mk("del", 1, "a"), mk("ctx", 2, "b"), mk("add", 2, "c")] }).map((d) => d.type),
    ["del", "ctx", "add"], "pairing: a ctx line breaks the block (no cross-ctx pairing)");
  assert.deepStrictEqual(D.displayRows({ rows: [mk("add", 1, "x"), mk("add", 2, "y")] }).map((d) => d.type),
    ["add", "add"], "pairing: an add run alone stays adds"); }

// Intra-line diff (BUG-003, reworked per BUG-010 after checking the
// established renderers — git xdiff word-diff, diff-highlight, jsdiff
// diffWords): the alignment runs over NON-WHITESPACE tokens only, a maximal
// run of consecutive changed tokens is ONE contiguous span whose text is
// the original line verbatim (internal whitespace highlighted with it,
// boundary whitespace stays context), and a whitespace-only change gets no
// span at all. Identical lines, oversized pairs and dissimilar pairs skip.
{ const d = D.intraLineDiff("const x = 1;", "const x = 2;");
  assert.deepStrictEqual(d.old.map((s) => [s.cls, s.text]),
    [["same", "const x = "], ["del", "1"], ["same", ";"]], "intra: old side flags only the changed word");
  assert.deepStrictEqual(d.nw.map((s) => [s.cls, s.text]),
    [["same", "const x = "], ["add", "2"], ["same", ";"]], "intra: new side flags only the changed word"); }
{ assert.strictEqual(D.intraLineDiff("same line", "same line"), null, "intra: identical lines → null (row stays untouched)"); }
{ assert.strictEqual(D.intraLineDiff("a b".repeat(250), "c d".repeat(250)), null, "intra: token table above the cap → null (row tint only)"); }
// Similarity gate (BUG-004): word spans only help when the two line
// versions are genuinely similar. A rewrite (few shared tokens) falls back
// to the plain row tint instead of churning del/add fragments.
{ assert.strictEqual(D.intraLineDiff("beta", "BETA changed"), null, "intra: no shared tokens → null (row tint only, BUG-004)"); }
{ assert.strictEqual(D.intraLineDiff("alpha beta gamma delta", "omega gamma theta zeta"), null, "intra: < 50% of the shorter line shared → null (BUG-004)"); }
// An indent change on an otherwise-similar line rides the first same
// segment (boundary whitespace is context, as in git's rendering).
{ const d = D.intraLineDiff("if (a) doX();", "  if (a) doY();");
  assert.deepStrictEqual(d.old.map((s) => [s.cls, s.text]),
    [["same", "if (a) "], ["del", "doX"], ["same", "();"]], "intra: old side flags only the changed word");
  assert.deepStrictEqual(d.nw.map((s) => [s.cls, s.text]),
    [["same", "  if (a) "], ["add", "doY"], ["same", "();"]], "intra: the indent change stays in the context segment"); }
// Whitespace-ONLY change (no word token differs): no span at all — git's
// xdiff word-diff shows no marker for it either (BUG-010 research).
{ assert.strictEqual(D.intraLineDiff("a b", "a  b"), null, "intra: a pure spacing change → no spans (row tint only)"); }
// The changed PHRASE is one contiguous span: the whitespace between changed
// tokens is part of the span, the boundary whitespace is not.
{ const d = D.intraLineDiff("one two", "one two three four");
  assert.deepStrictEqual(d.old.map((s) => [s.cls, s.text]),
    [["same", "one two"]], "intra: old side untouched");
  assert.deepStrictEqual(d.nw.map((s) => [s.cls, s.text]),
    [["same", "one two "], ["add", "three four"]], "intra: the inserted phrase is one span, inner space included, no trailing space"); }
// The owner's real pair from BUG-010 (print-md): the inserted `-rotate 90`
// phrase must not fragment into word islands with plain spaces between.
{ const d = D.intraLineDiff(
    "        -gravity center -background white -extent 3300x2550 \\",
    "        -rotate 90 -gravity center -background white -extent 2550x3300 \\");
  assert.deepStrictEqual(d.old.map((s) => [s.cls, s.text]),
    [["same", "        -gravity center -background white -extent "], ["del", "3300x2550"], ["same", " \\"]], "intra(010): old side flags only the dimension");
  const adds = d.nw.filter((s) => s.cls === "add").map((s) => s.text);
  assert.ok(adds.some((t) => /-?rotate 90/.test(t) && t.length > "rotate 90".length),
    "intra(010): the new side's insertion is ONE span that keeps its inner space: " + JSON.stringify(adds));
  assert.ok(adds.some((t) => t === "2550x3300"), "intra(010): the dimension swap is its own span");
  assert.strictEqual(d.nw.filter((s) => s.cls === "add").length, 2, "intra(010): exactly two spans on the new side (no word islands)"); }
{ const addRow = { k: "add", text: "const x = 2;", oldNo: null, newNo: 2, noNewline: false };
  const delRow = { k: "del", text: "const x = 1;", oldNo: 2, newNo: null, noNewline: false };
  const cells = D.unifiedCells(delRow, 0, { other: addRow, side: "old" });
  const inner = cells[1].c[0];
  const spans = (function w(n, out) {
    if (Array.isArray(n)) { for (const x of n) w(x, out); return out; }
    if (!n || typeof n !== "object") return out;
    if (n.t === "span" && n.p.className === "dswFiles_spanDel") out.push(n);
    else if (n.c) w(n.c, out);
    return out;
  })(inner, []);
  assert.strictEqual(spans.length, 1, "unified: a paired del row carries one spanDel");
  assert.strictEqual(spans[0].c[0], "1", "unified: spanDel carries the old text");
  const plain = D.unifiedCells(addRow, 0);
  const plainContent = plain[1].c[0].c[0]; // the content array [markerEl, ...intra segs...]
  assert.strictEqual(plainContent[0].p.className, "dswFiles_diffMark", "unified: the marker is its own span (the context menu excludes it from the snippet)");
  assert.strictEqual(String(plainContent[0].c[0]), "+", "unified: the marker span carries the + glyph");
  assert.strictEqual(plainContent[1], "const x = 2;", "unpaired add row stays plain text (no intra spans)"); }

// 9) Status-line aggregate (M3): letter counts over the S1∪S2 merged set +
//    the conflict count; "no changes" only when both are empty; non-jj → ""
//    (the status line is hidden entirely).
{ const t = (k) => k;
  const base = { ok: true, head: { id: "abcdef123456", description: "step2", marker: "@" } };
  // t is the identity function here, so the expected strings carry the KEY names.
  assert.strictEqual(D.statusAggregate(Object.assign({}, base, { changes: [{ status: "A" }, { status: "M" }, { status: "M" }, { status: "D" }, { status: "C" }], conflicts: ["a", "b"] }), t),
    "A1 M2 D1 C1 · 2 files.conflicts", "aggregate: letter counts + conflicts");
  assert.strictEqual(D.statusAggregate(Object.assign({}, base, { changes: [], conflicts: ["a"] }), t),
    "1 files.conflict", "aggregate: singular conflict");
  assert.strictEqual(D.statusAggregate(Object.assign({}, base, { changes: [{ status: "M" }], conflicts: [] }), t),
    "M1", "aggregate: letters only");
  assert.strictEqual(D.statusAggregate(Object.assign({}, base, { changes: [], conflicts: [] }), t),
    "files.noChanges", "aggregate: empty → no changes");
  assert.strictEqual(D.statusAggregate(null, t), "", "aggregate: no jj info → hidden");
  assert.strictEqual(D.statusAggregate({ ok: false, code: "not-a-workspace" }, t), "", "aggregate: jj.ok=false → hidden"); }

// 9a) jj dropdown row label: mirrors jj's OWN rendering (jj log / jj status),
//     the (empty) marker for a no-diff commit, (no description set) when the
//     description is missing. Identity t → the expected strings carry KEY names.
{ const t = (k) => k;
  assert.strictEqual(D.jjRowLabel("abcdef123456", { empty: false, description: "step2" }, t),
    "abcdef123456 step2", "jj label: id + description");
  assert.strictEqual(D.jjRowLabel("abcdef123456", { empty: true, description: "" }, t),
    "abcdef123456 files.emptyCommit files.noDescription", "jj label: both placeholders");
  assert.strictEqual(D.jjRowLabel("abcdef123456", { empty: true, description: "wip" }, t),
    "abcdef123456 files.emptyCommit wip", "jj label: (empty) + description");
  assert.strictEqual(D.jjRowLabel("abcdef123456", { empty: false, description: "" }, t),
    "abcdef123456 files.noDescription", "jj label: no description only");
  assert.strictEqual(D.jjRowLabel("", { empty: true, description: "" }, t),
    "… files.emptyCommit files.noDescription", "jj label: missing id → …"); }

// 9b) Folder rollup (M3): the count pill for directories that contain changes,
//     nested prefix matching, conflict counting, label cap, pill element.
{ const t = (k) => k;
  const jj = { ok: true,
    changes: [ { path: "lib/a.js", status: "A" }, { path: "lib/sub/b.js", status: "M" },
               { path: "lib/q.js", status: "C" }, { path: "top.txt", status: "D" } ],
    conflicts: [ "lib/q.js" ] };
  const lib = D.rollupFor(jj, "lib");
  assert.strictEqual(lib.count, 3, "rollup: counts nested changes (lib/ + lib/sub/)");
  assert.strictEqual(lib.conflictCount, 1, "rollup: conflict under lib/");
  assert.strictEqual(D.rollupFor(jj, "lib/sub").count, 1, "rollup: deeper dir");
  assert.strictEqual(D.rollupFor(jj, "top").count, 0, "rollup: no prefix match");
  assert.strictEqual(D.rollupFor(jj, "").count, 4, "rollup: root counts everything");
  assert.deepStrictEqual(D.rollupFor(null, "lib"), { count: 0, conflictCount: 0, changes: [], conflicts: [] }, "rollup: non-jj → zeros");
  assert.deepStrictEqual(D.rollupFor({ ok: false, code: "jj-missing" }, "lib"), { count: 0, conflictCount: 0, changes: [], conflicts: [] }, "rollup: jj.ok=false → zeros");
  assert.strictEqual(D.rollupLabel(3), "3", "rollup label: plain");
  assert.strictEqual(D.rollupLabel(99), "99", "rollup label: cap boundary");
  assert.strictEqual(D.rollupLabel(150), "99+", "rollup label: capped");
  const slot = D.rollupSlot(lib, t);
  assert.ok(slot, "rollup slot: changed folder → pill");
  assert.ok(slot.p.className.includes("dswFiles_rollupPill"), "rollup slot: pill class");
  assert.ok(slot.p.className.includes("dswFiles_rollupPillConflict"), "rollup slot: conflict-tinted");
  assert.strictEqual(slot.c[0], "3", "rollup slot: count text");
  assert.strictEqual(slot.p.title, "A1 M1 C1 · 1 files.conflict", "rollup slot: tooltip = letter aggregate");
  assert.strictEqual(D.rollupSlot(D.rollupFor(jj, "top"), t), null, "rollup slot: unchanged folder → null");
  assert.strictEqual(D.rollupSlot(null, t), null, "rollup slot: no jj → null");
  const clean = D.rollupSlot(D.rollupFor({ ok: true, changes: [ { path: "x/y.txt", status: "M" } ], conflicts: [] }, "x"), t);
  assert.ok(!clean.p.className.includes("Conflict"), "rollup slot: no conflict tint when clean"); }

// 10) DiffView render smoke (fake React: effects are no-ops → the side-by-side
//    path with narrow=false, and the binary-card path).
{ const t = (k) => k;
  const el = D.DiffView({ model: D.parseDiff(fx("modify-multi.txt")).files[0], truncated: false, t });
  assert.ok(el && typeof el === "object", "DiffView renders a multi-hunk file (no throw)");
  const el2 = D.DiffView({ model: D.parseDiff(fx("binary.txt")).files[0], truncated: false, t });
  assert.ok(el2 && typeof el2 === "object", "DiffView renders the binary card (no throw)");
  const el3 = D.DiffView({ model: D.parseDiff(fx("chmod.txt")).files[0], truncated: true, t });
  assert.ok(el3 && typeof el3 === "object", "DiffView renders a mode-only diff (no throw)");
  // The binary IMAGE path: the host's `binary` field (fileShow bytes at the
  // rev / parent) renders old|new; an absent side gets a "(none)" slot; no
  // bytes at all → the plain card (no hint, there is no open-in-window
  // affordance; the only preview surface is the in-pane data URL).
  const findClass = (function find(node, cls, out) {
    if (out === undefined) out = [];
    if (Array.isArray(node)) { for (const ch of node) find(ch, cls, out); return out; }
    if (!node || typeof node !== "object") return out;
    if (typeof node.p?.className === "string" && node.p.className.split(" ").includes(cls)) out.push(node);
    if (node.c) find(node.c, cls, out);
    return out;
  });
  const binModel = D.parseDiff(fx("binary.txt")).files[0];
  assert.ok(binModel.isBinary, "binary fixture parses isBinary");
  { const el4 = D.DiffView({ model: binModel, truncated: false, t,
      binary: { new: { kind: "binary", size: 42, type: "image/png", label: "PNG image", data: "AAAA" }, old: null } });
    assert.strictEqual(findClass(el4, "dswFiles_diffBinaryRow").length, 1, "binary image: one old|new row");
    assert.strictEqual(findClass(el4, "dswFiles_diffBinaryPane").length, 2, "binary image: two panes (old, new)");
    assert.strictEqual(findClass(el4, "dswFiles_diffBinaryNone").length, 1, "binary image: absent (old) side → (none) slot");
    const imgs = findClass(el4, "img").length;
    const all = []; (function w(n) { if (Array.isArray(n)) n.forEach(w); else if (n && n.t === "img") all.push(n); else if (n && n.c) w(n.c); })(el4);
    assert.strictEqual(all.length, 1, "binary image: exactly one img (the side with bytes)");
    assert.strictEqual(all[0].p.src, "data:image/png;base64,AAAA", "binary image: img src = the bytes as a data URL"); }
  { const el5 = D.DiffView({ model: binModel, truncated: false, t,
      binary: { new: { kind: "binary", size: 999999, type: "image/png", label: "PNG image" }, old: null } });
    assert.strictEqual(findClass(el5, "dswFiles_diffBinaryRow").length, 0, "no displayable bytes → no image row");
    assert.strictEqual(findClass(el5, "dswFiles_previewCard").length, 1, "no displayable bytes → the plain card");
    assert.strictEqual(findClass(el5, "dswFiles_previewCardHint").length, 0, "no open-in-window hint on the binary card"); }
  { const el6 = D.DiffView({ model: binModel, truncated: false, t,
      binary: { new: { kind: "binary", size: 42, type: "image/png", label: "PNG image" }, old: null } });
    assert.strictEqual(findClass(el6, "dswFiles_previewCardHint").length, 0, "no open-in-window hint (any mode)"); }
  // A binary rename: jj emits the rename lines with NO "Binary files" marker
  // (isBinary stays false), but the host still attaches the bytes, so the
  // old|new row must render. A rename patch WITHOUT bytes keeps the text path.
  { const rnModel = D.parseDiff(fx("rename.txt")).files[0];
    assert.strictEqual(rnModel.isBinary, false, "rename fixture has no binary marker");
    const el8 = D.DiffView({ model: rnModel, truncated: false, t,
      binary: { new: { kind: "binary", size: 42, type: "image/png", label: "PNG image", data: "BB" },
                old: { kind: "binary", size: 42, type: "image/png", label: "PNG image", data: "AA" } } });
    assert.strictEqual(findClass(el8, "dswFiles_diffBinaryRow").length, 1, "renamed binary: old|new row renders despite isBinary=false");
    assert.strictEqual(findClass(el8, "dswFiles_diffBinaryPane").length, 2, "renamed binary: two panes");
    const imgs8 = []; (function w(n) { if (Array.isArray(n)) n.forEach(w); else if (n && n.t === "img") imgs8.push(n); else if (n && n.c) w(n.c); })(el8);
    assert.deepStrictEqual(imgs8.map((i) => i.p.src), ["data:image/png;base64,AA", "data:image/png;base64,BB"], "renamed binary: old then new data URLs");
    const el9 = D.DiffView({ model: rnModel, truncated: false, t });
    assert.strictEqual(findClass(el9, "dswFiles_diffBinaryRow").length, 0, "rename without bytes: no image row (text path)"); }
  // C3: a deleted file's header shows its REAL path (its newPath is the
  // /dev/null placeholder).
  { const delModel = D.parseDiff(fx("delete.txt")).files[0];
    const el7 = D.DiffView({ model: delModel, truncated: false, t });
    const nameEl = findClass(el7, "dswFiles_diffName")[0];
    const nameText = nameEl && Array.isArray(nameEl.c) ? nameEl.c[0] : nameEl && nameEl.c;
    assert.strictEqual(nameText, "del.txt", "header = the real path, not /dev/null: " + JSON.stringify(nameText)); }
  // Unified (narrow) mode: the no-newline marker must not corrupt the line
  // text, regression for `[object Object]` leaking into the cell (a React
  // element string-concatenated onto the text).
  { const cells = D.unifiedCells({ k: "add", text: "noeol", oldNo: null, newNo: 7, noNewline: true }, 0);
    assert.strictEqual(cells.length, 2, "unified: line number + cell");
    const inner = cells[1].c[0]; // the .dswFiles_diffCellIn span
    assert.ok(inner.t === "span", "cell wraps an inner cellIn span");
    const content = inner.c[0]; // [markerEl, "noeol"]
    assert.strictEqual(String(content[1]), "noeol", "unified cell text is plain (marker + text)");
    assert.ok(!String(content[1]).includes("[object Object]"), "no [object Object] in the unified cell");
    assert.ok(inner.c[1] !== null, "no-newline marker is its own child (not string-concatenated)"); }
  // Intra-line spans (BUG-003): a mod row gets strong span highlights on both
  // sides; a pure-add file renders row tints only, no spans.
  { const modEl = D.DiffView({ model: D.parseDiff(fx("modify.txt")).files[0], truncated: false, t });
    assert.strictEqual(findClass(modEl, "dswFiles_spanDel").length, 1, "diff view: the mod row flags the old line's changed span");
    assert.strictEqual(findClass(modEl, "dswFiles_spanAdd").length, 1, "diff view: the mod row flags the new line's changed span"); }
  // Similarity gate at the render level (BUG-004): a rewritten line (no
  // shared tokens) gets the plain row tint, no word spans.
  { const rwEl = D.DiffView({ model: D.parseDiff(fx("rewrite.txt")).files[0], truncated: false, t });
    assert.strictEqual(findClass(rwEl, "dswFiles_spanDel").length + findClass(rwEl, "dswFiles_spanAdd").length, 0, "rewritten row: no intra-line spans (the gate)"); }
  { const addEl = D.DiffView({ model: D.parseDiff(fx("add.txt")).files[0], truncated: false, t });
    assert.strictEqual(findClass(addEl, "dswFiles_spanDel").length + findClass(addEl, "dswFiles_spanAdd").length, 0, "pure adds: no intra-line spans"); }
}

// 11) Presentation modes (M6): diff | view (raw) | preview (rendered).
// Only markdown/HTML have a distinct rendering, the toggle and the auto
// default follow from that; markdown renders by default (our own
// escape-first renderer, no scripts), HTML defaults to raw (rendering
// executes the document's scripts, explicit opt-in).
{
  assert.strictEqual(D.renderKindOf("a.md"), "markdown", "kind: .md");
  assert.strictEqual(D.renderKindOf("a.markdown"), "markdown", "kind: .markdown");
  assert.strictEqual(D.renderKindOf("index.html"), "html", "kind: .html");
  assert.strictEqual(D.renderKindOf("X.HTM"), "html", "kind: case-insensitive");
  assert.strictEqual(D.renderKindOf("a.txt"), null, "kind: text → null");
  assert.strictEqual(D.renderKindOf("a.md.bak"), null, "kind: suffix must be the extension");
  assert.strictEqual(D.renderKindOf(""), null, "kind: empty → null");
  assert.strictEqual(D.resolvePaneMode("auto", true, "a.txt"), "diff", "auto: diffable → diff");
  assert.strictEqual(D.resolvePaneMode("auto", false, "a.md"), "preview", "auto: unchanged md → rendered by default");
  assert.strictEqual(D.resolvePaneMode("auto", false, "a.html"), "view", "auto: unchanged html → RAW (scripts = opt-in)");
  assert.strictEqual(D.resolvePaneMode("auto", false, "a.txt"), "view", "auto: unchanged text → view");
  assert.strictEqual(D.resolvePaneMode("diff", false, "a.md"), "view", "pinned diff that stops being diffable → view");
  assert.strictEqual(D.resolvePaneMode("preview", false, "a.html"), "preview", "pinned preview sticks");
  assert.strictEqual(D.resolvePaneMode("view", true, "a.md"), "view", "pinned view beats the diff default");
  assert.deepStrictEqual(D.paneToggleModes(true, "a.md"), ["diff", "view", "preview"], "toggle: diffable md → all three");
  assert.deepStrictEqual(D.paneToggleModes(true, "a.txt"), ["diff", "view"], "toggle: diffable text → two");
  assert.deepStrictEqual(D.paneToggleModes(false, "a.md"), ["view", "preview"], "toggle: unchanged md → view + preview");
  assert.deepStrictEqual(D.paneToggleModes(false, "a.html"), ["view", "preview"], "toggle: unchanged html → view + preview");
  assert.deepStrictEqual(D.paneToggleModes(false, "a.txt"), [], "toggle: unchanged plain text → none (today's behavior)");
}

// 12) previewContentFor, the render switch as a pure function (st,
// contentMode, name, t). markdown renders in Preview / shows raw
// in View; html renders in a SEALED iframe in Preview (sandbox attr + CSP
// meta prepended) / shows raw in View; the other branches are mode-agnostic.
{
  const t = (k) => k;
  const find = (function (node, cls, out) {
    if (out === undefined) out = [];
    if (Array.isArray(node)) { for (const ch of node) find(ch, cls, out); return out; }
    if (!node || typeof node !== "object") return out;
    if (typeof node.p?.className === "string" && node.p.className.split(" ").includes(cls)) out.push(node);
    if (node.c) find(node.c, cls, out);
    return out;
  });
  { const el = D.previewContentFor({ status: "markdown", text: "# Hi\n\nA **bold** para." }, "preview", "a.md", t);
    const md = find(el, "dswFiles_previewMarkdown");
    assert.strictEqual(md.length, 1, "md Preview: the rendered div");
    assert.ok(md[0].p.dangerouslySetInnerHTML.__html.includes("<strong>bold</strong>"), "md Preview: rendered html");
    const el2 = D.previewContentFor({ status: "markdown", text: "# Hi\n\nA **bold** para." }, "view", "a.md", t);
    assert.strictEqual(find(el2, "dswFiles_previewMarkdown").length, 0, "md View: no rendered div");
    assert.strictEqual(find(el2, "dswFiles_previewText").length, 1, "md View: the raw source");
    assert.ok(find(el2, "dswFiles_previewText")[0].c[0].includes("# Hi"), "md View: raw bytes (the # is source, not a heading)"); }
  { const html = "<!doctype html><html><body><h1>ok</h1><script>bad()</script></body></html>";
    const el = D.previewContentFor({ status: "text", text: html, name: "x.html" }, "preview", "x.html", t);
    const frame = find(el, "dswFiles_previewHtml");
    assert.strictEqual(frame.length, 1, "html Preview: the sealed iframe");
    assert.strictEqual(frame[0].p.sandbox, "allow-scripts", "html Preview: sandbox = allow-scripts ONLY (opaque origin, no top-nav/popups/forms/modals/downloads)");
    assert.ok(frame[0].p.srcdoc.startsWith("<meta http-equiv=\"Content-Security-Policy\""), "html Preview: no-network CSP prepended");
    // A missing closing quote on the content attribute makes the parser
    // swallow the whole document into the attribute (blank frame, no CSP).
    const metaTag = frame[0].p.srcdoc.slice(0, frame[0].p.srcdoc.indexOf(">") + 1);
    assert.strictEqual((metaTag.match(/"/g) || []).length % 2, 0, "html Preview: CSP meta tag is well-formed (attributes closed before the >)");
    assert.ok(frame[0].p.srcdoc.includes("default-src 'none'"), "html Preview: CSP default-src none");
    assert.ok(frame[0].p.srcdoc.endsWith(html), "html Preview: the document itself is untouched after the meta");
    assert.strictEqual(find(el, "dswFiles_previewHtmlNote").length, 1, "html Preview: the sealed-render note");
    const el2 = D.previewContentFor({ status: "text", text: html, name: "x.html" }, "view", "x.html", t);
    assert.strictEqual(find(el2, "dswFiles_previewHtml").length, 0, "html View: no iframe (raw)");
    assert.strictEqual(find(el2, "dswFiles_previewText").length, 1, "html View: the raw source"); }
  { const el = D.previewContentFor({ status: "text", text: "let a = 1;\n", name: "a.js" }, "preview", "a.js", t);
    assert.strictEqual(find(el, "dswFiles_previewText").length, 1, "js in 'preview' mode: no distinct rendering → raw (the UI never offers Preview for it)"); }
  { const el = D.previewContentFor({ status: "image", url: "data:image/png;base64,AAAA", name: "x.png" }, "view", "x.png", t);
    assert.strictEqual(find(el, "dswFiles_previewImageWrap").length, 1, "image: unchanged by mode"); }
  { const el = D.previewContentFor({ status: "binary", name: "x.bin", size: 1000, label: "ZIP archive" }, "view", "x.bin", t);
    const hint = find(el, "dswFiles_previewCardHint")[0];
    assert.strictEqual(hint.c[0], "files.binaryFile", "binary card hint is always 'binary file' (no open-in-window affordance)"); }
}

// 13) Keyboard nav (P5): the roving-focus target math, arrows/Home/End
// move the focus (clamped), ArrowLeft/Enter are NOT index moves (up-a-level
// and native activation are handled by the caller).
{
  assert.strictEqual(D.listNavTarget("ArrowDown", 0, 5), 1, "down: advance");
  assert.strictEqual(D.listNavTarget("ArrowDown", 4, 5), 4, "down: clamped at the last row");
  assert.strictEqual(D.listNavTarget("ArrowUp", 0, 5), 0, "up: clamped at the first row");
  assert.strictEqual(D.listNavTarget("ArrowUp", 3, 5), 2, "up: retreat");
  assert.strictEqual(D.listNavTarget("Home", 3, 5), 0, "Home: first row");
  assert.strictEqual(D.listNavTarget("End", 1, 5), 4, "End: last row");
  assert.strictEqual(D.listNavTarget("ArrowLeft", 1, 5), null, "ArrowLeft is not index math (it goes up a level)");
  assert.strictEqual(D.listNavTarget("Enter", 1, 5), null, "Enter is not index math (native activation)");
  assert.strictEqual(D.listNavTarget("ArrowDown", 0, 0), null, "empty list: no target");
}

// 14) buildMermaidDoc (P6): the sealed sandbox document for mermaid fences.
// The bundle is inlined (the sandboxed frame has no network); the diagram
// source is escaped (it becomes script-free content, not markup); the CSP is
// default-none; antiscript security level; height postMessage.
{
  const doc = H.buildMermaidDoc("BUNDLE_CODE", "flowchart TD\n  A-->B", "dark");
  assert.ok(doc.includes("BUNDLE_CODE"), "mermaid doc: the bundle is inlined");
  assert.ok(doc.includes("<pre class=\"mermaid\">flowchart TD\n  A--&gt;B</pre>"), "mermaid doc: the source is escaped into the <pre> (the arrow's > becomes &gt;)");
  assert.ok(doc.includes("<pre class=\"mermaid\">"), "mermaid doc: the source sits in pre.mermaid");
  assert.ok(doc.includes("default-src 'none'"), "mermaid doc: CSP default-src 'none' (no network, no external resources)");
  assert.ok(doc.includes("script-src 'unsafe-inline'"), "mermaid doc: inline scripts allowed (the inlined bundle)");
  assert.ok(doc.includes("object-src 'none'"), "mermaid doc: no plugins/objects");
  assert.ok(doc.includes("securityLevel:\"antiscript\""), "mermaid doc: antiscript security level");
  assert.ok(doc.includes("theme:\"dark\""), "mermaid doc: theme parameter");
  assert.ok(doc.includes("parent.postMessage({filestabMermaid:"), "mermaid doc: height postMessage");
  // The glue script must PARSE. When the localized render-failed prefix was
  // spliced in, a missing + left two adjacent string literals
  // (node.textContent+"\n\n""Render failed:"), the frame's script died with
  // "Unexpected string", and the height report and error prefix were dead code.
  const glue = doc.slice(doc.lastIndexOf("<script>") + "<script>".length, doc.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function("window", "document", "parent", glue), "mermaid doc: the glue script parses (no adjacent-literal syntax error)");
  const doc2 = H.buildMermaidDoc("B</script>Evil", "x", "default");
  assert.strictEqual((doc2.match(/<\/script>/g) || []).length, 2, "mermaid doc: a bundle containing the literal tag cannot escape its <script> (only the two intended closers survive)");
  const light = H.buildMermaidDoc("B", "x", "default");
  assert.ok(light.includes("theme:\"default\""), "mermaid doc: light theme is default");
}

// 15) Dark-theme key: both the hljs palette and the mermaid frame must follow
// the dsh theme's RESOLVED preference (body[data-ds-dark-theme], applied by
// the theme presenter from light/dark/system), not the raw OS scheme --
// a prefers-color-scheme media query or matchMedia drifts whenever the
// user preference is explicit. Guard the regression at the bundle level.
{
  assert.ok(src.includes("body[data-ds-dark-theme]"), "theme: dark styling is keyed on body[data-ds-dark-theme]");
  assert.ok(!src.includes("@media (prefers-color-scheme: dark)"), "theme: no prefers-color-scheme media query in the hljs palette");
  assert.ok(!src.includes("(prefers-color-scheme: dark)"), "theme: no raw OS-scheme detection anywhere (the mermaid frame reads the body attribute)");
}

// 16) highlightSource (source file view): text files highlight by
// extension with the same hljs set as the markdown fences; unknown types
// stay plain unless auto-detect is confident (and the file is small).
{
  assert.ok(H.highlightSource("const x = 1;", "a.ts").includes("hljs-keyword"), "src view: a .ts file gets hljs token spans");
  assert.ok(H.highlightSource("SELECT id FROM t;", "a.sql").includes("hljs-"), "src view: a .sql file gets hljs token spans");
  assert.strictEqual(H.highlightSource("plain prose that is not code at all.", "notes.xyz"), null, "src view: unknown extension + low relevance stays plain");
  assert.strictEqual(H.highlightSource("x ".repeat(300 * 1024), "big.xyz"), null, "src view: unknown extension above the auto-detect cap stays plain");
  const hl = H.highlightSource("const x = 1;", "a.ts");
  const el = H.previewContentFor({ status: "text", text: "const x = 1;", name: "a.ts", size: 11, truncated: false, highlighted: hl }, "view", "a.ts", (k) => k);
  assert.ok(el.c[0].p.dangerouslySetInnerHTML.__html.includes("hljs-keyword"), "src view: the preview <pre> renders the highlighted HTML");
  const plain = H.previewContentFor({ status: "text", text: "plain prose", name: "notes.xyz", size: 11, truncated: false }, "view", "notes.xyz", (k) => k);
  assert.strictEqual(plain.c[0].p.dangerouslySetInnerHTML, undefined, "src view: plain text keeps the escaped text render (no innerHTML)");
  assert.strictEqual(plain.c[0].c[0], "plain prose", "src view: the plain text is the <pre>'s child");
}

// 17) Content-layer i18n: file-type labels come from the CLIENT dictionaries
// (keyed by the MIME type on the wire), not from the host's English
// labelFor — so the displayed label follows the user's locale. Unknown types
// fall back to the raw MIME string (a technical token); a missing type falls
// back to the localized "binary file".
{
  const identity = (k) => k;
  assert.strictEqual(H.typeLabel("image/png", identity), "files.type.png", "typeLabel: known type maps to its dictionary key");
  assert.strictEqual(H.typeLabel("application/x-unknown", identity), "application/x-unknown", "typeLabel: unknown type falls back to the raw MIME string");
  assert.strictEqual(H.typeLabel("", identity), "files.type.binary", "typeLabel: empty type falls back to the binary-file key");
  assert.strictEqual(H.typeLabel(undefined, identity), "files.type.binary", "typeLabel: missing type falls back to the binary-file key");
  // Every key must exist in the bundle for BOTH locales (en + zh ship together).
  for (const [key, en, zh] of [
    ["files.type.png", "PNG image", "PNG 图像"],
    ["files.type.jpeg", "JPEG image", "JPEG 图像"],
    ["files.type.gif", "GIF image", "GIF 图像"],
    ["files.type.bmp", "BMP image", "BMP 图像"],
    ["files.type.webp", "WebP image", "WebP 图像"],
    ["files.type.svg", "SVG image", "SVG 图像"],
    ["files.type.avif", "AVIF image", "AVIF 图像"],
    ["files.type.icon", "icon", "图标"],
    ["files.type.pdf", "PDF document", "PDF 文档"],
    ["files.type.zip", "ZIP archive", "ZIP 压缩包"],
    ["files.type.gzip", "GZIP file", "GZIP 文件"],
    ["files.type.elf", "ELF binary", "ELF 二进制文件"],
    ["files.type.binary", "binary file", "二进制文件"],
    ["files.type.markdown", "Markdown", "Markdown"],
    ["files.type.mp3", "MP3 audio", "MP3 音频"],
    ["files.type.wav", "WAV audio", "WAV 音频"],
    ["files.type.avi", "AVI video", "AVI 视频"],
    ["files.copyPath", "Copy path", "复制路径"],
    ["files.openLocal", "Open locally", "在本地打开"],
    ["files.openFailed", "couldn't open the file on the desktop", "无法在桌面打开该文件"],
    ["files.ageNow", "now", "刚刚"],
    ["files.ageMin", "{n}m", "{n} 分钟"],
    ["files.ageHour", "{n}h", "{n} 小时"],
    ["files.ageDay", "{n}d", "{n} 天"],
    ["files.pathGone", "the folder no longer exists", "文件夹已不存在"],
    ["files.showingRoot", "showing the workspace root", "已显示工作区根目录"],
    ["files.pdfFrameTitle", "PDF preview", "PDF 预览"],
    ["files.htmlFrameTitle", "HTML preview", "HTML 预览"],
    ["files.mermaidFrameTitle", "mermaid diagram", "mermaid 图表"],
    ["files.renderFailed", "Render failed:", "渲染失败："],
  ]) {
    assert.ok(src.includes(`"${key}"`), `i18n: key ${key} registered in the bundle`);
    assert.ok(src.includes(en), `i18n: en value for ${key}`);
    assert.ok(src.includes(zh), `i18n: zh value for ${key}`);
  }
  // The binary card meta renders the localized type label (via t), not the host label.
  const card = H.previewContentFor({ status: "binary", name: "blob.bin", size: 1234, type: "application/zip" }, "view", "blob.bin", identity);
  assert.ok(String(card.c[1].c[0]).includes("files.type.zip"), "i18n: binary card meta uses the localized type key");
  // buildMermaidDoc takes the localized render-failed prefix (default preserved).
  assert.ok(H.buildMermaidDoc("BUNDLE", "flowchart TD", "default").includes("Render failed:"), "mermaid doc: default render-failed prefix");
  assert.ok(H.buildMermaidDoc("BUNDLE", "flowchart TD", "dark", "渲染失败：").includes("渲染失败："), "mermaid doc: localized render-failed prefix");
}

// 18) BUG-002: local document-relative images in the Markdown preview. A
// workspace file is never a same-origin document (no HTTP file route), so a
// relative <img src> cannot load. The code resolves each resolvable local
// src against the md file's own directory, fetches its bytes over the
// fileshow transport, and rewrites the src to a data: URL before render.
{
  assert.deepStrictEqual(
    H.markdownImageSrcs("# T\n\n![hero](assets/hero.png)\ninline ![x](sub/i.png) text\n"),
    ["assets/hero.png", "sub/i.png"], "image srcs: extracted in document order");
  // markdown-it keeps remote and data: srcs as <img> tokens (the browser
  // handles those); the local filter (isLocalDocImageSrc) decides which are
  // workspace refs. Fenced refs are code, not images.
  assert.deepStrictEqual(
    H.markdownImageSrcs("![remote](https://e.com/a.png)\n" +
      "![data](data:image/png;base64,AAA)\n" +
      "- ![list](pic.png)\n" +
      "```\n![fenced](code.png)\n```\n"),
    ["https://e.com/a.png", "data:image/png;base64,AAA", "pic.png"],
    "image srcs: rendered <img> tokens in document order (remote/data kept, fenced is code)");
  assert.deepStrictEqual(H.markdownImageSrcs("no images here\n"), [], "image srcs: none → []");

  assert.strictEqual(H.isLocalDocImageSrc("assets/hero.png"), true, "local: plain relative");
  assert.strictEqual(H.isLocalDocImageSrc("./a/b.png"), true, "local: ./ relative");
  assert.strictEqual(H.isLocalDocImageSrc("../up.png"), true, "local: parent relative");
  assert.strictEqual(H.isLocalDocImageSrc("https://e.com/a.png"), false, "local: https is not local");
  assert.strictEqual(H.isLocalDocImageSrc("http://e.com/a.png"), false, "local: http is not local");
  assert.strictEqual(H.isLocalDocImageSrc("data:image/png;base64,AAA"), false, "local: data: is not local");
  assert.strictEqual(H.isLocalDocImageSrc("/abs.png"), false, "local: root-absolute is not document-relative");
  assert.strictEqual(H.isLocalDocImageSrc(""), false, "local: empty is not local");

  assert.strictEqual(H.resolveDocImage("README.md", "assets/hero.png"), "assets/hero.png", "resolve: root doc, sibling dir");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "img/x.png"), "docs/sub/img/x.png", "resolve: nested doc, same dir");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "../img/x.png"), "docs/img/x.png", "resolve: parent climb");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "./y.png"), "docs/sub/y.png", "resolve: ./ segment dropped");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "a/../b.png"), "docs/sub/b.png", "resolve: internal climb");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "../../top.png"), "top.png", "resolve: climb to root");
  assert.strictEqual(H.resolveDocImage("docs/sub/note.md", "../../../etc/passwd"), "", "resolve: past the root → invalid");
  assert.strictEqual(H.resolveDocImage("note.md", "../x.png"), "", "resolve: single-level doc, climb past root");

  const imgHtml = '<p><img src="assets/hero.png" alt="hero" /></p>\n' +
    '<p><img src="https://e.com/r.png" alt="r" /></p>\n' +
    '<p><img src="missing.png" alt="m" /></p>';
  const imgMap = { "assets/hero.png": "data:image/png;base64,AAAA" };
  assert.strictEqual(
    H.rewriteMarkdownImages(imgHtml, imgMap),
    '<p><img src="data:image/png;base64,AAAA" alt="hero" /></p>\n<p><img src="https://e.com/r.png" alt="r" /></p>\n<p><img src="missing.png" alt="m" /></p>',
    "rewrite: mapped src → data URL; remote and unmapped srcs untouched");
  assert.strictEqual(H.rewriteMarkdownImages(imgHtml, {}), imgHtml, "rewrite: empty map leaves the html");
  assert.strictEqual(H.rewriteMarkdownImages("<p>no img</p>", imgMap), "<p>no img</p>", "rewrite: html without imgs untouched");

  const rendered = H.renderMarkdownWithImages("![hero](assets/hero.png)\n", imgMap);
  assert.ok(rendered.includes('<img src="data:image/png;base64,AAAA" alt="hero">'), "renderWithImages: the rendered img carries the data URL");
  const rendered2 = H.renderMarkdownWithImages("![hero](assets/hero.png)\n", {});
  assert.ok(rendered2.includes('src="assets/hero.png"'), "renderWithImages: no map → the src stays (broken-img fallback)");

  { const t = (k) => k;
    const el = H.previewContentFor({ status: "markdown", text: "# Hi\n\n![a](assets/a.png)\n" }, "preview", "a.md", t, { "assets/a.png": "data:image/png;base64,BBB" });
    const find = (function (node, cls, out) {
      if (out === undefined) out = [];
      if (Array.isArray(node)) { for (const ch of node) find(ch, cls, out); return out; }
      if (!node || typeof node !== "object") return out;
      if (typeof node.p?.className === "string" && node.p.className.split(" ").includes(cls)) out.push(node);
      if (node.c) find(node.c, cls, out);
      return out;
    });
    const md = find(el, "dswFiles_previewMarkdown");
    assert.strictEqual(md.length, 1, "md Preview with imgMap: the rendered div");
    assert.ok(md[0].p.dangerouslySetInnerHTML.__html.includes('src="data:image/png;base64,BBB"'), "md Preview: the imgMap rewrites the img src"); }
}

// 19) RPC error handling: unwrap carries the host error code, and the
// session-not-found code maps to the localized notice instead of the raw
// "session-not-found: no live session for <uuid>" string.
{
  const ok = H.unwrap({ ok: true, value: 42 });
  assert.strictEqual(ok, 42, "unwrap: ok envelope passes the value through");

  let threw = null;
  try { H.unwrap({ ok: false, error: { code: "session-not-found", message: "no live session for session-b23c9ff7" } }); }
  catch (e) { threw = e; }
  assert.ok(threw, "unwrap: an error envelope throws");
  assert.strictEqual(threw.code, "session-not-found", "unwrap: the error carries the host code");
  assert.strictEqual(threw.message, "session-not-found: no live session for session-b23c9ff7", "unwrap: message keeps the code + message shape");

  let missing = null;
  try { H.unwrap({ ok: false, error: { message: "boom" } }); } catch (e) { missing = e; }
  assert.strictEqual(missing.code, "rpc-failed", "unwrap: a codeless error gets the fallback code");
  assert.strictEqual(missing.message, "boom", "unwrap: codeless error keeps the bare message");

  assert.strictEqual(H.isSessionGone(threw), true, "isSessionGone: matches the session-not-found code");
  assert.strictEqual(H.isSessionGone(new Error("session-not-found: something else")), false, "isSessionGone: plain errors are not session-gone");
  assert.strictEqual(H.isSessionGone(null), false, "isSessionGone: null is not session-gone");
  assert.strictEqual(H.isSessionGone("a string"), false, "isSessionGone: non-objects are not session-gone");

  const t = (k) => (k === "files.sessionGone" ? "SESSION_GONE" : k);
  assert.strictEqual(H.rpcErrorText(threw, t), "SESSION_GONE", "rpcErrorText: session-gone → localized notice");
  assert.strictEqual(H.rpcErrorText(missing, t), "boom", "rpcErrorText: other errors pass the message through");
  assert.strictEqual(H.rpcErrorText("plain", t), "plain", "rpcErrorText: non-Error values fall back to String");

  // BUG-009: details ride the error (the recovery reads details.path), and
  // directory-unreadable localizes instead of showing "internal: not-found".
  let dir = null;
  try { H.unwrap({ ok: false, error: { code: "directory-unreadable", message: "not-found: sub/gone", details: { path: "sub/gone" } } }); }
  catch (e) { dir = e; }
  assert.ok(dir, "unwrap: directory-unreadable envelope throws");
  assert.strictEqual(dir.code, "directory-unreadable", "unwrap: the closed code survives");
  assert.strictEqual(dir.details.path, "sub/gone", "unwrap: details.path rides along");
  const t2 = (k) => (k === "files.pathGone" ? "PATH_GONE" : k);
  assert.strictEqual(H.rpcErrorText(dir, t2), "PATH_GONE (sub/gone)", "rpcErrorText: directory-unreadable → localized note + the dead path");
  const dirNoPath = Object.assign(new Error("x"), { code: "directory-unreadable" });
  assert.strictEqual(H.rpcErrorText(dirNoPath, t2), "PATH_GONE", "rpcErrorText: directory-unreadable without a path stays bare");
}

// BUG-006: the copy-path gate is LOOPBACK-only (an absolute path is
// local-machine information; the deployment's --trusted-host is not loopback,
// so the client-side check must be narrower than the GUI's own fence).
{
  assert.strictEqual(H.isLoopbackOrigin(), false, "loopback gate: no location (Node harness) → never offered");
  Object.defineProperty(globalThis, "location", { value: { hostname: "127.0.0.1" }, writable: true, configurable: true });
  assert.strictEqual(H.isLoopbackOrigin(), true, "loopback gate: 127.0.0.1");
  globalThis.location.hostname = "localhost";
  assert.strictEqual(H.isLoopbackOrigin(), true, "loopback gate: localhost");
  globalThis.location.hostname = "[::1]";
  assert.strictEqual(H.isLoopbackOrigin(), true, "loopback gate: [::1]");
  globalThis.location.hostname = "::1";
  assert.strictEqual(H.isLoopbackOrigin(), true, "loopback gate: bare ::1");
  globalThis.location.hostname = "127.0.0.2";
  assert.strictEqual(H.isLoopbackOrigin(), false, "loopback gate: 127.0.0.2 is NOT loopback");
  globalThis.location.hostname = "10.0.0.5";
  assert.strictEqual(H.isLoopbackOrigin(), false, "loopback gate: a private LAN address is NOT loopback");
  delete globalThis.location;
  assert.strictEqual(H.absolutePathOf("/ws", "src/a.txt"), "/ws/src/a.txt", "abs path: root + relPath");
  assert.strictEqual(H.absolutePathOf("/ws/", "src/a.txt"), "/ws/src/a.txt", "abs path: the root's trailing slash is trimmed");
}

// BUG-005: "open locally" reuses dsh's own produced-files mechanism — the
// /api host methods (host.describe / host.openPath) with dsh's unary
// client-request envelope. The transport is plain same-origin fetch; the
// host-side behavior (xdg-open hand-off, canOpenPath probe) is dsh's.
{
  // Envelope shape: the four-quadrant client-request form dsh's own client
  // (dsh-client-connection callUnary) POSTs.
  const env = JSON.parse(H.hostEnvelope("host.openPath", { path: "/ws/a.txt" }, "rid-1"));
  assert.deepStrictEqual(env, { type: "client-request", rpcId: "rid-1", method: "host.openPath", payload: { path: "/ws/a.txt" } }, "envelope: type/rpcId/method/payload");

  // Response parsing: ok value passes through; a closed error keeps code +
  // message; an rpcId mismatch or malformed frame is a host-error.
  assert.deepStrictEqual(H.parseHostResponse({ rpcId: "r1", result: { ok: true, value: { canOpenPath: true } } }, "r1"),
    { ok: true, value: { canOpenPath: true } }, "host response: ok value");
  assert.deepStrictEqual(H.parseHostResponse({ rpcId: "r1", result: { ok: false, error: { code: "internal", message: "path open failed: xdg-open" } } }, "r1"),
    { ok: false, code: "internal", message: "path open failed: xdg-open" }, "host response: error code + message");
  assert.deepStrictEqual(H.parseHostResponse({ rpcId: "x", result: { ok: true, value: 1 } }, "y"),
    { ok: false, code: "host-error", message: "rpcId mismatch" }, "host response: rpcId mismatch");
  assert.strictEqual(H.parseHostResponse(null, "r1").code, "host-error", "host response: malformed frame");

  // The full call against a stubbed fetch: the POST leg, the echo check,
  // and the error → RpcError mapping.
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), init };
    return { ok: true, status: 200, json: async () => ({ type: "server-response", rpcId: JSON.parse(init.body).rpcId, result: { ok: true, value: { opened: true } } }) };
  };
  const opened = await H.hostApi("host.openPath", { path: "/ws/a.txt" });
  assert.deepStrictEqual(opened, { opened: true }, "hostApi: ok value");
  assert.strictEqual(sent.url, "/api/host.openPath", "hostApi: same-origin unary path");
  assert.deepStrictEqual(JSON.parse(sent.init.body), { type: "client-request", rpcId: JSON.parse(sent.init.body).rpcId, method: "host.openPath", payload: { path: "/ws/a.txt" } }, "hostApi: the wire envelope");
  assert.ok(typeof JSON.parse(sent.init.body).rpcId === "string" && JSON.parse(sent.init.body).rpcId.length > 8, "hostApi: a real rpcId is minted");

  globalThis.fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ type: "server-response", rpcId: JSON.parse(init.body).rpcId, result: { ok: false, error: { code: "internal", message: "path open failed: xdg-open /nope" } } }) });
  let threw = null;
  try { await H.hostApi("host.openPath", { path: "/nope" }); } catch (e) { threw = e; }
  assert.strictEqual(threw.code, "internal", "hostApi: the host error code survives");
  assert.ok(/path open failed/.test(threw.message), "hostApi: the host message rides the error");

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ rpcId: "someone-else", result: { ok: true, value: {} } }) });
  let bad = null;
  try { await H.hostApi("host.describe", {}); } catch (e) { bad = e; }
  assert.strictEqual(bad.code, "host-error", "hostApi: rpcId mismatch → host-error");

  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  let dead = null;
  try { await H.hostApi("host.describe", {}); } catch (e) { dead = e; }
  assert.ok(/transport failure.*502/.test(dead.message), "hostApi: non-2xx → transport failure");
  delete globalThis.fetch;

  // The offer gate: loopback + known root + file + a positive probe.
  assert.strictEqual(H.canOfferOpenLocal({ relPath: "a.txt", wsRoot: "/ws", openCapable: true }), false, "open gate: no location (Node) → hidden");
  Object.defineProperty(globalThis, "location", { value: { hostname: "127.0.0.1" }, writable: true, configurable: true });
  assert.strictEqual(H.canOfferOpenLocal({ relPath: "a.txt", wsRoot: "/ws", openCapable: true }), true, "open gate: loopback + root + probe → offered");
  assert.strictEqual(H.canOfferOpenLocal({ relPath: null, wsRoot: "/ws", openCapable: true }), false, "open gate: no file → hidden");
  assert.strictEqual(H.canOfferOpenLocal({ relPath: "a.txt", wsRoot: null, openCapable: true }), false, "open gate: no root → hidden");
  assert.strictEqual(H.canOfferOpenLocal({ relPath: "a.txt", wsRoot: "/ws", openCapable: false }), false, "open gate: a negative probe → hidden");
  globalThis.location.hostname = "dsh.example.com";
  assert.strictEqual(H.canOfferOpenLocal({ relPath: "a.txt", wsRoot: "/ws", openCapable: true }), false, "open gate: a --trusted-host remote → hidden");
  delete globalThis.location;
}

// BUG-008: the row-meta relative age. Compact short forms while recent
// (with {n} interpolation), a browser-locale calendar date past 7 days, and
// a FUTURE mtime (clock skew) also takes the date — never a negative age.
{
  const tag = (k) => ({ "files.ageNow": "now", "files.ageMin": "{n}m", "files.ageHour": "{n}h", "files.ageDay": "{n}d" })[k] || k;
  const now = Date.now();
  assert.strictEqual(H.formatAge(now - 5_000, tag), "now", "age: < 1 min → now");
  assert.strictEqual(H.formatAge(now - 60_000, tag), "1m", "age: exactly 1 min → 1m");
  assert.strictEqual(H.formatAge(now - 5 * 60_000, tag), "5m", "age: 5 min → 5m");
  assert.strictEqual(H.formatAge(now - 59 * 60_000, tag), "59m", "age: 59 min stays in minutes");
  assert.strictEqual(H.formatAge(now - 3 * 3600_000, tag), "3h", "age: 3 h → 3h");
  assert.strictEqual(H.formatAge(now - 23 * 3600_000, tag), "23h", "age: 23 h stays in hours (< 1 day)");
  assert.strictEqual(H.formatAge(now - 25 * 3600_000, tag), "1d", "age: 25 h rolls into days");
  assert.strictEqual(H.formatAge(now - 2 * 86400_000, tag), "2d", "age: 2 d → 2d");
  assert.ok(/20\d{2}/.test(H.formatAge(now - 30 * 86400_000, tag)), "age: 30 d → calendar date (carries the year): " + H.formatAge(now - 30 * 86400_000, tag));
  assert.ok(/20\d{2}/.test(H.formatAge(now + 60_000, tag)), "age: a future mtime → calendar date, not -1m");
}

// ---- Section refs (selection → @path reference text) ----
{
  // mentionOf: the dsh mention grammar — plain @path, quoted @"path" when a
  // whitespace / quote / control char is present (those are dropped).
  assert.strictEqual(H.mentionOf("src/foo.ts"), "@src/foo.ts", "mention: plain path");
  assert.strictEqual(H.mentionOf("my dir/foo.ts"), '@"my dir/foo.ts"', "mention: space forces the quoted form");
  assert.strictEqual(H.mentionOf('a"b.ts'), '@"ab.ts"', "mention: an inner double quote is dropped, quoted form");
  assert.strictEqual(H.mentionOf(""), "@", "mention: empty path degrades to a bare @");

  // lineStartsOf: char offset of each line start (line 1 starts at 0).
  assert.deepStrictEqual(H.lineStartsOf("a\nb\nc"), [0, 2, 4], "lineStarts: three lines");
  assert.deepStrictEqual(H.lineStartsOf("no newline"), [0], "lineStarts: single line");
  assert.deepStrictEqual(H.lineStartsOf("a\nb\n"), [0, 2, 4], "lineStarts: trailing newline = 3rd empty line");
  assert.deepStrictEqual(H.lineStartsOf(""), [0], "lineStarts: empty text still has line 1");

  // lineOfOffset: 1-based line of a char offset (binary search).
  const starts = H.lineStartsOf("aaaa\nbb\ncccccc");
  assert.strictEqual(H.lineOfOffset(0, starts), 1, "lineOfOffset: first char");
  assert.strictEqual(H.lineOfOffset(3, starts), 1, "lineOfOffset: last char of line 1");
  assert.strictEqual(H.lineOfOffset(4, starts), 1, "lineOfOffset: the newline belongs to the line it ends");
  assert.strictEqual(H.lineOfOffset(5, starts), 2, "lineOfOffset: first char of line 2");
  assert.strictEqual(H.lineOfOffset(13, starts), 3, "lineOfOffset: last char");
  assert.strictEqual(H.lineOfOffset(999, starts), 3, "lineOfOffset: past the end clamps to the last line");

  // buildFileRef: the final shapes (pure-ASCII, never localized).
  assert.strictEqual(H.buildFileRef({ path: "src/foo.ts" }), "@src/foo.ts", "ref: whole file, no fragment");
  assert.strictEqual(H.buildFileRef({ path: "src/foo.ts", start: 12 }), "@src/foo.ts:12", "ref: single line");
  assert.strictEqual(H.buildFileRef({ path: "src/foo.ts", start: 12, end: 40 }), "@src/foo.ts:12-40", "ref: line range");
  assert.strictEqual(H.buildFileRef({ path: "src/foo.ts", start: 12, end: 12 }), "@src/foo.ts:12", "ref: degenerate range collapses");
  assert.strictEqual(H.buildFileRef({ path: "src/foo.ts", start: 40, end: 12 }), "@src/foo.ts:12-40", "ref: end < start is re-ordered");
  assert.strictEqual(
    H.buildFileRef({ path: "src/foo.ts", start: 12, end: 40, rev: "abc123" }),
    "@src/foo.ts@abc123:12-40", "ref: snapshot mode carries the rev");
  assert.strictEqual(
    H.buildFileRef({ path: "my dir/foo.ts", start: 12, end: 40 }),
    '@"my dir/foo.ts":12-40', "ref: spaced path uses the quoted mention");
  assert.strictEqual(
    H.buildFileRef({ path: "src/foo.ts", start: 12, end: 40, text: "const x = 1;" }),
    '@src/foo.ts:12-40 "const x = 1;"', "ref: snippet follows the fragment");
  assert.strictEqual(
    H.buildFileRef({ path: "docs/notes.md", text: "Deploying to prod" }),
    '@docs/notes.md "Deploying to prod"', "ref: snippet-only shape (no line numbers)");
  assert.strictEqual(
    H.buildFileRef({ path: "src/foo.ts", start: 12, text: "  const x = 1;  " }),
    '@src/foo.ts:12 "const x = 1;"', "ref: the snippet is trimmed");
  assert.strictEqual(
    H.buildFileRef({ path: "src/foo.ts", start: 12, text: 'say "hi"' }),
    '@src/foo.ts:12 "say \'hi\'"', "ref: inner double quotes become single");

  // The snippet cap: ≤ REF_TEXT_MAX verbatim, beyond it head + ellipsis.
  const short200 = "a".repeat(200);
  assert.strictEqual(
    H.buildFileRef({ path: "p.ts", start: 1, text: short200 }),
    '@p.ts:1 "' + short200 + '"', "ref: a 200-char snippet fits verbatim");
  const long = "b".repeat(250);
  const longRef = H.buildFileRef({ path: "p.ts", start: 1, text: long });
  const longBody = longRef.slice(9, -1); // strip `@p.ts:1 "` and the closing quote
  assert.strictEqual(longBody, "b".repeat(200) + "…", "ref: long snippet caps at 200 chars + ellipsis, head kept");

  // Blank/whitespace text produces no quote at all (the plain ref stands alone).
  assert.strictEqual(H.buildFileRef({ path: "p.ts", start: 3, text: "   \n " }), "@p.ts:3", "ref: blank text → no quote");
  assert.strictEqual(H.buildFileRef({ path: "p.ts", text: "" }), "@p.ts", "ref: empty text, no range → bare mention");
}

console.log("client: bundle + apply + inject-face + render + diff parser/view OK");
