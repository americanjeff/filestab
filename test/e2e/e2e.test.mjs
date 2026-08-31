// test/e2e/e2e.test.mjs, end-to-end journeys against a sandboxed dsh instance
// driven by a real headless browser (playwright-core + a playwright chromium).
//
// Scope: the Files tab journeys J1, J1.2, J2, J3, J4, J5, J6, J18 (each defined by its section header below).
// The workspace picker and the send-a-message session flow are dsh's own UI;
// here they are automation helpers, not code under test.
//
// Isolation: a scratch DSH_HOME (copy of the real web profile + settings.yaml,
// empty session store), a free port (--port 0), fresh fixtures. The dsh child
// and the scratch tree are removed on exit. The real DSH_HOME and any running
// GUI are never touched.
//
// Cost: the released UI only builds a session's conversation pane (with the
// view tabs) once a turn exists, so each workspace under test costs one small
// "hello" agent turn on the model route in settings.yaml.
//
// Prereqs: dsh and jj on PATH; a playwright chromium (~/.cache/ms-playwright,
// newest build) or E2E_CHROME=/path/to/chrome; filestab dist/ built (npm test).
//
// Run: npm run e2e  -- intentionally separate from npm test (it needs a
// browser, a live model route, and the dsh CLI; the unit suites stay hermetic).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_BIN = process.env.E2E_DSH || "dsh";

// BRITTLE, on purpose: pinned to the dsh build this e2e was written against.
// openSession() drives dsh's OWN UI (the workspace picker's hashed CSS-module
// classes, the "Add workspace"/"Send message" button labels) -- that is not a
// stable contract. When dsh is bumped this check fails on purpose: rework the
// selectors against the new UI first, then bump DSH_VERSION.
const DSH_VERSION = "0.1.1-rc.2";
function checkDshVersion() {
  const actual = execFileSync(DSH_BIN, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(actual, DSH_VERSION, `dsh version changed (${actual} != ${DSH_VERSION}): the e2e session-opening selectors ride on dsh's own UI and need reworking -- re-verify against the new build, then bump DSH_VERSION.`);
}
const OUT_DIR = join(REPO_ROOT, "test", "e2e", "out");
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

let assertions = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); assertions++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); assertions++; };
const match = (s, re, msg) => { assert.match(String(s), re, msg); assertions++; };

// ── environment ────────────────────────────────────────────────────────────

function makeScratchHome(root) {
  const real = process.env.DSH_HOME || join(process.env.HOME, ".dsh");
  const home = join(root, "home");
  mkdirSync(join(home, "profiles"), { recursive: true });
  cpSync(join(real, "profiles", "web"), join(home, "profiles", "web"), { recursive: true });
  // The profile's node_modules hold the project workspaces it links in.
  // Copied symlinks break (relative targets), and package.json declares the
  // exact link: targets, so re-link each one absolutely.
  const nm = join(home, "profiles", "web", "node_modules");
  const deps = JSON.parse(readFileSync(join(home, "profiles", "web", "package.json"), "utf8")).dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("link:")) continue;
    const link = join(nm, name);
    rmSync(link, { force: true });
    symlinkSync(spec.slice("link:".length), link, "dir");
  }
  if (existsSync(join(real, "settings.yaml"))) {
    cpSync(join(real, "settings.yaml"), join(home, "settings.yaml"));
  }
  return home;
}

