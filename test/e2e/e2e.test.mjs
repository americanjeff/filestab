// test/e2e/e2e.test.mjs, end-to-end journeys against a sandboxed dsh instance
// driven by a real headless browser (playwright-core + a playwright chromium).
//
// Scope: the Files view journeys J1, J1.2, J3, J4, J5, J6, J7, J8, J19, J20 (each
// defined by its section header below). On 0.1.5 the Files view is the dsh RIGHT PANE
// (filestab serves the files slot; the conversation area has no Files tab), so
// openSession opens that pane via the host's own expand button.
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
const DSH_VERSION = "0.1.5-rc.2";
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
  // F-JJ: one described commit ("base") + a dirty worktree with 6 visible
  // entries, incl. a 2 MB random file over FILE_SHOW_CAP (J3).
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
  // F-PLAIN: no VCS at all (J1.2, J4, J5). Without VCS nothing is diffable,
  // so pane defaults resolve to the non-diff branches (markdown -> preview,
  // html -> raw view) exactly as the journeys describe.
  fx.plain = join(fx.root, "plain");
  mkdirSync(fx.plain, { recursive: true });
  writeFileSync(join(fx.plain, "hi.txt"), "hi\n");
  // J4: markdown — heading, bold, list, a GFM table, a javascript: link
  // (markdown-it's default link validator must drop it, text stays visible),
  // a PLAIN paragraph (renders 1:1 to source → the click ref carries a
  // column), and a mermaid fence (J5's frame assertions).
  writeFileSync(join(fx.plain, "doc.md"),
    "# Doc\n\nA **bold** para.\n\n- item\n\n" +
    "| h1 | h2 |\n| -- | -- |\n| a  | b  |\n\n" +
    "[js link](javascript:alert(1))\n\n" +
    "plain paragraph line\n\n" +
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
  // F-JJ-20: J20's own fresh jj session — a FIRST mount of the Files view
  // (no nav cache, no earlier journey on the page), the exact case where a
  // dead tick interval stays dead. Kept separate from fj so J20's disk
  // mutations (a.txt edit, fresh.txt) can't disturb the pinned fj journeys.
  fx.fj20 = join(fx.root, "fj20");
  mkdirSync(fx.fj20, { recursive: true });
  execFileSync("jj", ["git", "init"], { cwd: fx.fj20 });
  execFileSync("jj", ["new", "-m", "base"], { cwd: fx.fj20 });
  writeFileSync(join(fx.fj20, "a.txt"), "one\ntwo\n");
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
      // 0.1.5 prints the browser URL with a one-time-auth token; the token
      // exchanges for a persistent signed cookie on first load, and a fresh
      // context (no cookie) re-uses the same token, so keep the FULL url.
      const m = d.toString().match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        res({ port: Number(m[1].match(/:(\d+)/)[1]), url: m[1], stop });
      }
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
    // 0.1.5: the composer is a contenteditable div (not a textarea) and the
    // conversation view tabs (Chat / Trajectory) mount after the first turn.
    const ta = page.locator(".uV2eYG_input").last();
    await ta.waitFor({ state: "visible", timeout: 15_000 });
    await ta.click();
    await ta.pressSequentially("hello");
    await page.getByRole("button", { name: "Send message" }).click();
    // 0.1.5: the Files surface is the dsh RIGHT PANE, not a conversation tab
    // (the conversation area no longer registers a Files tab). The first turn
    // builds the conversation pane; the right pane is collapsed and is opened
    // by the host's own expand button in the conversation header corner.
    // filestab serves the files slot, so opening the pane lands on the Files
    // view directly. Poll (evaluate, not waitForFunction) to dodge the
    // arg/options positional trap.
    console.log(`openSession(${workspace.split("/").pop()}): hello sent, waiting for the conversation + right-pane expand button`);
    const t0 = Date.now();
    for (;;) {
      const ready = await page.evaluate(() => {
        const exp = document.querySelector('[data-sidebar-right-expand]');
        const conv = document.querySelector('[role="tablist"]');
        return !!conv && !!exp; // conversation built + pane collapsed
      }).catch(() => false);
      if (ready) break;
      if (Date.now() - t0 > 180_000) throw new Error("timeout waiting for the conversation + right-pane expand button");
      await page.waitForTimeout(500);
    }
    await page.locator('[data-sidebar-right-expand]').click();
  } catch (e) {
    // Capture the page state before closing the context, so a failure here
    // (driving dsh's own UI) is diagnosable after the scratch tree is gone.
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({ path: join(OUT_DIR, `openSession-failure-${workspace.split("/").pop()}.png`) });
    } catch { /* the screenshot is best-effort */ }
    await context.close().catch(() => {});
    throw new Error(`openSession(${workspace}): ${e.message}`);
  }
  return session;
}

