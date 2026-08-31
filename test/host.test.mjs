import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { apply } from "../dist/index.js";
import { finishFileShow } from "../dist/snapshot.js";

const base = await mkdtemp(join(tmpdir(), "filez-host-"));
const ws = join(base, "ws");
const outside = join(base, "outside");
await mkdir(join(ws, "sub"), { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(join(ws, "a.txt"), "hello");
await writeFile(join(ws, "note.md"), "# hi\n");
await writeFile(join(ws, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
await writeFile(join(ws, "sub", "b.txt"), "world");
await writeFile(join(outside, "secret.txt"), "top secret");
await symlink(outside, join(ws, "link"));
// fileshow edge-case fixtures, INSIDE the workspace (fileshow is
// workspace-scoped): type-sniffing cases (magic overriding a wrong extension,
// recognized signatures, no-signature fallback) plus an over-cap text file for
// the truncation path.
await mkdir(join(ws, "sniff"), { recursive: true });
await writeFile(join(ws, "sniff", "photo.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
await writeFile(join(ws, "sniff", "doc.pdf"), "%PDF-1.4\n1 0 obj\n");
await writeFile(join(ws, "sniff", "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]));
await writeFile(join(ws, "sniff", "mystery.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
await writeFile(join(ws, "sniff", "big.txt"), "x".repeat(1_572_864)); // 1.5 MB of text → capped read

const SESSION_ID = "sess-1";

let capturedHandler = null, capturedChannel = null, capturedOptions = null;
const ctx = {
  get(name) {
    if (name === "connection") return { rpc: { handle: (channel, handler, options) => { capturedChannel = channel; capturedHandler = handler; capturedOptions = options; } } };
    if (name === "sessions") return { get: (id) => (id === SESSION_ID ? { id, header: { cwd: ws } } : undefined) };
    if (name === "sandboxPolicy") return { resolve: ({ session }) => ({ mode: "workspace-write", workspaceRoot: session?.header?.cwd }) };
    return undefined;
  },
  on() {},
  effect: (fn) => { fn(); },
  logger: { info() {}, error() {} },
};

apply(ctx);
assert.strictEqual(capturedChannel, "/filez-browse", "browse channel registered: " + capturedChannel);
assert.ok(typeof capturedHandler === "function", "browse handler captured");
// Regression guard: register() reads `options.authority`, so the 3rd arg must
// be a real object, a missing one throws and silently drops the route.
assert.ok(capturedOptions !== null && typeof capturedOptions === "object", "options object passed to rpc.handle (missing => 405): " + JSON.stringify(capturedOptions));

let n = 0;
const call = (endpoint, payload) => capturedHandler(endpoint, payload);

{ const r = await call("list", { sessionId: SESSION_ID, relPath: "" });
  assert.ok(r.ok, "list root ok: " + JSON.stringify(r));
  assert.deepStrictEqual(r.value.entries.map((e) => e.name), ["sniff", "sub", "a.txt", "link", "note.md", "pic.png"], "root entries (dirs first, then name): " + JSON.stringify(r.value.entries));
  assert.strictEqual(r.value.root, ws, "root echoed"); n++; }
{ const r = await call("list", { sessionId: SESSION_ID, relPath: "sub" });
  assert.ok(r.ok, "list sub");
  assert.deepStrictEqual(r.value.entries.map((e) => e.name), ["b.txt"], "sub entries");
  assert.strictEqual(r.value.entries[0].path, "sub/b.txt", "child rel path"); n++; }
{ await writeFile(join(ws, ".hidden"), "h");
  const shown = await call("list", { sessionId: SESSION_ID, relPath: "", showHidden: true });
  assert.ok(shown.ok && shown.value.entries.some((e) => e.name === ".hidden"), "hidden included when showHidden");
  const hidden = await call("list", { sessionId: SESSION_ID, relPath: "" });
  assert.ok(hidden.ok && !hidden.value.entries.some((e) => e.name === ".hidden"), "hidden excluded by default"); n++; }
{ const r = await call("list", { sessionId: "nope", relPath: "" });
  assert.ok(!r.ok && r.error.code === "session-not-found", "unknown session: " + JSON.stringify(r)); n++; }
{ const r = await call("list", { relPath: "" });
  assert.ok(!r.ok && r.error.code === "bad-request", "missing sessionId: " + JSON.stringify(r)); n++; }
// Envelope: the dsh rpc result is a CLOSED error-code union (rpcErrorSchema);
// plugin codes (forbidden / not-a-directory / unknown-endpoint / vcs codes)
// must be mapped onto it or the client rejects the whole response as an
// `invalid_union` blob (regression: the git commit-review error path).
{ const r = await call("list", { sessionId: SESSION_ID, relPath: "../outside" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path" && typeof r.error.details.path === "string", ".. escape → workspace-invalid-path: " + JSON.stringify(r)); n++; }
{ const r = await call("list", { sessionId: SESSION_ID, relPath: "link" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path", "symlink escape → workspace-invalid-path: " + JSON.stringify(r)); n++; }
{ const r = await call("list", { sessionId: SESSION_ID, relPath: "/etc/passwd" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path", "absolute → workspace-invalid-path: " + JSON.stringify(r)); n++; }
{ const r = await call("list", { sessionId: SESSION_ID, relPath: "a.txt" });
  assert.ok(!r.ok && r.error.code === "bad-request" && Array.isArray(r.error.details.issues), "list file → bad-request + issues: " + JSON.stringify(r)); n++; }
{ const r = await call("bogus", { sessionId: SESSION_ID });
  assert.ok(!r.ok && r.error.code === "bad-request" && Array.isArray(r.error.details.issues), "unknown endpoint → bad-request + issues: " + JSON.stringify(r)); n++; }

// The in-pane preview's single transport: containment-checked, capped at
// 1 MB, type sniffed (magic over extension), displayable binaries under the
// cap carry base64 `data`.
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "a.txt", rev: "worktree" });
  assert.ok(r.ok, "worktree text ok: " + JSON.stringify(r));
  assert.strictEqual(r.value.kind, "text", "text kind");
  assert.strictEqual(r.value.text, "hello", "text content");
  assert.strictEqual(r.value.size, 5, "size = file size");
  assert.strictEqual(r.value.truncated, false, "not truncated");
  assert.strictEqual(r.value.type, "application/octet-stream", "plain ext falls to octet-stream (no magic signature)");
  assert.strictEqual(r.value.label, "binary", "octet-stream label (unshown for text kind)"); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "note.md", rev: "worktree" });
  assert.ok(r.ok && r.value.kind === "text" && r.value.type === "text/markdown", "md worktree: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "pic.png", rev: "worktree" });
  assert.ok(r.ok, "png worktree ok: " + JSON.stringify(r));
  assert.strictEqual(r.value.kind, "binary", "binary kind");
  assert.strictEqual(r.value.type, "image/png", "PNG magic (same result as the extension, sniffed)");
  assert.strictEqual(r.value.label, "PNG image", "sniffed label");
  assert.ok(typeof r.value.data === "string" && r.value.data.length > 0, "under-cap displayable binary carries base64 data"); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sniff/photo.dat", rev: "worktree" });
  assert.ok(r.ok && r.value.kind === "binary" && r.value.type === "image/png", "PNG magic overrides .dat: " + JSON.stringify(r));
  assert.strictEqual(r.value.label, "PNG image", "mislabel → sniffed label"); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sniff/doc.pdf", rev: "worktree" });
  assert.ok(r.ok && r.value.type === "application/pdf", "pdf sniff: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sniff/bundle.zip", rev: "worktree" });
  assert.ok(r.ok && r.value.type === "application/zip", "zip sniff: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sniff/mystery.bin", rev: "worktree" });
  assert.ok(r.ok, "mystery ok: " + JSON.stringify(r));
  assert.strictEqual(r.value.kind, "binary", "NUL byte → binary kind");
  assert.strictEqual(r.value.type, "application/octet-stream", "no signature → extension fallback");
  assert.strictEqual(r.value.label, "binary", "unknown → binary label");
  assert.strictEqual(r.value.data, undefined, "non-displayable binary carries no data"); n++; }
// over-cap text: the read is capped but size stays the TRUE file size
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sniff/big.txt", rev: "worktree" });
  assert.ok(r.ok, "big file ok: " + JSON.stringify(r));
  assert.strictEqual(r.value.kind, "text", "big text kind");
  assert.strictEqual(r.value.text.length, 1_000_000, "text capped at 1 MB");
  assert.strictEqual(r.value.size, 1_572_864, "size = true file size, not the capped read");
  assert.strictEqual(r.value.truncated, true, "truncated flag set"); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "nope.txt", rev: "worktree" });
  assert.ok(!r.ok && /not-found/.test(r.error.message), "missing → not-found: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "sub", rev: "worktree" });
  assert.ok(!r.ok && /not-a-file/.test(r.error.message), "directory → not-a-file: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "link", rev: "worktree" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path", "symlink escape → workspace-invalid-path: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "../outside/secret.txt", rev: "worktree" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path", ".. escape → workspace-invalid-path: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "/etc/passwd", rev: "worktree" });
  assert.ok(!r.ok && r.error.code === "workspace-invalid-path", "absolute → workspace-invalid-path: " + JSON.stringify(r)); n++; }
// rev validation: only "worktree" or a change/commit id
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "a.txt", rev: "commit" });
  assert.ok(!r.ok && r.error.code === "bad-request", "'commit' is not a fileshow rev: " + JSON.stringify(r)); n++; }
{ const r = await call("fileshow", { sessionId: SESSION_ID, relPath: "a.txt" });
  assert.ok(!r.ok && r.error.code === "bad-request", "missing rev → bad-request: " + JSON.stringify(r)); n++; }
// finishFileShow (pure): the extension fallback fires only when sniff() is null,
// so an unknown source extension renders as TEXT via the NUL heuristic (no NUL),
// while a known-binary extension survives a missing signature (corrupt-file net).
{ const v = finishFileShow(Buffer.from("fn main() {}\n"), "src/main.rs");
  assert.strictEqual(v.kind, "text", "unknown source ext, no NUL → text");
  assert.strictEqual(v.type, "application/octet-stream", "unknown ext → octet-stream"); n++; }
{ const v = finishFileShow(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "icon.svg");
  assert.strictEqual(v.kind, "binary", "svg → binary (image)");
  assert.strictEqual(v.type, "image/svg+xml", "svg via extension (no magic signature)"); n++; }
{ const v = finishFileShow(Buffer.from("definitely not a png"), "pic.png");
  assert.strictEqual(v.kind, "binary", "corrupt .png → binary (safety net)");
  assert.strictEqual(v.type, "image/png", "extension survives a missing signature"); n++; }

// mermaid endpoint: serves the vendored renderer bundle as text.
// Package-local asset — no session, no containment, no workspace.
{ const r = await call("mermaid", { sessionId: SESSION_ID });
  assert.ok(r.ok, "mermaid bundle ok: " + JSON.stringify(r.error ?? null));
  assert.ok(typeof r.value.text === "string" && r.value.text.length > 100_000, "mermaid bundle is the ~3 MB minified renderer");
  assert.ok(r.value.text.includes("globalThis"), "mermaid bundle exposes a global"); n++; }
{ const r = await call("mermaid", {});
  assert.ok(r.ok, "mermaid bundle needs no session (package-local asset)"); n++; }

await rm(base, { recursive: true, force: true });
console.log(`host: ${n} assertions passed (browse + fileshow worktree + mermaid bundle)`);