function makeFixtures(root) {
  const fx = { root: join(root, "fixtures") };
  // F-JJ: one described commit ("base") + a dirty worktree with 7 visible
  // entries, incl. a symlink that points OUTSIDE the workspace (J18) and a
  // 2 MB random file over FILE_SHOW_CAP (J3).
  fx.fj = join(fx.root, "fj");
  mkdirSync(join(fx.fj, "sub"), { recursive: true });
  execFileSync("jj", ["git", "init"], { cwd: fx.fj });
  execFileSync("jj", ["new", "-m", "base"], { cwd: fx.fj });
  writeFileSync(join(fx.fj, "a.txt"), "one\ntwo\n");
  writeFileSync(join(fx.fj, "sub", "nested.txt"), "x");
  writeFileSync(join(fx.fj, "doc.md"), "# Doc\n\nA **bold** para.\n\n- item\n");
  writeFileSync(join(fx.fj, "page.html"), "<!doctype html><title>t</title><p>hi</p>");
  writeFileSync(join(fx.fj, "pic.png"), PNG_1X1);
  writeFileSync(join(fx.fj, "big.bin"), randomBytes(2_000_000));
  symlinkSync("/etc/passwd", join(fx.fj, "sneaky"));
  // The escape target lives OUTSIDE the workspace (J18).
  fx.outside = join(fx.root, "outside.txt");
  writeFileSync(fx.outside, "secret\n");
  // F-PLAIN: no VCS at all (J1.2, J4, J5). Without VCS nothing is diffable,
  // so pane defaults resolve to the non-diff branches (markdown -> preview,
  // html -> raw view) exactly as the journeys describe.
  fx.plain = join(fx.root, "plain");
  mkdirSync(fx.plain, { recursive: true });
  writeFileSync(join(fx.plain, "hi.txt"), "hi\n");
  // J4: markdown — heading, bold, list, a GFM table, a javascript: link
  // (markdown-it's default link validator must drop it, text stays visible)
  // and a mermaid fence (J5's frame assertions).
  writeFileSync(join(fx.plain, "doc.md"),
    "# Doc\n\nA **bold** para.\n\n- item\n\n" +
    "| h1 | h2 |\n| -- | -- |\n| a  | b  |\n\n" +
    "[js link](javascript:alert(1))\n\n" +
    "```mermaid\nflowchart TD\n  A-->B\n```\n");
  // J5: sandboxed HTML — the script must run IN the frame only: it sets the
  // frame's title, tries to write a PARENT property (opaque origin must
  // throw), ticks a counter to the parent via postMessage, and attempts a
  // fetch that the frame's CSP must block.
  writeFileSync(join(fx.plain, "page.html"),
    "<!doctype html><title>t</title><p>hi</p>\n<script>\n" +
    "window.__ran = true;\n" +
    "document.title = \"rendered-ok\";\n" +
    "var r = \"unknown\";\n" +
    "try { window.parent.__filezProbe = 1; r = \"parent-write-ok\"; } catch (e) { r = \"parent-write-blocked:\" + e.name; }\n" +
    "window.__probeResult = r;\n" +
    "window.__ticks = 0;\n" +
    "setInterval(function () { window.__ticks++; parent.postMessage({ filezProbeTick: window.__ticks }, \"*\"); }, 50);\n" +
    "fetch(\"http://127.0.0.1:1/csp-probe\").catch(function () {});\n" +
    "</script>\n");
  return fx;
}

function bootDsh(home) {
  return new Promise((res, rej) => {
    const child = spawn(DSH_BIN, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rej(new Error("dsh boot timeout:\n" + log.join("").slice(-3000)));
    }, 90_000);
    const stop = () => {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => clearTimeout(killer));
    };
    child.stdout.on("data", (d) => {
      log.push(d.toString());
      process.stdout.write(d.toString());
      const m = d.toString().match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) { settled = true; clearTimeout(timer); res({ port: Number(m[1]), stop }); }
    });
    child.stderr.on("data", (d) => {
      log.push(d.toString());
      process.stderr.write(d.toString());
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rej(new Error(`failed to start ${DSH_BIN}: ${e.message}`));
    });
  });
}

function findChrome() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const cache = join(process.env.HOME, ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
      .sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const p = join(cache, dirs[i], "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no chromium found: run `npx playwright install chromium` or set E2E_CHROME");
}

// ── browser driver ─────────────────────────────────────────────────────────