// 0.1.5: there is no conversation Files tab — openSession opened the right
// pane (filestab serves the files slot), so the Files view is already the
// pane's content. Just wait for it to be visible.
async function clickFilesTab(page) {
  await page.locator(".dswFiles_root").waitFor({ state: "visible", timeout: 20_000 });
}

// The Files view's stable, ours-namespace selectors.
function ui(page) {
  const root = () => page.locator(".dswFiles_root");
  const rowNames = () => page.locator(".dswFiles_name").allTextContents();
  const row = (name) => page.locator(".dswFiles_row", {
    has: page.locator(".dswFiles_name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
  const previewText = async () => (await root().locator(".dswFiles_previewPane").innerText().catch(() => "")) ?? "";
  const until = async (fn, what, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
      await page.waitForTimeout(250);
    }
  };
  return { page, root, rowNames, row, previewText, until };
}

function checkConsole(session, label) {
  const ours = session.errors.filter((t) => /filez|filestab|dswFiles/i.test(t));
  // A dsh host bug (dsh BUG-028), not filestab's: a full page reload re-runs
  // the client bundles' slot registration against a slot registry that
  // survives the reload, and dsh-client-ui-tool's keyed "read_image" toolview
  // entry throws. Filter the EXACT message (J19's reload step trips it) so a
  // fix upstream shows up here as a new, unfiltered page error.
  const dshReloadNoise = session.pageErrors.filter((t) =>
    t.includes('keyed slot "tool.call.toolview" already has an entry for key "read_image"'));
  const hostBugs = session.pageErrors.filter((t) =>
    !t.includes('keyed slot "tool.call.toolview" already has an entry for key "read_image"'));
  ok(hostBugs.length === 0, `no uncaught page errors (${label})\n` + hostBugs.join("\n").slice(0, 800));
  if (dshReloadNoise.length > 0) console.log(`e2e: ${label}: ${dshReloadNoise.length} dsh reload-registration page error(s) ignored (host bug, filtered)`);
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
  match(count, /6/, `worktree rollup counts the 6 additions, got: ${count}`);
  const names = await u.rowNames();
  for (const n of ["sub", "a.txt", "big.bin", "doc.md", "page.html", "pic.png"]) {
    ok(names.includes(n), `row ${n} present (have: ${names.join(", ")})`);
  }
  ok(!names.includes(".jj") && !names.includes(".git"), `hidden entries absent by default (have: ${names.join(", ")})`);
  eq((await u.row("a.txt").locator(".dswFiles_badge").innerText()).trim(), "U", "a.txt carries the U (unadded) badge (a jj worktree add IS the unadded state)");
  const footer = await u.root().locator(".dswFiles_footerBar").innerText();
  ok(footer.includes("6 items"), `footer counts 6 items, got: ${footer.replace(/\n/g, " ")}`);
  ok((await u.previewText()).includes("Select a file to preview"), "preview starts empty");
}

// Defensive no-op helper from the diff-default era: a selected file now
// opens as its CONTENT (view/preview) by default, so the View button is
// usually already active (clicking an already-active mode is a no-op).
// Kept for the journeys that call it — it stays correct if the default
// ever flips back.
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

// J8: click → ref in the head row. A single click on a line morphs the head
// row into the EXACT pasteable token (no selection → no text), and the copy
// button puts that very string on the clipboard. A drag-selection supersedes
// the click ref — and the selection ref always carries the selected text.
// The insert commits the ref into the composer draft (exactly, deduped,
// caret moved to the composer) — and exits fullscreen first when the right
// bar is covering the conversation. Right-clicks are no longer intercepted
// (the browser's native context menu is back — no custom menu appears).
async function j8_clickRef(u) {
  const root = u.root();
  await u.row("a.txt").click();
  await u.until(async () => (await root.locator("pre.dswFiles_previewText").count()) > 0, "a.txt text preview");
  // At rest: the path (dim dir + name), no token, no ref buttons.
  await u.until(async () => (await root.locator(".dswFiles_paneHeadPath").count()) === 1, "head row at rest");
  eq((await root.locator(".dswFiles_paneHeadPath").innerText()).trim(), "a.txt", "at rest shows the workspace-relative path");
  eq(await root.locator(".dswFiles_paneHeadToken").count(), 0, "no ref token at rest");
  // The action cluster hugs the path (a 6px flex gap) — flush right would
  // read as "acts on the file", not "acts on the ref".
  const pathBox = await root.locator(".dswFiles_paneHeadPath").boundingBox();
  const btnBox = await root.locator(".dswFiles_paneHeadBtns").boundingBox();
  ok(btnBox.x - (pathBox.x + pathBox.width) <= 10, `the button cluster sits next to the path (gap ${Math.round(btnBox.x - pathBox.x - pathBox.width)}px)`);
  // The hover text names the ACTION the click will take (the payload is
  // what the row shows).
  eq((await root.locator(".dswFiles_paneHeadBtns button").getAttribute("title")), "Copy path", "at rest the copy button's tooltip names the path action");
  const pre = root.locator("pre.dswFiles_previewText");
  const box = await pre.boundingBox();
  // Click line 1 (pre padding 8px, line-height 18px → y+10 is inside line 1).
  await u.page.mouse.click(box.x + 12, box.y + 10);
  await u.until(async () => (await root.locator(".dswFiles_paneHeadToken").count()) === 1, "click on a line → the ref token in the head row");
  const token = await root.locator(".dswFiles_paneHeadToken").getAttribute("title");
  match(token, /^@a\.txt:1:\d+$/, `the head row shows the exact pasteable token (raw click = line + column), got: ${token}`);
  eq(await root.locator(".dswFiles_paneHeadBtns button[aria-label='Copy ref']").getAttribute("title"), "Copy ref", "with a ref the copy button's tooltip names the ref action");
  eq(await root.locator(".dswFiles_paneHeadBtns button[aria-label='Add ref to chat']").getAttribute("title"), "Add ref to chat", "the insert button's tooltip names the insert action");
  // The copy button puts that EXACT string on the clipboard.
  await u.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(u.page.url()).origin });
  await root.locator(".dswFiles_paneHeadBtns button[aria-label='Copy ref']").click();
  eq(await u.page.evaluate(() => navigator.clipboard.readText()), token, "copy ref → the head row's exact token on the clipboard");
  // A right-click no longer opens any filestab menu (the native menu is the browser's).
  await u.page.mouse.click(box.x + 12, box.y + 10, { button: "right" });
  await u.page.waitForTimeout(300);
  eq(await root.locator(".dswFiles_ctxMenu").count(), 0, "right-click is not intercepted (no custom menu)");
  // A drag-selection across lines 1–2 supersedes the click ref — and, per
  // the gesture rule, the selection ref ALWAYS carries the selected text.
  await u.page.mouse.move(box.x + 12, box.y + 10);
  await u.page.mouse.down();
  await u.page.mouse.move(box.x + 12, box.y + 30, { steps: 4 });
  await u.page.mouse.up();
  await u.until(async () => {
    const tk = await root.locator(".dswFiles_paneHeadToken").getAttribute("title").catch(() => null);
    return tk && tk.includes("-") && tk.includes('"');
  }, "drag → a range token with the selected text supersedes the click ref");
  const range = await root.locator(".dswFiles_paneHeadToken").getAttribute("title");
  match(range, /^@a\.txt:1-\d+ "[\s\S]*"$/, `the selection ref is a range from line 1 with the selected text, got: ${range}`);
  // COMMIT: the insert lands the exact ref in the composer, moves the caret
  // there, and a repeat click is a no-op (the dedupe).
  await u.page.mouse.click(box.x + 12, box.y + 10); // a fresh click ref (the drag's selection is gone)
  await u.until(async () => {
    const tk = await root.locator(".dswFiles_paneHeadToken").getAttribute("title").catch(() => null);
    return tk === token;
  }, "the click ref is back (no selection → no text)");
  const insertBtn = root.locator(".dswFiles_paneHeadBtns button[aria-label='Add ref to chat']");
  const composer = () => u.page.locator("[data-composer-input]");
  await insertBtn.click();
  await u.until(async () => {
    const txt = await composer().textContent().catch(() => "");
    return (txt || "").includes(token);
  }, "the ref lands in the composer draft");
  eq(await composer().textContent(), token + " ", "the draft is exactly the ref + its trailing space");
  ok(await u.page.evaluate(() => !!document.activeElement && document.activeElement.hasAttribute("data-composer-input")), "the composer holds the caret after the insert");
  await insertBtn.click();
  await u.page.waitForTimeout(150);
  eq(await composer().textContent(), token + " ", "a repeat insert is a no-op (the dedupe)");
  // Fullscreen: the right bar IS the window — the composer is mounted but
  // covered. The insert hands the window back through the host's own exit
  // control first, then commits and focuses.
  await u.page.locator('[data-sidebar-right-mode="fullscreen"]').first().click();
  await u.until(async () => (await u.page.locator('[data-sidebar-right-panel="fullscreen"]').count()) === 1, "the right bar enters fullscreen");
  await u.page.waitForTimeout(300); // let the width transition settle before taking coordinates
  const box2 = await root.locator("pre.dswFiles_previewText").boundingBox();
  await u.page.mouse.click(box2.x + 12, box2.y + 28); // line 2
  await u.until(async () => {
    const tk = await root.locator(".dswFiles_paneHeadToken").getAttribute("title").catch(() => null);
    return !!tk && tk.startsWith("@a.txt:2:");
  }, "line 2's ref resolves in fullscreen (with its column)");
  const token2 = await root.locator(".dswFiles_paneHeadToken").getAttribute("title");
  await root.locator(".dswFiles_paneHeadBtns button[aria-label='Add ref to chat']").click();
  await u.until(async () => (await u.page.locator('[data-sidebar-right-panel="fullscreen"]').count()) === 0, "the insert exits fullscreen");
  await u.until(async () => {
    const txt = await composer().textContent().catch(() => "");
    return (txt || "").includes(token2);
  }, "line 2's ref lands in the composer");
  eq(await composer().textContent(), token + " " + token2 + " ", "both refs in the draft, one space apart");
  ok(await u.page.evaluate(() => !!document.activeElement && document.activeElement.hasAttribute("data-composer-input")), "the composer holds the caret after the fullscreen insert");
  // Switching the file clears the ref back to the at-rest path.
  await u.row("big.bin").click();
  await u.until(async () => (await root.locator(".dswFiles_paneHeadPath").count()) === 1, "big.bin head row back at rest");
  eq((await root.locator(".dswFiles_paneHeadPath").innerText()).trim(), "big.bin", "file switch → at-rest path, no stale ref");
  eq(await root.locator(".dswFiles_paneHeadToken").count(), 0, "file switch clears the ref token");
}

