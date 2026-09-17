// test/e2e/animation.mjs — records the README feature animation: using a
// char-accurate ref (@path:line:col) from the preview to ask the agent to
// change exactly that spot in a file, via the "Add ref to chat" button —
// closing on the Diff view of the agent's change.
//
// Recorded in DARK mode (scratch settings.yaml), with a visible cursor
// (headless Chromium never paints one) and click ripples injected as page
// elements — see CURSOR_SCRIPT.
//
// The whole page load is recorded (Playwright video, 1400x900 @2x); the setup
// beats (workspace picker, the "hi" hello turn that builds the conversation
// pane) are trimmed off afterwards so the GIF opens on the Files pane.
// Output: assets/add-ref-to-chat.gif (the README asset); the trimmed mp4
// master is kept in test/e2e/out/ for re-edits.
//
// Costs one scratch dsh instance + two real model turns (the "hi", the edit).
// Prereqs: same as e2e — dsh 0.1.5-rc.2 on PATH, a playwright chromium,
// filestab dist/ built (npm test), ffmpeg on PATH.
//
// Run: node test/e2e/animation.mjs

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_BIN = process.env.E2E_DSH || "dsh";
// Same pin as the e2e: the session-opening selectors ride on dsh's own UI.
const DSH_VERSION = "0.1.5-rc.2";
function checkDshVersion() {
  const actual = execFileSync(DSH_BIN, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== DSH_VERSION) throw new Error(`dsh version changed (${actual} != ${DSH_VERSION})`);
}

const OUT = join(REPO_ROOT, "test", "e2e", "out");
const GIF_OUT = join(REPO_ROOT, "assets", "add-ref-to-chat.gif");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── environment (mirrors e2e.test.mjs) ─────────────────────────────────────

function makeScratchHome(root) {
  const real = process.env.DSH_HOME || join(process.env.HOME, ".dsh");
  const home = join(root, "home");
  mkdirSync(join(home, "profiles"), { recursive: true });
  cpSync(join(real, "profiles", "web"), join(home, "profiles", "web"), { recursive: true });
  const nm = join(home, "profiles", "web", "node_modules");
  const deps = JSON.parse(readFileSync(join(nm, "..", "package.json"), "utf8")).dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("link:")) continue;
    const link = join(nm, name);
    rmSync(link, { force: true });
    symlinkSync(spec.slice("link:".length), link, "dir");
  }
  if (existsSync(join(real, "settings.yaml"))) {
    cpSync(join(real, "settings.yaml"), join(home, "settings.yaml"));
  }
  // Dark mode: the README renders dark, and the story reads better on it
  // (the ref token and the hljs accents pop).
  const settings = join(home, "settings.yaml");
  if (!existsSync(settings) || !readFileSync(settings, "utf8").includes("ui-theme")) {
    appendFileSync(settings, "ui-theme:\n  preference: dark\n");
  }
  return home;
}