// One fresh context = one clean landing state, so every workspace opens the
// same "Choose workspace" hero flow regardless of what earlier sessions did.
async function openSession(browser, { url, workspace }) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const session = { context, page, errors: [], pageErrors: [] };
  page.on("pageerror", (e) => session.pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") session.errors.push(m.text()); });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // "Add workspace" is present on both the initial landing and post-session heroes,
    // whereas "Choose workspace" only appears when no workspace is yet selected.
    await page.getByRole("button", { name: "Add workspace" }).click({ timeout: 15_000 });
    const dialog = page.locator('[class*="_dialog_"]').first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    // The picker's Miller-columns navigation is slow to script; its crumb-bar
    // path editor jumps straight to an absolute path.
    await dialog.locator(".ZuhsRW_crumbEditZone").click();
    const input = dialog.locator("input").last();
    await input.waitFor({ state: "visible", timeout: 5000 });
    await input.fill(workspace);
    await input.press("Enter");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Open" }).click();
    await page.waitForTimeout(3000);
    // A session only gets its conversation pane (with the view tabs) once a
    // turn exists; send one. This is the one real model call per workspace.
    const ta = page.locator("textarea").first();
    await ta.waitFor({ state: "visible", timeout: 15_000 });
    await ta.click();
    await ta.type("hello");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForFunction(() => {
      const tl = document.querySelector('[role="tablist"]');
      return !!tl && [...tl.querySelectorAll('[role="tab"]')].some((t) => t.textContent.includes("Files"));
    }, { timeout: 90_000 });
  } catch (e) {
    await context.close().catch(() => {});
    throw new Error(`openSession(${workspace}): ${e.message}`);
  }
  return session;
}

async function clickFilesTab(page) {
  await page.locator('[role="tab"]', { hasText: "Files" }).click();
  await page.locator(".dswFiles_root").waitFor({ state: "visible", timeout: 15_000 });
}