// J7: the SOFT-STICKY diff preference. A fresh selection opens as its
// content (view/preview) — never as a diff, even for a VCS-changed file.
// An explicit Diff pick ARMS the preference for the session, so the next
// diffable selection starts in Diff with no click. An explicit View/Preview
// pick disarms it (the last explicit choice wins). The preference is
// in-memory only: a page reload drops it even while armed (J7's final
// step), so a fresh load starts content-default again.
async function j7_stickyDiff(u) {
  const btn = (label) => u.root().locator(".dswFiles_paneToggleBtn", { hasText: new RegExp("^" + label + "$") });
  const activeBtn = (label) => u.root().locator(".dswFiles_paneToggleBtnActive", { hasText: new RegExp("^" + label + "$") });
  const rawText = () => u.root().locator(".dswFiles_previewText").innerText().catch(() => "").then((t) => t ?? "");
  // 1) A fresh selection of a VCS-changed file opens as its content.
  await u.row("a.txt").click();
  await u.until(async () => (await rawText()).includes("one"), "a.txt opens in view by default (not diff)");
  eq(await u.root().locator(".dswFiles_diff").count(), 0, "a fresh selection never starts in diff");
  eq(await activeBtn("View").count(), 1, "View is the default active mode for a diffable text file");
  // 2) The explicit Diff pick arms the soft-sticky preference.
  await btn("Diff").first().click();
  await u.until(async () => (await u.root().locator(".dswFiles_diff").count()) === 1, "a.txt renders its diff after the explicit pick");
  eq(await activeBtn("Diff").count(), 1, "Diff is active after the pick");
  // 3) The NEXT diffable selection starts in Diff — the stick, no click.
  await u.row("doc.md").click();
  await u.until(async () => (await u.root().locator(".dswFiles_diff").count()) === 1, "doc.md opens in Diff via the soft-sticky preference");
  eq(await activeBtn("Diff").count(), 1, "Diff is active on the sticky selection without a click");
  // 4) An explicit View pick disarms it (last explicit choice wins).
  await btn("View").first().click();
  await u.until(async () => (await rawText()).includes("# Doc"), "View shows doc.md's raw source");
  // 5) The next selection is back to the content default.
  await u.row("page.html").click();
  await u.until(async () => (await rawText()).includes("<!doctype html>"), "page.html opens as raw view (preference disarmed)");
  eq(await u.root().locator(".dswFiles_diff").count(), 0, "no diff after the disarming View pick");
  eq(await activeBtn("View").count(), 1, "View is active again");
  // 6) Re-arm, and the stick holds through a binary (image) file.
  await btn("Diff").first().click();
  await u.until(async () => (await u.root().locator(".dswFiles_diff").count()) === 1, "page.html renders its diff after the re-arm");
  await u.row("pic.png").click();
  await u.until(async () => (await u.root().locator(".dswFiles_diffBinaryRow").count()) === 1, "pic.png opens in Diff (the stick holds through a binary)");
  // 7) A page reload DROPS the preference (in-memory, never persisted): the
  //    restored selection (pic.png, J7's last pick) starts as content.
  await u.page.reload({ waitUntil: "domcontentloaded" });
  const expand = u.page.locator('[data-sidebar-right-expand]');
  await u.until(async () => (await expand.count()) > 0, "conversation back after reload", 30_000);
  await expand.click();
  await u.until(async () => (await u.root().count()) === 1, "Files view back after reload", 30_000);
  await u.until(async () => (await u.root().locator(".dswFiles_previewImage").count()) === 1, "the restored pic.png renders as content after reload");
  eq(await u.root().locator(".dswFiles_diff").count(), 0, "the reload dropped the armed preference (no diff on restore)");
  eq(await activeBtn("View").count(), 1, "View is active on the restored selection");
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
  // Line refs in the RENDERED preview: filestab owns the markdown render, so
  // it stamps each content block with its source line — a click resolves to
  // the line (plus the column when the rendered text maps 1:1 onto the
  // source), a selection to the line range. Formatted blocks (heading, bold,
  // list, table) can't map rendered columns onto source columns — stripped
  // markup shifts them — and stay line-only, never a wrong number.
  // Fixture lines: 1:# Doc  3:A **bold** para.  5:- item  9:| a | b |
  //                13:plain paragraph line
  const token = u.root().locator(".dswFiles_paneHeadToken");
  const title = () => token.getAttribute("title").catch(() => null);
  await md.locator("h1").click();
  await u.until(async () => (await title()) === "@doc.md:1", "click the heading → its line");
  eq(await title(), "@doc.md:1", "md: formatted heading → line ref only (the # shifts the columns)");
  await md.locator("strong").click();
  await u.until(async () => (await title()) === "@doc.md:3", "click the paragraph → its line");
  eq(await title(), "@doc.md:3", "md: formatted paragraph → line ref only (the ** shifts the columns)");
  await md.locator("td", { hasText: "b" }).click();
  await u.until(async () => (await title()) === "@doc.md:9", "click a table cell → the row's line");
  eq(await title(), "@doc.md:9", "md: table cell → the row's line ref (the pipes shift the columns)");
  await md.locator("li").click();
  await u.until(async () => (await title()) === "@doc.md:5", "click the tight list item → its line");
  eq(await title(), "@doc.md:5", "md: list item → line ref only (the - marker shifts the columns)");
  // A PLAIN line renders byte-identical to its source → the click also
  // carries the COLUMN (file:line:col).
  await md.locator("p", { hasText: "plain paragraph line" }).click({ position: { x: 20, y: 8 } });
  await u.until(async () => {
    const tk = await title();
    return !!tk && /^@doc\.md:13:\d+$/.test(tk);
  }, "click a plain markdown line → its line AND column");
  match(await title(), /^@doc\.md:13:[1-9]\d*$/, "md: plain line → the exact source column");
  // A selection spanning lines 3-5 → the range ref with the selected text.
  const sb = await md.locator("strong").boundingBox();
  const lb = await md.locator("li").boundingBox();
  await u.page.mouse.move(sb.x + 4, sb.y + sb.height / 2);
  await u.page.mouse.down();
  await u.page.mouse.move(lb.x + 8, lb.y + lb.height / 2, { steps: 4 });
  await u.page.mouse.up();
  await u.until(async () => {
    const tk = await title();
    return !!tk && tk.startsWith('@doc.md:3-5 "');
  }, "selection across lines 3-5 → the range ref with the selected text");
  match(await title(), /^@doc\.md:3-5 "[\s\S]*$/, "md: selection across lines → the range ref with the text");
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
  // t1 is captured AFTER the unmount: a tick between an earlier capture and
  // the unmount is a race (the frame is still alive then), and any tick
  // after the capture is what "stopped" must rule out.
  await u.until(async () => ((await page.evaluate("window.__lastTick")) ?? 0) >= 2, "frame timer ticking (postMessage)");
  await u.row("hi.txt").click();
  await u.until(async () => (await u.root().locator(".dswFiles_previewHtml").count()) === 0, "html iframe unmounted");
  const t1 = await page.evaluate("window.__lastTick");
  ok(typeof t1 === "number" && t1 >= 2, "ticks observed while the frame was alive");
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

// J19: the nav column (rightmost browse list) collapses to give the preview
// and diff the full width. The toggle is a STATE PAIR — exactly one control
// on screen at a time, one per state (the dsh host's right-pane pattern one
// level down): expanded → a HIDE button (») in the nav's own header, at the
// edge it collapses; collapsed → a RESTORE button («) in the view bar's right
// end. The view bar renders only while a file is viewed, and the collapse
// invariant keeps the nav expanded whenever nothing is viewed, so a hidden
// nav always has a view bar to carry its restore button. Collapsing unmounts
// the browse pane + divider and the view pane goes flush to the pane's right
// edge. The collapsed state persists across a reload.
async function j19_collapse(u) {
  const hideBtn = u.root().locator(".dswFiles_header .dswFiles_navToggle");
  const restoreBtn = u.root().locator(".dswFiles_paneToggle .dswFiles_navToggle");
  // Journey precondition: at the fixture root with a file viewed.
  await u.until(async () => (await u.rowNames()).includes("a.txt"), "a.txt listed (at the fixture root)");
  await u.row("a.txt").click();
  // Expanded state: the hide control sits in the nav's own header.
  await u.until(async () => (await hideBtn.count()) === 1, "hide control present in the nav header");
  eq(await restoreBtn.count(), 0, "no restore control while the nav is visible");
  eq(await hideBtn.getAttribute("aria-expanded"), "true", "hide control reports the nav expanded");
  eq(await u.root().locator(".dswFiles_browsePane").count(), 1, "browse pane visible initially");
  eq(await u.root().locator(".dswFiles_collapsedRail").count(), 0, "no edge rail (the toggle lives in the nav header / view bar)");
  eq((await u.root().locator(".dswFiles_paneHead").innerText()).trim(), "a.txt", "the viewed file's name rides in the view bar");
  await hideBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 0, "browse pane hidden when collapsed");
  eq(await u.root().locator(".dswFiles_divider").count(), 0, "divider hidden when collapsed");
  // Collapsed state: the restore control sits in the view bar's right end.
  await u.until(async () => (await restoreBtn.count()) === 1, "restore control present in the view bar");
  eq(await hideBtn.count(), 0, "no hide control while the nav is hidden");
  eq(await restoreBtn.getAttribute("aria-expanded"), "false", "restore control reports the nav collapsed");
  // The view pane took the nav's place flush to the pane's right edge.
  const pb = await u.root().locator(".dswFiles_previewPane").boundingBox();
  const rb = await u.root().boundingBox();
  ok(Math.abs((pb.x + pb.width) - (rb.x + rb.width)) <= 1, "view pane flush at the pane's right edge when collapsed");
  await restoreBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 1, "browse pane restored");
  // Persistence: collapse, reload, still collapsed (the restored selection
  // keeps the preference in force from the first render). 0.1.5 note: the
  // right pane's OPEN state is host UI state that a full page reload drops
  // (the sidebar reboots collapsed), so reopen it through the host's own
  // expand button; the filestab state (selection + collapsed nav) comes back
  // from its own storage on the first render.
  await hideBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 0, "collapsed again");
  await u.page.reload({ waitUntil: "domcontentloaded" });
  const expand = u.page.locator('[data-sidebar-right-expand]');
  await u.until(async () => (await expand.count()) > 0, "conversation back after reload", 30_000);
  await expand.click();
  await u.until(async () => (await u.root().count()) === 1, "Files view back after reload", 30_000);
  eq(await u.root().locator(".dswFiles_browsePane").count(), 0, "collapsed state survives reload");
  await u.until(async () => (await restoreBtn.count()) === 1, "restore control back (selection restored)");
  // Leave it expanded for any later journeys.
  await restoreBtn.click();
  await u.until(async () => (await u.root().locator(".dswFiles_browsePane").count()) === 1, "restored for later journeys");
}