// Headless Chromium never paints the mouse cursor in a recorded video, so
// the recording replaces it with a high-contrast page element (a white
// arrow with a dark outline, visible on both themes) plus a click ripple —
// pure recording chrome. INJECTED AFTER BOOT: the dsh shell wipes
// documentElement's children while it mounts, so an init-script injection
// is deleted (verified). A MutationObserver re-attaches the layer if any
// later wipe removes it; the mousemove/mousedown listeners live on document
// and outlive the layer.
const CURSOR_SCRIPT = () => {
  const layer = document.createElement("div");
  layer.id = "animCursorLayer";
  const style = document.createElement("style");
  style.textContent = "html, body, * { cursor: none !important; }";
  const c = document.createElement("div");
  c.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round">' +
    '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>';
  Object.assign(c.style, {
    position: "fixed", left: "-100px", top: "-100px", zIndex: "2147483647",
    pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))",
    marginLeft: "-3px", marginTop: "-3px",
  });
  layer.appendChild(style);
  layer.appendChild(c);
  document.documentElement.appendChild(layer);
  new MutationObserver(() => {
    if (!document.contains(layer)) document.documentElement.appendChild(layer);
  }).observe(document.documentElement, { childList: true });
  document.addEventListener("mousemove", (e) => {
    c.style.left = e.clientX + "px";
    c.style.top = e.clientY + "px";
  }, true);
  document.addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    Object.assign(r.style, {
      position: "fixed", left: e.clientX - 14 + "px", top: e.clientY - 14 + "px",
      width: "28px", height: "28px", border: "2px solid rgba(255,255,255,0.9)",
      borderRadius: "50%", pointerEvents: "none", zIndex: "2147483647",
    });
    layer.appendChild(r);
    r.animate(
      [{ transform: "scale(0.3)", opacity: "0.9" }, { transform: "scale(1.5)", opacity: "0" }],
      { duration: 450, easing: "ease-out" },
    ).onfinish = () => r.remove();
  }, true);
};

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
      const m = d.toString().match(/dsh web: (http:\/\/127\.0\.0.1:\d+\S+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        res({ url: m[1], stop });
      }
    });
    child.stderr.on("data", (d) => log.push(d.toString()));
    child.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); rej(new Error(`dsh exited ${code}:\n${log.join("").slice(-2000)}`)); }
    });
  });
}

function findChrome() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const cache = join(process.env.HOME, ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const p = join(cache, dirs[i], "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no chromium found: run `npx playwright install chromium` or set E2E_CHROME");
}

// The setup beats (trimmed from the final cut): workspace picker → the "hi"
// turn that builds the conversation pane → wait for the right-pane expand.
async function setupSession(page, url, workspace) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Add workspace" }).click({ timeout: 15_000 });
  const dialog = page.locator('[class*="_dialog_"]').first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.locator(".ZuhsRW_crumbEditZone").click();
  const input = dialog.locator("input").last();
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill(workspace);
  await input.press("Enter");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Open" }).click();
  await page.waitForTimeout(3000);
  const ta = page.locator(".uV2eYG_input").last();
  await ta.waitFor({ state: "visible", timeout: 15_000 });
  await ta.click();
  await ta.pressSequentially("hi");
  await page.getByRole("button", { name: "Send message" }).click();
  // The turn runs until the composer's primary button flips back from
  // "Stop generating" to "Send message". The running state lags the send
  // click by a beat, so the first poll must not be trusted — gate on
  // elapsed time too, and confirm the conversation stopped changing (the
  // reply must be SETTLED before the story opens, or it streams across
  // the hero beats).
  const t0 = Date.now();
  let last = "";
  let stable = 0;
  for (;;) {
    const stopping = (await page.getByRole("button", { name: "Stop generating" }).count()) >= 1;
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    stable = txt === last ? stable + 1 : 0;
    last = txt;
    if (!stopping && stable >= 2 && Date.now() - t0 > 1500) break;
    if (Date.now() - t0 > 120_000) throw new Error("timeout: the hello turn never finished");
    await page.waitForTimeout(600);
  }
  const t1 = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      return !!document.querySelector('[data-sidebar-right-expand]') && !!document.querySelector('[role="tablist"]');
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - t1 > 60_000) throw new Error("timeout: conversation + right-pane expand");
    await page.waitForTimeout(500);
  }
  await sleep(1200);
}