// The Files view's stable, ours-namespace selectors.
function ui(page) {
  const root = () => page.locator(".dswFiles_root");
  const rowNames = () => page.locator(".dswFiles_rowName").allTextContents();
  const row = (name) => page.locator(".dswFiles_row", {
    has: page.locator(".dswFiles_rowName", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
  const previewText = async () => (await root().locator(".dswFiles_previewPane").innerText().catch(() => "")) ?? "";
  // A failed fetch renders the note both in the list area (where the loading
  // status would be) and at the root, so target the first.
  const errorNote = () => root().locator(".dswFiles_error").first();
  const until = async (fn, what, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
      await page.waitForTimeout(250);
    }
  };
  return { page, root, rowNames, row, previewText, errorNote, until };
}

// Enter an absolute path through the breadcrumb's ✎ editor.
async function editPath(u, path) {
  await u.root().locator(".dswFiles_crumbEditZone").click();
  const input = u.root().locator(".dswFiles_pathInput");
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill(path);
  await input.press("Enter");
}

// After a rejected path edit the crumb trail can hold the bad segments; the
// root crumb (always segments[0]) resets the listing to the workspace root.
async function backToRoot(u) {
  await u.root().locator(".dswFiles_crumb").first().click();
  await u.until(async () => (await u.rowNames()).includes("a.txt"), "back at fj root");
}

function checkConsole(session, label) {
  const ours = session.errors.filter((t) => /filez|filestab|dswFiles/i.test(t));
  ok(session.pageErrors.length === 0, `no uncaught page errors (${label})\n` + session.pageErrors.join("\n").slice(0, 800));
  ok(ours.length === 0, `no filestab console errors (${label})\n` + ours.join("\n").slice(0, 800));
  const benign = session.errors.length - ours.length;
  if (benign > 0) console.log(`e2e: ${label}: ${benign} benign console error(s) ignored`);
}

// ── journeys (the journey section headers below) ───────────────────────────────────────

// J1: first look -- listing, jj status line, rollup, empty preview.
async function j1_firstLook(u) {
  const sel = u.root().locator(".dswFiles_statusSelect");
  await u.until(async () => (await sel.count()) > 0, "jj status line");
  const firstOpt = (await sel.locator("option").first().textContent()).trim();
  match(firstOpt, /^@ [0-9a-z]{12} base$/, `jj worktree row = @ + 12-char change id + description, got: ${firstOpt}`);
  const count = await u.root().locator(".dswFiles_statusCount").innerText();
  match(count, /7/, `worktree rollup counts the 7 additions, got: ${count}`);
  const names = await u.rowNames();
  for (const n of ["sub", "a.txt", "big.bin", "doc.md", "page.html", "pic.png", "sneaky"]) {
    ok(names.includes(n), `row ${n} present (have: ${names.join(", ")})`);
  }
  ok(!names.includes(".jj") && !names.includes(".git"), `hidden entries absent by default (have: ${names.join(", ")})`);
  eq((await u.row("a.txt").locator(".dswFiles_badge").innerText()).trim(), "A", "a.txt carries the A (added) badge");
  const footer = await u.root().locator(".dswFiles_footerBar").innerText();
  ok(footer.includes("7 items"), `footer counts 7 items, got: ${footer.replace(/\n/g, " ")}`);
  ok((await u.previewText()).includes("Select a file to preview"), "preview starts empty");
}

// J2: navigate -- folder rows, breadcrumbs, the path editor (valid + escape
// rejected), hidden toggle, keyboard up.
async function j2_navigation(u) {
  await u.row("sub").click();
  await u.until(async () => { const n = await u.rowNames(); return n.includes("nested.txt") && !n.includes("a.txt"); }, "into sub/");
  eq((await u.rowNames()).length, 1, "sub/ lists only nested.txt");
  const crumbs = u.root().locator(".dswFiles_crumb");
  eq(await crumbs.count(), 2, "crumb trail: root › sub");
  eq((await crumbs.last().textContent()).trim(), "sub", "current crumb is sub");
  ok(await crumbs.last().isDisabled(), "current crumb is disabled");
  // Up through the breadcrumb.
  await crumbs.first().click();
  await u.until(async () => (await u.rowNames()).includes("a.txt"), "breadcrumb back to root");
  // Path editor: a valid relative path navigates.
  await editPath(u, "sub");
  await u.until(async () => (await u.rowNames()).includes("nested.txt"), "path edit into sub/");
  // Path editor: an escape is rejected with an error note, nothing outside
  // the workspace is ever shown.
  await editPath(u, "../../etc");
  await u.until(async () => (await u.errorNote().count()) > 0 && ((await u.errorNote().innerText()).trim() !== ""), "escape rejected");
  ok(!(await u.previewText()).includes("root:"), "no /etc content after rejected escape");
  await backToRoot(u);
  // Hidden files toggle.
  await u.root().locator(".dswFiles_showHiddenToggle").click();
  await u.until(async () => (await u.rowNames()).includes(".jj"), "hidden entries visible");
  await u.root().locator(".dswFiles_showHiddenToggle").click();
  await u.until(async () => !(await u.rowNames()).includes(".jj"), "hidden entries hidden again");
  // Keyboard: ArrowLeft from a row inside sub/ goes up one level.
  await u.row("sub").click();
  await u.until(async () => (await u.rowNames()).includes("nested.txt"), "into sub/ for keyboard nav");
  await u.row("nested.txt").focus();
  await u.page.keyboard.press("ArrowLeft");
  await u.until(async () => (await u.rowNames()).includes("a.txt"), "ArrowLeft up one level");
}

// The pane defaults to Diff mode for a VCS-changed file; the content preview
// only renders after flipping to View mode (the toggle exists for any
// selected file, and clicking an already-active mode is a no-op).
async function viewMode(u) {
  const btn = u.root().locator(".dswFiles_paneToggleBtn", { hasText: /^View$/ });
  if (await btn.count() > 0) await btn.first().click();
}

// J3: text preview in pane; the >1MB file stays a card, never a byte dump.
async function j3_textPreview(u) {
  await u.row("a.txt").click();
  await viewMode(u);
  await u.until(async () => (await u.root().locator(".dswFiles_previewText").count()) > 0, "a.txt text preview rendered");
  const pre = await u.root().locator(".dswFiles_previewText").innerText();
  ok(pre.includes("one") && pre.includes("two"), `a.txt raw text in pane, got: ${JSON.stringify(pre.slice(0, 60))}`);
  await u.row("big.bin").click();
  await viewMode(u);
  await u.until(async () => {
    const t = await u.previewText();
    return t.includes("binary file") || t.includes("Couldn't preview");
  }, "big.bin stays a card");
  const t = await u.previewText();
  ok(t.length < 2000, "big.bin preview is a card, not a 2MB byte dump");
}

// J4: markdown — with nothing diffable (a VCS-less workspace) the preview is
// the DEFAULT and renders: heading, bold, list, GFM table. A javascript: link
// must not become an anchor (markdown-it's link validator drops it, the text
// stays visible). A mermaid fence becomes a sealed frame holding an SVG.
// View shows the raw source (fence markers) and unmounts the frame; toggling
// back renders again.
async function j4_markdown(u) {
  await u.row("doc.md").click();
  const md = u.root().locator(".dswFiles_previewMarkdown");
  await u.until(async () => (await md.count()) > 0, "markdown preview is the default (no diff available)");
  eq(await md.locator("h1").count(), 1, "md: heading rendered");
  ok(await md.locator("strong").count() >= 1, "md: bold rendered");
  ok(await md.locator("li").count() >= 1, "md: list rendered");
  eq(await md.locator("table").count(), 1, "md: GFM table rendered");
  eq(await md.locator('a[href^="javascript:"]').count(), 0, "md: javascript: link is not an anchor");
  ok((await md.innerText()).includes("js link"), "md: the dropped link's text stays visible");
  // Mermaid fence → sealed frame, the SVG rendered INSIDE the frame.
  const frame = u.root().locator(".dswFiles_mermaidFrame");
  await u.until(async () => {
    if (await frame.count() === 0) return false;
    const f = frame.first().contentFrame(); // sync: Frame | null
    return f ? (await f.locator("svg").count().catch(() => 0)) > 0 : false;
  }, "mermaid SVG inside the sealed frame", 30_000);
  // View → raw source (fence markers visible), the frame unmounts.
  await viewMode(u);
  const raw = u.root().locator(".dswFiles_previewText");
  await u.until(async () => (await raw.count()) > 0, "view mode: raw markdown source");
  ok((await raw.innerText()).includes("```mermaid"), "raw source shows the fence markers");
  eq(await frame.count(), 0, "mermaid frame unmounted in view mode");
  // Back to Preview: rendered again (the bytes were already fetched).
  await u.root().locator(".dswFiles_paneToggleBtn", { hasText: /^Preview$/ }).first().click();
  await u.until(async () => (await md.count()) > 0, "back to preview renders again");
}

// J5: HTML — the RAW view is the default (rendering HTML executes scripts:
// an explicit opt-in). In the sealed preview the sandbox script runs IN the
// frame only: it changes the frame's title, is blocked from writing the
// parent (opaque origin), its fetch is blocked by the frame's CSP, and its
// timer stops when the iframe unmounts.
async function j5_htmlSandbox(u) {
  const page = u.page;
  let cspProbeHits = 0;
  page.on("request", (r) => { if (r.url().includes("csp-probe")) cspProbeHits++; });
  // Receive the frame's tick postMessages in the app origin.
  await page.evaluate(() => {
    window.addEventListener("message", (e) => {
      const d = e && e.data;
      if (d && typeof d.filezProbeTick === "number") window.__lastTick = d.filezProbeTick;
    });
  });
  const appTitle = await page.title();
  await u.row("page.html").click();
  // Raw source is the default. The wait must be content-aware: the previous
  // file's view-mode <pre> is still in the DOM while the new fetch is in
  // flight, so existence alone returns instantly on stale content.
  const raw = u.root().locator(".dswFiles_previewText");
  await u.until(async () => ((await raw.innerText().catch(() => "")) ?? "").includes("<!doctype html>"), "html raw view is the default");
  ok((await raw.innerText()).includes("<script>"), "raw HTML source is visible");
  eq(await u.root().locator(".dswFiles_previewHtml").count(), 0, "no iframe before the opt-in");
  // Opt in to the sealed render.
  await u.root().locator(".dswFiles_paneToggleBtn", { hasText: /^Preview$/ }).first().click();
  const iframe = u.root().locator(".dswFiles_previewHtml");
  await iframe.waitFor({ state: "visible", timeout: 15_000 });
  ok(((await u.root().locator(".dswFiles_previewHtmlNote").innerText()) ?? "").length > 0, "sealed-render note shown");
  // The real Frame (evaluate/title live there); locator.contentFrame() only
  // gives a FrameLocator, which cannot evaluate.
  const f = await (await iframe.elementHandle()).contentFrame();
  ok(!!f, "the preview iframe has a content frame");
  await u.until(async () => (await f.evaluate("window.__ran").catch(() => false)), "sandbox script ran in the frame");
  eq(await f.evaluate("document.title").catch(() => null), "rendered-ok", "frame title changed by the sandbox script");
  eq(await page.title(), appTitle, "app title unchanged (the script cannot reach the app)");
  const probe = await f.evaluate("window.__probeResult");
  ok(String(probe).startsWith("parent-write-blocked"), `opaque origin blocked the parent write, got: ${probe}`);
  eq(await page.evaluate("window.__filezProbe"), undefined, "no parent property leaked into the app");
  // The timer ticks while the frame is alive, and stops after unmount.
  await u.until(async () => ((await page.evaluate("window.__lastTick")) ?? 0) >= 2, "frame timer ticking (postMessage)");
  const t1 = await page.evaluate("window.__lastTick");
  ok(typeof t1 === "number" && t1 >= 2, "ticks observed before unmount");
  await u.row("hi.txt").click();
  await u.until(async () => (await u.root().locator(".dswFiles_previewHtml").count()) === 0, "html iframe unmounted");
  await page.waitForTimeout(400);
  eq(await page.evaluate("window.__lastTick"), t1, "timer stopped: no ticks after unmount");
  eq(cspProbeHits, 0, "CSP blocked the fetch (no request left the frame)");
}

// J6: a PNG renders in pane from a data: URL (no HTTP file route).
async function j6_imagePreview(u) {
  await u.row("pic.png").click();
  await viewMode(u);
  const img = u.root().locator(".dswFiles_previewImage");
  await img.waitFor({ state: "visible", timeout: 15_000 });
  ok(((await img.getAttribute("src")) ?? "").startsWith("data:image/png;base64,"), "PNG rendered from a data: URL");
}

// J18: every path-escape shape is rejected; the outside symlink is listed
// but its read is refused.
async function j18_containment(u) {
  for (const p of ["../outside.txt", "/etc/passwd", "..%2F..%2Fetc%2Fpasswd"]) {
    await editPath(u, p);
    await u.until(async () => (await u.errorNote().count()) > 0 && ((await u.errorNote().innerText()).trim() !== ""), `reject ${p}`);
    ok(!(await u.previewText()).includes("root:") && !(await u.previewText()).includes("secret"), `${p}: no escaped content shown`);
    await backToRoot(u);
  }
  ok((await u.rowNames()).includes("sneaky"), "outside symlink is still listed");
  await u.row("sneaky").click();
  // The file is diffable (status A), so the pane opens in Diff mode and the
  // containment rejection surfaces as the diff error, not the preview error.
  await u.until(async () => (await u.previewText()).includes("symlink escapes workspace"), "sneaky read refused");
  ok(!(await u.previewText()).includes("root:"), "sneaky: no /etc/passwd content");
}

// J19: the left pane (browse list) collapses to give the preview and diff the
// full width; the toggle lives in the header so it stays reachable while the
// pane is hidden, and the collapsed state persists across a reload.
async function j19_collapse(u) {
  const btn = u.root().locator(".dswFiles_collapseBtn");
  eq(await btn.count(), 1, "collapse toggle in the header");
  eq(await u.root().locator(".dswFiles_browsePane").count(), 1, "browse pane visible initially");
  await btn.click();
  eq(await u.root().locator(".dswFiles_browsePane").count(), 0, "browse pane hidden when collapsed");
  eq(await u.root().locator(".dswFiles_divider").count(), 0, "divider hidden when collapsed");
  await btn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 1, "browse pane restored");
  // Persistence: collapse, reload, still collapsed.
  await btn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 0, "collapsed again");
  await u.page.reload({ waitUntil: "domcontentloaded" });
  await u.until(async () => (await u.root().count()) === 1, "Files tab back after reload", 30_000);
  eq(await u.root().locator(".dswFiles_browsePane").count(), 0, "collapsed state survives reload");
  // Leave it expanded for any later journeys.
  await btn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 1, "restored for later journeys");
}