// J1.2: a workspace with no VCS -- same layout, no status line, no badges.
async function j1_2_plain(u) {
  await u.until(async () => (await u.rowNames()).includes("hi.txt"), "plain listing");
  eq(await u.root().locator(".dswFiles_statusLine").count(), 0, "no VCS status line without a repo");
  // The current row model renders no letter slot at all for a change-less
  // file, so assert absence (a .first().innerText() would hang forever).
  eq(await u.root().locator(".dswFiles_row .dswFiles_badge").count(), 0, "no change badges without VCS");
  const footer = await u.root().locator(".dswFiles_footerBar").innerText();
  ok(footer.includes("3 items"), `footer counts 3 items, got: ${footer.replace(/\n/g, " ")}`);
  ok((await u.previewText()).includes("Select a file to preview"), "preview starts empty");
}

// J20: live file updates, no user action. A file edited on disk refreshes the
// OPEN preview (the tick's open-file gate sees the disk mtime move and bumps
// the content epoch; the preview re-fetches the bytes). A brand-new file
// appears in the list with the unadded (U) badge (jj auto-snapshots it, so a
// worktree add IS the unadded state — the git `??` parity the markers carry).
// Runs on its OWN fresh session (a first Files-view mount, empty nav cache)
// — a remounted view (e.g. after collapse/expand) would start with cached
// listings and mask a dead first-mount tick interval.
async function j20_liveUpdates(u, ws) {
  await u.row("a.txt").click();
  const raw = u.root().locator("pre.dswFiles_previewText");
  await u.until(async () => (await raw.innerText().catch(() => "")).includes("two"), "a.txt open in raw view");
  // External writer edits the open file. The next tick's open-file gate
  // (disk mtime vs the mtime the view holds) trips → content-epoch bump →
  // re-fetch. No click, no reload, no re-selection.
  writeFileSync(join(ws, "a.txt"), "one\ntwo\nthree (edited on disk)\n");
  await u.until(async () => (await raw.innerText()).includes("three (edited on disk)"),
    "the open preview auto-refreshed the live edit", 20_000);
  // A new file shows up in the list. The tick's shallow gate CANNOT see it
  // (a worktree edit touches no VCS metadata), so it arrives on the deep
  // cycle — every 3rd tick, a ≤15 s horizon — and carries U.
  writeFileSync(join(ws, "fresh.txt"), "brand new\n");
  await u.until(async () => (await u.rowNames()).includes("fresh.txt"),
    "the new file's row appears via the deep tick cycle", 25_000);
  eq((await u.row("fresh.txt").locator(".dswFiles_badge").innerText()).trim(), "U",
    "fresh.txt carries the U (unadded) badge");
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
    const url = dsh.url;
    console.log(`e2e: dsh web on ${url.replace(/token=[^\s]+/, "token=…")}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });

    // F-JJ session: J1, J3, J8, J7, J6, J19.
    const a = await openSession(browser, { url, workspace: fx.fj });
    const ua = ui(a.page);
    await clickFilesTab(a.page);
    console.log("e2e: J1 first look (jj workspace)");
    await j1_firstLook(ua);
    console.log("e2e: J3 text preview (+ >1MB card)");
    await j3_textPreview(ua);
    console.log("e2e: J8 click → ref in the head row");
    await j8_clickRef(ua);
    console.log("e2e: J7 soft-sticky diff preference");
    await j7_stickyDiff(ua);
    console.log("e2e: J6 image preview");
    await j6_imagePreview(ua);
    console.log("e2e: J19 nav-pane collapse/expand (state pair)");
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

    // F-JJ-20 session: J20 on its own FIRST Files-view mount (fresh page +
    // session, empty nav cache) — the fresh-mount live-update path.
    const c = await openSession(browser, { url, workspace: fx.fj20 });
    const uc = ui(c.page);
    await clickFilesTab(c.page);
    console.log("e2e: J20 live file updates (fresh mount, no user action)");
    await j20_liveUpdates(uc, fx.fj20);
    checkConsole(c, "fj20");
    await c.context.close();

    console.log(`e2e: PASS -- ${assertions} assertions across J1, J1.2, J3, J4, J5, J6, J7, J8, J19, J20`);
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