async function main() {
  checkDshVersion();
  const root = join(tmpdir(), `filestab-anim-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  let dsh = null;
  let browser = null;
  let failed = false;
  try {
    const home = makeScratchHome(root);
    // The story's workspace: a jj repo with a CLEAN base commit (files
    // written before `jj new`, verified: the working copy ends empty), so
    // the agent's edit later shows as a live change — row marker, and a
    // diff for the closing beat.
    const fx = join(root, "fixtures", "demo");
    mkdirSync(fx, { recursive: true });
    const serverJs = join(fx, "server.js");
    writeFileSync(serverJs,
      'import { createServer } from "node:http";\n\n' +
      "const PORT = 3000;\n\n" +
      'createServer((req, res) => res.end("hello")).listen(PORT);\n');
    // A second file so the list reads like a real project (the edited file's
    // preview auto-refreshes via the live tick — no re-selection needed).
    writeFileSync(join(fx, "client.js"),
      'const res = await fetch("http://localhost:3000");\n' +
      "console.log(await res.text());\n");
    execFileSync("jj", ["git", "init"], { cwd: fx });
    execFileSync("jj", ["new", "-m", "base"], { cwd: fx });
    dsh = await bootDsh(home);
    console.log(`anim: dsh web on ${dsh.url.replace(/token=[^\s]+/, "token=…")}`);
    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox"] });
    const tStart = Date.now();
    mkdirSync(join(root, "video"), { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2, // the 1400x900 video then downsamples 2:1 — crisp text
      recordVideo: { dir: join(root, "video"), size: { width: 1400, height: 900 } },
    });
    const page = await context.newPage();
    await setupSession(page, dsh.url, fx);
    // After the shell has mounted (and finished wiping documentElement):
    // the visible cursor + click ripples.
    await page.evaluate(CURSOR_SCRIPT);
    await sleep(250);

    // ── the story (this is the whole final cut) ──────────────────────────
    let tStory = 0;
    const row = page.locator(".dswFiles_row", {
      has: page.locator(".dswFiles_name", { hasText: /^server\.js$/ }),
    });
    const center = async (loc) => {
      const b = await loc.boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    await sleep(500);
    tStory = Date.now();
    // 1 — the Files pane: dsh opens the right pane itself when the
    // conversation builds; if this dsh version starts it collapsed, click
    // the pane's own expand control (never while it is open — the control
    // then reads "Collapse sidebar").
    if (!(await page.locator(".dswFiles_root").isVisible().catch(() => false))) {
      const p1 = await center(page.locator('[data-sidebar-right-expand]'));
      await page.mouse.move(p1.x, p1.y, { steps: 8 });
      await page.mouse.click(p1.x, p1.y);
    }
    await page.locator(".dswFiles_root").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(1600);
    // 2 — open server.js (raw view).
    const p2 = await center(row);
    await page.mouse.move(p2.x, p2.y, { steps: 10 });
    await sleep(300);
    await page.mouse.click(p2.x, p2.y);
    const pre = page.locator("pre.dswFiles_previewText");
    await pre.waitFor({ state: "visible", timeout: 15_000 });
    await sleep(1700);
    // 3 — click at the END of the number 3000 (line 3): char-accurate point.
    const pt = await page.evaluate(() => {
      const pre = document.querySelector("pre.dswFiles_previewText");
      const tw = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      let n = tw.nextNode();
      while (n) {
        const i = n.data.indexOf("3000");
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i + 4);
          r.collapse(true);
          const b = r.getBoundingClientRect();
          return { x: b.x, y: b.y + b.height / 2 };
        }
        n = tw.nextNode();
      }
      return null;
    });
    if (!pt) throw new Error("could not locate the number in the raw view");
    await page.mouse.move(pt.x, pt.y, { steps: 14 });
    await sleep(400);
    await page.mouse.click(pt.x, pt.y);
    const token = page.locator(".dswFiles_paneHeadToken");
    await token.waitFor({ state: "visible", timeout: 10_000 });
    const ref = await token.getAttribute("title");
    if (!/^@server\.js:3:[12]\d$/.test(ref || "")) throw new Error(`unexpected ref shape: ${ref}`);
    console.log(`anim: ref ${ref} — holding on the token`);
    await sleep(2600); // the money shot: the head row shows the exact token
    // 4 — "Add ref to chat".
    const addBtn = page.locator(".dswFiles_paneHeadBtns button[aria-label='Add ref to chat']");
    const p3 = await center(addBtn);
    await page.mouse.move(p3.x, p3.y, { steps: 8 });
    await sleep(300);
    await page.mouse.click(p3.x, p3.y);
    const composer = page.locator("[data-composer-input]");
    await sleep(1000); // the ref lands in the composer draft
    // 5 — type the request next to the ref. Place the caret explicitly at
    // the END of the draft: a plain click could land mid-token and split
    // the ref while typing.
    await composer.evaluate((el) => {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type("change this number to 8080 and leave everything else exactly as it is", { delay: 45 });
    await sleep(900);
    // 6 — send.
    const send = page.getByRole("button", { name: "Send message" });
    const p4 = await center(send);
    await page.mouse.move(p4.x, p4.y, { steps: 10 });
    await sleep(250);
    await page.mouse.click(p4.x, p4.y);
    // 7 — the agent's turn: read, edit, reply. Ground truth = the file on disk.
    const t0 = Date.now();
    for (;;) {
      if ((await readFileSync(serverJs, "utf8")).includes("8080")) break;
      if (Date.now() - t0 > 180_000) throw new Error("timeout: the agent's edit never landed");
      await page.waitForTimeout(1000);
    }
    await sleep(2800); // let the reply finish rendering
    // 8 — the open preview AUTO-refreshes: the tick's open-file gate sees
    // the agent's disk edit (mtime moved) and bumps the content epoch —
    // no re-selection, no reload. Hold on the changed line.
    const t1 = Date.now();
    for (;;) {
      const txt = await pre.innerText().catch(() => "");
      if (txt.includes("8080")) break;
      if (Date.now() - t1 > 20_000) throw new Error("timeout: the live preview never showed the edit");
      await page.waitForTimeout(300);
    }
    await sleep(1500); // the new value in the preview (the diff comes next)
    // 9 — the flourish: Diff mode shows exactly what the agent changed.
    const diffBtn = page.locator(".dswFiles_paneToggleBtn", { hasText: /^Diff$/ });
    const p7 = await center(diffBtn);
    await page.mouse.move(p7.x, p7.y, { steps: 10 });
    await sleep(300);
    await page.mouse.click(p7.x, p7.y);
    await page.locator(".dswFiles_diff").waitFor({ state: "visible", timeout: 15_000 });
    await sleep(3000); // closing beat: the port change as a diff
    await sleep(400);

    // ── harvest the video ─────────────────────────────────────────────────
    const video = page.video();
    await context.close(); // flushes the recording
    const webm = join(OUT, "add-ref-to-chat-master.webm");
    mkdirSync(OUT, { recursive: true });
    await video.saveAs(webm);
    console.log(`anim: master ${webm}`);
    // Trim to the story (a little lead-in). H.264 needs an mp4 container —
    // webm only carries VP8/VP9/AV1.
    const ss = Math.max(0, (tStory - tStart) / 1000 - 1.2).toFixed(3);
    const trimmed = join(OUT, "add-ref-to-chat.mp4");
    execFileSync("ffmpeg", ["-y", "-ss", ss, "-i", webm, "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", trimmed], { stdio: "pipe" });
    // Two-pass palette GIF for the README: 12 fps, 1100px wide.
    const palette = join(OUT, "gif-palette.png");
    execFileSync("ffmpeg", ["-y", "-i", trimmed, "-vf", "fps=12,scale=1100:-2:flags=lanczos,palettegen=stats_mode=diff", palette], { stdio: "pipe" });
    execFileSync("ffmpeg", ["-y", "-i", trimmed, "-i", palette, "-lavfi", "fps=12,scale=1100:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer", GIF_OUT], { stdio: "pipe" });
    console.log(`anim: ${GIF_OUT} (cut from ${ss}s)`);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dsh) dsh.stop();
    // Keep the scratch tree only on failure (for post-mortem); the video is
    // saved before this point.
    if (failed) console.log(`anim: keeping scratch tree ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("anim: FAILED —", e.message);
  process.exitCode = 1;
});