// J1.2: a workspace with no VCS -- same layout, no status line, no badges.
async function j1_2_plain(u) {
  await u.until(async () => (await u.rowNames()).includes("hi.txt"), "plain listing");
  eq(await u.root().locator(".dswFiles_statusLine").count(), 0, "no VCS status line without a repo");
  eq((await u.root().locator(".dswFiles_row .dswFiles_badge").first().innerText()).trim(), "", "no change badges without VCS");
  const footer = await u.root().locator(".dswFiles_footerBar").innerText();
  ok(footer.includes("3 items"), `footer counts 3 items, got: ${footer.replace(/\n/g, " ")}`);
  ok((await u.previewText()).includes("Select a file to preview"), "preview starts empty");
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  // Fail loud and cheap (before any boot or model call) if dsh moved on.
  checkDshVersion();
  const root = join(tmpdir(), `filestab-e2e-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  let dsh = null;
  let browser = null;
  try {
    const home = makeScratchHome(root);
    const fx = makeFixtures(root);
    console.log(`e2e: scratch home ${home}`);
    dsh = await bootDsh(home);
    const url = `http://127.0.0.1:${dsh.port}`;
    console.log(`e2e: dsh web on ${url}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

    // F-JJ session: J1, J2, J3, J6, J18.
    const a = await openSession(browser, { url, workspace: fx.fj });
    const ua = ui(a.page);
    await clickFilesTab(a.page);
    console.log("e2e: J1 first look (jj workspace)");
    await j1_firstLook(ua);
    console.log("e2e: J2 navigate (folders, crumbs, path editor, hidden, keys)");
    await j2_navigation(ua);
    console.log("e2e: J3 text preview (+ >1MB card)");
    await j3_textPreview(ua);
    console.log("e2e: J6 image preview");
    await j6_imagePreview(ua);
    console.log("e2e: J18 path-escape containment");
    await j18_containment(ua);
    console.log("e2e: J19 left-pane collapse/expand");
    await j19_collapse(ua);
    checkConsole(a, "fj");
    await a.context.close();

    // F-PLAIN session: J1.2.
    const b = await openSession(browser, { url, workspace: fx.plain });
    const ub = ui(b.page);
    await clickFilesTab(b.page);
    console.log("e2e: J1.2 first look (no VCS)");
    await j1_2_plain(ub);
    console.log("e2e: J4 markdown preview (plain workspace)");
    await j4_markdown(ub);
    console.log("e2e: J5 html sandboxed preview (plain workspace)");
    await j5_htmlSandbox(ub);
    checkConsole(b, "plain");
    await b.context.close();

    console.log(`e2e: PASS -- ${assertions} assertions across J1, J1.2, J2, J3, J4, J5, J6, J18, J19`);
  } catch (e) {
    // Best-effort failure screenshot, then clean up and rethrow.
    const pages = browser ? [...browser.contexts().flatMap((c) => c.pages())] : [];
    for (const p of pages) {
      mkdirSync(OUT_DIR, { recursive: true });
      await p.screenshot({ path: join(OUT_DIR, "e2e-failure.png") }).catch(() => {});
    }
    if (pages.length) console.log(`e2e: failure screenshot: ${join(OUT_DIR, "e2e-failure.png")}`);
    console.error(`e2e: FAIL after ${assertions} assertions:`);
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dsh) dsh.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

main();
