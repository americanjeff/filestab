// Run: node test/jj.test.mjs
//
// Pure parser tests always run. The I/O sections need a real jj on PATH
// (skipped gracefully, like a network test would be). Every commit-creating
// command passes -m, a bare `jj commit`/`jj new` pops the user's ui.editor.
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import assert from "node:assert";
import { jj, parseSummary, parseHead, parseCommitLog, parseConflicts, insideWorkspace, jjWorkspaceStatus } from "../dist/jj.js";
import { snapshotDirListing } from "../dist/snapshot.js";
import { apply } from "../dist/index.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// parseSummary, golden shapes pinned to real jj 0.44.0 output.
assert.deepStrictEqual(
  parseSummary("M a.txt\nA b/c.txt\nD d.txt\nC c.txt"),
  [
    { path: "a.txt", status: "M" },
    { path: "b/c.txt", status: "A" },
    { path: "d.txt", status: "D" },
    { path: "c.txt", status: "C" },
  ], "plain letters");
// renames: git BRACE form (embedded and bare), never `old -> new`
assert.deepStrictEqual(parseSummary("R {s1.txt => s1b.txt}"),
  [{ path: "s1b.txt", status: "R", oldPath: "s1.txt" }], "bare brace rename");
assert.deepStrictEqual(parseSummary("R sub/{s.txt => s2.txt}"),
  [{ path: "sub/s2.txt", status: "R", oldPath: "sub/s.txt" }], "embedded brace rename");
assert.deepStrictEqual(parseSummary("R {far.txt => moved/far.txt}"),
  [{ path: "moved/far.txt", status: "R", oldPath: "far.txt" }], "cross-dir brace rename");
assert.deepStrictEqual(parseSummary("M my file.txt"),
  [{ path: "my file.txt", status: "M" }], "path with spaces");
assert.deepStrictEqual(parseSummary(""), [], "empty input");
assert.deepStrictEqual(parseSummary("junk line\n\n  \n"), [], "unknown lines skipped");

assert.deepStrictEqual(parseHead("f11e978bb855\tstep2\n"), { id: "f11e978bb855", description: "step2" }, "head with desc");
assert.deepStrictEqual(parseHead("f11e978bb855\t\n"), { id: "f11e978bb855", description: "" }, "head, empty desc");
assert.strictEqual(parseHead(""), null, "head, no input");
assert.strictEqual(parseHead("no tab here\n"), null, "head, no TSV line");

// TSV shape: change-id \t empty-flag(0|1) \t first-line (the flag column is
// anchored, so a tab inside the description stays put).
assert.deepStrictEqual(parseCommitLog("abc123def456\t0\tfix the parser\n"),
  [{ id: "abc123def456", empty: false, description: "fix the parser" }], "commit log, one entry");
assert.deepStrictEqual(parseCommitLog("abc123def456\t1\t\n"),
  [{ id: "abc123def456", empty: true, description: "" }], "commit log, (empty) + no desc");
assert.deepStrictEqual(parseCommitLog("abc123def456\t1\twip\n"),
  [{ id: "abc123def456", empty: true, description: "wip" }], "commit log, (empty) + desc");
assert.deepStrictEqual(parseCommitLog("abc123def456\t0\t\n"),
  [{ id: "abc123def456", empty: false, description: "" }], "commit log, no desc only");
assert.deepStrictEqual(parseCommitLog("abc123def456\t0\tfix\twith tabs\n"),
  [{ id: "abc123def456", empty: false, description: "fix\twith tabs" }], "tab in description survives");
assert.deepStrictEqual(parseCommitLog("zzzzzzzzzzzz\t1\t\n"), [], "root revision filtered");
assert.deepStrictEqual(parseCommitLog("Warning: something\nabc123def456\t0\tfirst\n\n"),
  [{ id: "abc123def456", empty: false, description: "first" }], "non-TSV lines skipped");
assert.deepStrictEqual(
  parseCommitLog(Array.from({ length: 60 }, (_, i) => "a" + String(i).padStart(11, "0") + "\t0\td" + i).join("\n")),
  Array.from({ length: 50 }, (_, i) => ({ id: "a" + String(i).padStart(11, "0"), empty: false, description: "d" + i })),
  "capped at 50 entries");

assert.deepStrictEqual(
  snapshotDirListing("a.txt\nsub/b.txt\nsub/deep/c.txt\n.hidden\n", "").entries,
  [
    { name: "sub", path: "sub", isDirectory: true, hidden: false },
    { name: "a.txt", path: "a.txt", isDirectory: false, hidden: false },
  ], "root: dirs first, hidden filtered");
assert.deepStrictEqual(
  snapshotDirListing("a.txt\nsub/b.txt\nsub/deep/c.txt\n.hidden\n", "", { showHidden: true }).entries,
  [
    { name: "sub", path: "sub", isDirectory: true, hidden: false },
    { name: ".hidden", path: ".hidden", isDirectory: false, hidden: true },
    { name: "a.txt", path: "a.txt", isDirectory: false, hidden: false },
  ], "showHidden includes dotfiles (sorted as plain entries)");
assert.deepStrictEqual(
  snapshotDirListing("sub/b.txt\nsub/deep/c.txt\nsub/deep/.dot\n", "sub").entries,
  [
    { name: "deep", path: "sub/deep", isDirectory: true, hidden: false },
    { name: "b.txt", path: "sub/b.txt", isDirectory: false, hidden: false },
  ], "subdir: nested paths become child paths (deeper levels don't leak up)");
assert.deepStrictEqual(
  snapshotDirListing("sub/deep/c.txt\nsub/deep/.dot\n", "sub/deep", { showHidden: true }).entries,
  [
    { name: ".dot", path: "sub/deep/.dot", isDirectory: false, hidden: true },
    { name: "c.txt", path: "sub/deep/c.txt", isDirectory: false, hidden: false },
  ], "deep level lists its own hidden entries (showHidden)");
assert.deepStrictEqual(
  snapshotDirListing("sub/b.txt\nsub/deep/c.txt\n", "sub").entries,
  [
    { name: "deep", path: "sub/deep", isDirectory: true, hidden: false },
    { name: "b.txt", path: "sub/b.txt", isDirectory: false, hidden: false },
  ], "dir with only a subdirectory still shows the directory");
assert.deepStrictEqual(snapshotDirListing("", "").entries, [], "empty file list → empty dir");
assert.deepStrictEqual(
  snapshotDirListing("other/x.txt\nsub/a.txt\n", "sub").entries,
  [{ name: "a.txt", path: "sub/a.txt", isDirectory: false, hidden: false }], "lines outside the scoped dir ignored");
assert.deepStrictEqual(
  snapshotDirListing("b.txt\nc.txt\nd.txt\n", "", { cap: 2 }),
  { entries: [
      { name: "b.txt", path: "b.txt", isDirectory: false, hidden: false },
      { name: "c.txt", path: "c.txt", isDirectory: false, hidden: false },
    ], truncated: true },
  "cap + truncated flag");

assert.deepStrictEqual(parseConflicts(
  "The working copy has no changes.\n" +
  "Working copy  (@) : sozzrtmq e59d9f61 (conflict) merge\n" +
  "Parent commit (@-): xwlvutmw 8310583e left\n" +
  "Warning: There are unresolved conflicts at these paths:\n" +
  "c.txt    2-sided conflict\n" +
  "my file.txt    2-sided conflict\n"),
  ["c.txt", "my file.txt"], "conflict section parsed (incl. spaces)");
assert.deepStrictEqual(parseConflicts("The working copy has no changes.\nWorking copy  (@) : abc\n"),
  [], "no warning section → none");

assert.ok(insideWorkspace("a.txt") && insideWorkspace("sub/b.txt") && insideWorkspace("a/../b.txt"), "inside ok");
assert.ok(!insideWorkspace("") && !insideWorkspace("../x") && !insideWorkspace("/abs") && !insideWorkspace("a/../../x"), "escapes rejected");

const hasJj = await new Promise((res) => execFile("jj", ["--version"], (e) => res(!e)));
if (!hasJj) {
  console.log(`jj: pure tests only (${n} assertions) — no jj on PATH, I/O sections skipped`);
  process.exit(0);
}

const ENV = { ...process.env, JJ_USER: "TestUser", JJ_EMAIL: "test@example.com" };
const runJj = (cwd, args) => new Promise((res) =>
  execFile("jj", args, { cwd, env: ENV }, (e, so, se) => res({ code: e ? e.code : 0, out: so, err: se })));
const jjIn = (ws, args) => runJj(ws, [...args]);
// The no-op fingerprint: the INTEGRATED op-log head = token 1 of the SECOND
// line of `jj op log --no-integrate-operation`. (Line 1 is the command's own
// freshly-snapshotted ORPHAN op, a new id on every call, useless as a
// fingerprint. With --no-integrate-operation, orphans never enter the
// retained lineage, so line 2 stays put across reads and moves only when an
// integrated jj command runs.)
const opHead = (ws) => runJj(ws, ["op", "log", "--no-integrate-operation"]).then((r) => r.out.split("\n")[1]?.split(/\s+/)[1]);

const base = await mkdtemp(join(tmpdir(), "filez-jj-"));
const ws = join(base, "ws");
await runJj(base, ["git", "init", ws]);

await writeFile(join(ws, "a.txt"), "l1\nl2\nl3\n");
await writeFile(join(ws, "k.txt"), "keep\n");
await mkdir(join(ws, "sub"));
await writeFile(join(ws, "sub", "s.txt"), "s1\n");
ok((await jjIn(ws, ["commit", "-m", "baseline"])).code === 0, "baseline commit");
await writeFile(join(ws, "a.txt"), "l1\nl2 CHANGED\nl3\n");
await writeFile(join(ws, "n.txt"), "brand new\n");
await rm(join(ws, "k.txt"));
await rename(join(ws, "sub", "s.txt"), join(ws, "sub", "s2.txt"));

const opBefore = await opHead(ws);
const stA = await jjWorkspaceStatus(ws);
ok(stA.ok, "status A ok: " + JSON.stringify(stA));
{
  const by = Object.fromEntries(stA.changes.map((e) => [e.path, e]));
  ok(by["a.txt"]?.status === "M" && by["a.txt"].base === "worktree", "M a.txt (worktree): " + JSON.stringify(by["a.txt"]));
  ok(by["n.txt"]?.status === "A" && by["n.txt"].base === "worktree", "A n.txt (worktree)");
  ok(by["k.txt"]?.status === "D" && by["k.txt"].base === "worktree", "D k.txt (worktree)");
  ok(by["sub/s2.txt"]?.status === "R" && by["sub/s2.txt"]?.oldPath === "sub/s.txt", "R sub/s2.txt (worktree): " + JSON.stringify(by["sub/s2.txt"]));
  ok(stA.conflicts.length === 0, "no conflicts");
  ok(stA.head.marker === "@", "anchor is @ while dirty: " + JSON.stringify(stA.head));
  ok(/^[0-9a-f]{12}$/.test(stA.head.id), "head id is 12-hex: " + stA.head.id);
}
// the load-bearing flag: all of the above left the INTEGRATED lineage untouched
assert.strictEqual(await opHead(ws), opBefore, "reads don't advance the current op (--no-integrate-operation)"); n++;

// Strictly-@-by-design: a clean worktree means NO changes; the anchor stays
// the current head (@), never flips to the commit just made.
ok((await jjIn(ws, ["commit", "-m", "step2"])).code === 0, "step2 commit");
const stB = await jjWorkspaceStatus(ws, { force: true });
ok(stB.ok, "status B ok: " + JSON.stringify(stB));
{
  ok(stB.changes.length === 0, "clean worktree → no changes (strictly worktree): " + JSON.stringify(stB.changes));
  ok(stB.conflicts.length === 0, "no conflicts");
  ok(stB.head.marker === "@", "anchor stays @ (the current head): " + JSON.stringify(stB.head));
  ok(stB.head.description === "", "fresh empty working copy has no description: " + JSON.stringify(stB.head));
  ok(/^[0-9a-f]{12}$/.test(stB.head.id), "head id is the working copy's: " + JSON.stringify(stB.head));
  // The review dropdown's list: newest-first real commits, root excluded.
  ok(Array.isArray(stB.commits) && stB.commits.length === 2, "commits listed: " + JSON.stringify(stB.commits));
  ok(stB.commits[0]?.description === "step2" && stB.commits[1]?.description === "baseline", "commits newest-first: " + JSON.stringify(stB.commits));
  ok(stB.commits.every((c) => /^[0-9a-z]{12}$/.test(c.id) && c.id !== "z".repeat(12)), "12-char change ids (a–z form), root excluded");
  ok(stB.commits.every((c) => c.empty === false), "listed commits are non-empty: " + JSON.stringify(stB.commits));
}
// New work in the worktree shows up again (worktree base), then restore the
// clean tree for the handler tests below.
await writeFile(join(ws, "a.txt"), "l1\nl2 CHANGED AGAIN\nl3\n");
const stB2 = await jjWorkspaceStatus(ws, { force: true });
{
  const by = Object.fromEntries(stB2.changes.map((e) => [e.path, e]));
  ok(by["a.txt"]?.status === "M" && by["a.txt"]?.base === "worktree", "new worktree change shows (worktree base): " + JSON.stringify(by["a.txt"]));
}
await writeFile(join(ws, "a.txt"), "l1\nl2 CHANGED\nl3\n");

let capturedHandler = null;
const plainWs = join(base, "plain");
await mkdir(plainWs);
await writeFile(join(plainWs, "x.txt"), "x");
const ctx = {
  get(name) {
    if (name === "connection") return { rpc: { handle: (ch, handler) => { capturedHandler = handler; } } };
    if (name === "sessions") return { get: (id) => ({ id, header: { cwd: id === "sess-2" ? plainWs : ws } }) };
    if (name === "sandboxPolicy") return { resolve: ({ session }) => ({ mode: "workspace-write", workspaceRoot: session?.header?.cwd }) };
    return undefined;
  },
  on() {},
  effect: (fn) => { fn(); },
  logger: { info() {}, error() {} },
};
apply(ctx);
ok(typeof capturedHandler === "function", "browse handler captured");
const call = (endpoint, payload) => capturedHandler(endpoint, payload);

// Dirty the worktree again, with files other than a.txt (the later
// worktree-diff test expects a.txt's worktree patch to stay empty).
await writeFile(join(ws, "b.txt"), "extra\n");
await writeFile(join(ws, "c.txt"), "extra2\n");
await rm(join(ws, "n.txt"));
{ const r = await call("list", { sessionId: "sess-1" });
  ok(r.ok, "list ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.vcs?.ok === true && r.value.vcs?.backend === "jj", "list carries the vcs block (jj backend — the fixture is co-located jj+git, jj wins): " + JSON.stringify(r.value.vcs));
  ok(Array.isArray(r.value.vcs.changes) && r.value.vcs.changes.length >= 3, "worktree changes present: " + JSON.stringify(r.value.vcs?.changes));
  ok(r.value.vcs.changes.every((e) => e.base === "worktree"), "every listed change is worktree-based: " + JSON.stringify(r.value.vcs?.changes)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "commit" });
  ok(r.ok, "diff commit-base ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.patch.includes("-l2\n") && r.value.patch.includes("+l2 CHANGED\n"), "commit-base patch shows the step2 change: " + r.value.patch);
  ok(r.value.base === "commit" && r.value.truncated === false, "echoed base, not truncated"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "worktree" });
  ok(r.ok && r.value.patch === "", "worktree clean → ok:true with EMPTY patch (a state, not an error)"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "k.txt", base: "commit" });
  ok(r.ok && r.value.patch.includes("+++ /dev/null") && r.value.patch.includes("-keep"), "deleted file diffs against /dev/null: " + r.value.patch); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "n.txt", base: "commit" });
  ok(r.ok && r.value.patch.includes("new file mode 100644") && r.value.patch.includes("+brand new"), "added file shows new-file header (commit base)"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "sub/s2.txt", base: "commit" });
  ok(r.ok && r.value.patch.includes("rename from sub/s.txt") && r.value.patch.includes("rename to sub/s2.txt"), "rename section: " + r.value.patch); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "../escape.txt", base: "worktree" });
  ok(!r.ok && r.error.code === "workspace-invalid-path", ".. escape → workspace-invalid-path (envelope-legal): " + JSON.stringify(r)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "/etc/passwd", base: "worktree" });
  ok(!r.ok && r.error.code === "workspace-invalid-path", "absolute → workspace-invalid-path: " + JSON.stringify(r)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "evil" });
  ok(!r.ok && r.error.code === "bad-request", "base whitelist: " + JSON.stringify(r)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt" });
  ok(!r.ok && r.error.code === "bad-request", "missing base → bad-request: " + JSON.stringify(r)); }

{ const r = await call("list", { sessionId: "sess-1" });
  const c = r.value.vcs?.commits;
  ok(Array.isArray(c) && c.length === 2, "list carries commits (newest first): " + JSON.stringify(c));
  ok(c[0]?.description === "step2" && c[1]?.description === "baseline", "commit order + descriptions");
  ok(c.every((x) => /^[0-9a-z]{12}$/.test(x.id)), "change ids are the friendly a–z form"); }
const STEP2 = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
const BASE0 = (await jjWorkspaceStatus(ws, { force: true })).commits[1].id;
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: STEP2 });
  ok(r.ok && r.value.patch.includes("-l2\n") && r.value.patch.includes("+l2 CHANGED\n"), "diff at a change id = that commit's delta vs parent: " + r.value.patch);
  ok(r.value.base === STEP2, "echoed rev base"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "b.txt", base: STEP2 });
  ok(r.ok && r.value.patch === "", "file the commit never touched → EMPTY patch (a state, not an error)"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: BASE0 });
  ok(r.ok && r.value.patch.includes("new file mode 100644") && r.value.patch.includes("+l2\n"), "oldest commit's diff vs the empty tree: " + r.value.patch); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "sub/s2.txt", base: STEP2 });
  ok(r.ok && r.value.patch.includes("rename from sub/s.txt") && r.value.patch.includes("rename to sub/s2.txt"), "text rename at a change id: " + r.value.patch);
  ok(r.value.binary === undefined, "text-file rename carries NO binary block (the rename gate must not fire for non-binary): " + JSON.stringify(r.value && Object.keys(r.value))); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "deadbeef0000" });
  ok(!r.ok && r.error.code === "internal", "unresolvable rev (rewritten history) → internal (jj-error mapped, envelope-legal): " + JSON.stringify(r)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "abc12" });
  ok(!r.ok && r.error.code === "bad-request", "too-short id → bad-request: " + JSON.stringify(r)); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "a.txt", base: "a@ & root() | all()" });
  ok(!r.ok && r.error.code === "bad-request", "revset injection via base → bad-request (hex whitelist)"); }
{ const r = await call("diff", { relPath: "a.txt", base: "worktree" });
  ok(!r.ok && r.error.code === "bad-request", "missing sessionId → bad-request: " + JSON.stringify(r)); }

// History at this point: root → baseline (a.txt, k.txt, sub/s.txt) → step2
// (a.txt M, n.txt A, k.txt D, sub/s.txt → sub/s2.txt). The worktree is dirty
// (b.txt A, c.txt A, n.txt D), none of that may leak into a snapshot.
{ const r = await call("list", { sessionId: "sess-1", rev: BASE0 });
  ok(r.ok, "list@rev ok: " + JSON.stringify(r?.error ?? null));
  const paths = (r.value.entries || []).map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ["a.txt", "k.txt", "sub"], "baseline snapshot = exact baseline tree (no worktree files): " + JSON.stringify(paths));
  const sub = r.value.entries.find((e) => e.name === "sub");
  ok(sub && sub.isDirectory === true, "synthesized directory entry");
  ok(!r.value.entries.some((e) => e.path === "n.txt"), "worktree-only n.txt absent from the old snapshot");
  ok(r.value.vcs?.ok === true && Array.isArray(r.value.vcs?.commits), "vcs block stays the WORKTREE's (dropdown live in snapshot mode)"); }
{ const r = await call("list", { sessionId: "sess-1", rev: BASE0, relPath: "sub" });
  ok(r.ok, "list@rev sub ok: " + JSON.stringify(r?.error ?? null));
  assert.deepStrictEqual(r.value.entries.map((e) => e.path), ["sub/s.txt"], "subdir at baseline = the PRE-RENAME name: " + JSON.stringify(r.value.entries)); }
{ const r = await call("list", { sessionId: "sess-1", rev: STEP2 });
  ok(r.ok, "list@step2 ok");
  const paths = r.value.entries.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ["a.txt", "n.txt", "sub"], "step2 snapshot = post-rename/add/delete tree: " + JSON.stringify(paths)); }
{ const r = await call("list", { sessionId: "sess-1", rev: STEP2, relPath: "sub" });
  ok(r.ok, "list@step2 sub ok");
  assert.deepStrictEqual(r.value.entries.map((e) => e.path), ["sub/s2.txt"], "subdir at step2 = the POST-RENAME name"); }
{ const r = await call("list", { sessionId: "sess-1", rev: STEP2, relPath: "no/such/dir" });
  ok(r.ok && r.value.entries.length === 0, "dir absent at the rev → empty listing (a state): " + JSON.stringify(r)); }
{ const r = await call("list", { sessionId: "sess-1", rev: "worktree" });
  ok(!r.ok && r.error.code === "bad-request", "rev='worktree' is not a change id → bad-request: " + JSON.stringify(r)); }
{ const r = await call("list", { sessionId: "sess-1", rev: "abc12" });
  ok(!r.ok && r.error.code === "bad-request", "too-short rev → bad-request"); }
{ const r = await call("list", { sessionId: "sess-1", rev: "deadbeef0000" });
  ok(!r.ok && r.error.code === "internal", "unresolvable rev → internal (envelope-legal): " + JSON.stringify(r)); }
{ const r = await call("list", { sessionId: "sess-1", rev: STEP2, relPath: "../escape" });
  ok(!r.ok && r.error.code === "workspace-invalid-path", "snapshot containment: .. escape → workspace-invalid-path: " + JSON.stringify(r)); }

{ const r = await call("list", { sessionId: "sess-1", rev: STEP2 });
  ok(r.ok, "list@step2 ok (changeset): " + JSON.stringify(r?.error ?? null));
  const by = Object.fromEntries((r.value.commitChanges || []).map((e) => [e.path, e]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["a.txt", "k.txt", "n.txt", "sub/s2.txt"], "step2's own changeset (vs parent): " + JSON.stringify(r.value.commitChanges));
  ok(by["a.txt"].status === "M", "M a.txt at step2");
  ok(by["n.txt"].status === "A", "A n.txt at step2");
  ok(by["k.txt"].status === "D", "D k.txt at step2");
  ok(by["sub/s2.txt"].status === "R" && by["sub/s2.txt"].oldPath === "sub/s.txt", "R sub/s2.txt keeps oldPath: " + JSON.stringify(by["sub/s2.txt"]));
  ok(!by["b.txt"] && !by["c.txt"], "worktree-only changes never leak into the commit's set"); }
{ const r = await call("list", { sessionId: "sess-1", rev: BASE0 });
  const by = Object.fromEntries((r.value.commitChanges || []).map((e) => [e.path, e]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["a.txt", "k.txt", "sub/s.txt"], "baseline's changeset vs the empty tree: " + JSON.stringify(r.value.commitChanges));
  ok(Object.values(by).every((e) => e.status === "A"), "all adds at the first commit"); }
{ const r = await call("list", { sessionId: "sess-1", rev: STEP2, relPath: "sub" });
  ok(r.ok && Array.isArray(r.value.commitChanges) && r.value.commitChanges.length === 4, "a SCOPED dir listing carries the FULL changeset (the rollup prefix-filters client-side): " + JSON.stringify(r.value.commitChanges)); }
{ const r = await call("list", { sessionId: "sess-1" });
  ok(r.ok && r.value.commitChanges === undefined, "worktree-mode listing carries NO commitChanges"); }

{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "a.txt", rev: BASE0 });
  ok(r.ok && r.value.kind === "text", "fileshow@baseline text: " + JSON.stringify(r?.error ?? null));
  assert.strictEqual(r.value.text, "l1\nl2\nl3\n", "baseline bytes (DIFFERENT from the worktree content): " + JSON.stringify(r.value.text)); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "a.txt", rev: STEP2 });
  ok(r.ok && r.value.text === "l1\nl2 CHANGED\nl3\n", "step2 bytes"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "k.txt", rev: BASE0 });
  ok(r.ok && r.value.text === "keep\n", "file deleted in step2 still readable AT baseline"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "k.txt", rev: STEP2 });
  ok(!r.ok && r.error.code === "internal", "file absent at the rev → internal (envelope-legal): " + JSON.stringify(r)); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "n.txt", rev: STEP2 });
  ok(r.ok && r.value.text === "brand new\n", "file deleted from the WORKTREE browsable in the commit"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "sub/s.txt", rev: BASE0 });
  ok(r.ok && r.value.text === "s1\n", "pre-rename path readable at baseline"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "sub/s2.txt", rev: BASE0 });
  ok(!r.ok, "post-rename path absent at baseline: " + JSON.stringify(r)); }
await writeFile(join(ws, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
// a real 1×1 PNG (v1), the displayable-binary path (the base64 `data` field)
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
await writeFile(join(ws, "pic.png"), PNG1);
ok((await jjIn(ws, ["commit", "-m", "bin"])).code === 0, "binary committed (folds the current worktree)");
const BIN = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "bin.dat", rev: BIN });
  ok(r.ok && r.value.kind === "binary", "binary at a rev → binary card, not text: " + JSON.stringify(r?.value ?? r?.error));
  ok(r.value.size === 5, "binary size echoed");
  ok(r.value.data === undefined, "non-displayable binary → metadata only (no data)"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "pic.png", rev: BIN });
  ok(r.ok && r.value.kind === "binary" && r.value.type === "image/png", "png at a rev → displayable binary: " + JSON.stringify(r?.value ?? r?.error));
  assert.strictEqual(Buffer.from(r.value.data, "base64").toString("hex"), PNG1.toString("hex"), "png BYTES round-trip through the base64 data field"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "pic.png", rev: BASE0 });
  ok(!r.ok && r.error.code === "internal", "png absent at an older rev → internal"); }
// v2: a different byte + an OVER-CAP png (8-byte magic + 1_001_992 NULs =
// 1_002_000 total, inside maxBuffer), the newer rev's bytes must be v2's,
// and the over-cap image gets NO data (a truncated image is broken, and the
// binary card with its size is the honest view).
const PNG2 = Buffer.from(PNG1); PNG2[PNG2.length - 1] = 0x42;
await writeFile(join(ws, "pic.png"), PNG2);
await writeFile(join(ws, "big.png"), Buffer.concat([PNG1.subarray(0, 8), Buffer.alloc(1_001_992, 0)]));
ok((await jjIn(ws, ["commit", "-m", "pic2"])).code === 0, "png v2 + over-cap png committed");
const PIC2 = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "pic.png", rev: PIC2 });
  assert.strictEqual(Buffer.from(r.value.data, "base64").toString("hex"), PNG2.toString("hex"), "bytes AT the NEWER rev (the v2 image, not v1)"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "big.png", rev: PIC2 });
  ok(r.ok && r.value.kind === "binary" && r.value.type === "image/png", "over-cap png sniffed: " + JSON.stringify({ ok: r.ok, type: r?.value?.type, err: r?.error }));
  ok(r.value.size > 1_000_000 && r.value.data === undefined, "over the cap → NO data (truncated image = broken): " + JSON.stringify({ size: r.value?.size, hasData: !!r.value?.data })); }

// binary DIFF at a change id: the host attaches the file's BYTES at the rev
// and at its parent (`<rev>-`), old|new rendering for displayable images.
{ const r = await call("diff", { sessionId: "sess-1", relPath: "pic.png", base: BIN });
  ok(r.ok && r.value.binary, "binary patch carries the binary block: " + JSON.stringify(r?.value && Object.keys(r.value)));
  ok(r.value.binary.old === null, "NEW file: no old side: " + JSON.stringify(r.value.binary.old));
  ok(r.value.binary.new && r.value.binary.new.type === "image/png", "new side sniffed: " + JSON.stringify(r.value.binary.new));
  assert.strictEqual(Buffer.from(r.value.binary.new.data, "base64").toString("hex"), PNG1.toString("hex"), "new-side bytes = the committed png"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "pic.png", base: PIC2 });
  ok(r.ok && r.value.binary && r.value.binary.old && r.value.binary.new, "MODIFIED file: both sides: " + JSON.stringify(r?.value && Object.keys(r.value.binary)));
  assert.strictEqual(Buffer.from(r.value.binary.old.data, "base64").toString("hex"), PNG1.toString("hex"), "OLD side = the PARENT's bytes (the x- read)");
  assert.strictEqual(Buffer.from(r.value.binary.new.data, "base64").toString("hex"), PNG2.toString("hex"), "NEW side = the rev's bytes"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "pic.png", base: PIC2, noBinary: true });
  ok(r.ok && r.value.binary === undefined, "noBinary (the poll's refresh) → no binary block"); }
{ const r = await call("diff", { sessionId: "sess-1", relPath: "bin.dat", base: BIN });
  ok(r.ok && r.value.binary && r.value.binary.new && r.value.binary.new.data === undefined, "non-displayable binary → block without data (the card): " + JSON.stringify(r?.value?.binary)); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "a.txt", rev: STEP2, });
  ok(r.ok, "fileshow ok shape"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "a.txt" });
  ok(!r.ok && r.error.code === "bad-request", "missing rev → bad-request"); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "a.txt", rev: "worktree" });
  ok(r.ok && r.value.kind === "text" && r.value.text === "l1\nl2 CHANGED\nl3\n", "rev 'worktree' → the LIVE worktree file (not a rev): " + JSON.stringify(r)); }
{ const r = await call("fileshow", { sessionId: "sess-1", relPath: "/etc/passwd", rev: STEP2 });
  ok(!r.ok && r.error.code === "workspace-invalid-path", "absolute → workspace-invalid-path"); }
{ const r = await call("fileshow", { sessionId: "sess-2", relPath: "x.txt", rev: STEP2 });
  ok(!r.ok && r.error.code === "internal", "non-jj workspace → internal (not-a-workspace mapped): " + JSON.stringify(r)); }

{ const r1 = await call("list", { sessionId: "sess-2" });
  ok(r1.ok, "plain workspace still lists: " + JSON.stringify(r1?.error ?? null));
  ok(r1.value.vcs?.ok === false && r1.value.vcs.code === "not-a-workspace", "non-jj degrades: " + JSON.stringify(r1.value.vcs));
  const r2 = await call("list", { sessionId: "sess-2" });
  ok(r2.value.vcs?.ok === false && r2.value.vcs.code === "not-a-workspace", "failure cached (force=false): " + JSON.stringify(r2.value.vcs));
  const r3 = await call("list", { sessionId: "sess-2", force: true });
  ok(r3.value.vcs?.code === "not-a-workspace", "force re-probes (still not-a-workspace): " + JSON.stringify(r3.value.vcs)); }
{ const r = await call("diff", { sessionId: "sess-2", relPath: "x.txt", base: "worktree" });
  ok(!r.ok && r.error.code === "internal", "diff on non-jj workspace → internal (envelope-legal): " + JSON.stringify(r)); }

{
  const mk = (ch) => Array.from({ length: 8000 }, (_, i) => `line ${i} ${ch.repeat(100)}`).join("\n") + "\n";
  await writeFile(join(ws, "big.txt"), mk("x"));
  await rm(join(ws, "pic.png")); // the big0 commit DELETES pic.png (the binary-delete case)
  ok((await jjIn(ws, ["commit", "-m", "big0"])).code === 0, "big baseline committed");
  const BIG0 = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
  await writeFile(join(ws, "big.txt"), mk("y"));
  const r = await call("diff", { sessionId: "sess-1", relPath: "big.txt", base: "worktree" });
  ok(r.ok, "big diff ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.truncated === true, "big diff flagged truncated");
  ok(r.value.patch.length <= 1000000, "patch capped at 1 MB: " + r.value.patch.length);
  ok(r.value.patch.endsWith("\n"), "cap cuts at a line boundary (client parser stays in sync)");
  { const r2 = await call("diff", { sessionId: "sess-1", relPath: "pic.png", base: BIG0 });
    ok(r2.ok && r2.value.binary, "deleted-binary diff ok: " + JSON.stringify(r2?.error ?? null));
    ok(r2.value.binary.new === null && r2.value.binary.old, "DELETED file: no new side, old side present: " + JSON.stringify(Object.keys(r2.value.binary)));
    assert.strictEqual(Buffer.from(r2.value.binary.old.data, "base64").toString("hex"), PNG2.toString("hex"), "old side = the parent's (last surviving) bytes"); }
}

// A binary RENAME (identical bytes): jj's --git output carries only the
// rename lines (no "Binary files" marker), and the two sides live at
// DIFFERENT paths. The endpoint must still attach both sides' bytes: the
// old side read at the parent under `rename from`, the new side at the rev
// under `rename to`. Without that, the diff view shows a bare "no changes"
// for the renamed image. (jj detects a rename only when the bytes are
// unchanged; a changed rename arrives as add+delete, like any add.)
{
  await writeFile(join(ws, "pic3.png"), PNG2);
  ok((await jjIn(ws, ["commit", "-m", "add pic3"])).code === 0, "pic3 committed");
  await rename(join(ws, "pic3.png"), join(ws, "pic4.png"));
  ok((await jjIn(ws, ["commit", "-m", "rename pic3"])).code === 0, "pic3→pic4 rename committed");
  const P4 = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
  const r = await call("diff", { sessionId: "sess-1", relPath: "pic4.png", base: P4 });
  ok(r.ok, "rename-binary diff ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.patch.includes("rename from pic3.png") && r.value.patch.includes("rename to pic4.png"), "patch is a rename: " + r.value.patch);
  ok(!r.value.patch.includes("Binary files"), "jj rename diff carries no binary marker: " + r.value.patch);
  ok(r.value.binary, "marker-less rename still carries the binary block: " + JSON.stringify(r.value && Object.keys(r.value)));
  assert.strictEqual(Buffer.from(r.value.binary.old.data, "base64").toString("hex"), PNG2.toString("hex"), "OLD side read under rename from (the parent's pic3.png)");
  assert.strictEqual(Buffer.from(r.value.binary.new.data, "base64").toString("hex"), PNG2.toString("hex"), "NEW side read under rename to (the rev's pic4.png)");
  const r2 = await call("diff", { sessionId: "sess-1", relPath: "pic4.png", base: P4, noBinary: true });
  ok(r2.ok && r2.value.binary === undefined, "noBinary skips the rename's byte reads too");
}

// A dash-prefixed path must follow a `--` separator in jj file list/show, or jj parses it as a flag.
{
  await writeFile(join(ws, "--dash.txt"), "dash\n");
  ok((await jjIn(ws, ["commit", "-m", "dash"])).code === 0, "dash-prefixed file committed");
  const DASH = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
  const r = await call("list", { sessionId: "sess-1", rev: DASH });
  ok(r.ok, "list@dash ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.entries.some((e) => e.path === "--dash.txt"), "dash-prefixed path listed (the `--` separator): " + JSON.stringify(r.value.entries.map((e) => e.path)));
  const r2 = await call("fileshow", { sessionId: "sess-1", relPath: "--dash.txt", rev: DASH });
  ok(r2.ok && r2.value.text === "dash\n", "fileshow of the dash path at the rev: " + JSON.stringify(r2?.error ?? r2?.value));
}

// Glob metacharacters in a path: jj fileset args are globs when they contain
// glob chars, so an unescaped `a*b.txt` would also diff/show/list the sibling
// `aXb.txt` (verified against jj 0.44).
{
  await writeFile(join(ws, "aXb.txt"), "ax\n");
  await writeFile(join(ws, "a*b.txt"), "ab\n");
  await writeFile(join(ws, "aXb.txt"), "ax2\n"); // BOTH change in the commit,
  await writeFile(join(ws, "a*b.txt"), "ab2\n"); // so a glob leak shows up
  ok((await jjIn(ws, ["commit", "-m", "glob"])).code === 0, "glob-metachar files committed");
  const GLOB = (await jjWorkspaceStatus(ws, { force: true })).commits[0].id;
  const r = await call("diff", { sessionId: "sess-1", relPath: "a*b.txt", base: GLOB });
  ok(r.ok, "glob-metachar diff ok: " + JSON.stringify(r?.error ?? null));
  ok(r.value.patch.includes("a*b.txt") && !r.value.patch.includes("aXb.txt"), "escaped path scopes to the literal file (no glob sibling leak): " + r.value.patch);
  const r2 = await call("fileshow", { sessionId: "sess-1", relPath: "a*b.txt", rev: GLOB });
  ok(r2.ok && r2.value.text === "ab2\n", "fileshow of the glob-metachar path (no sibling bytes): " + JSON.stringify(r2?.error ?? r2?.value));
}

{
  const big = join(base, "big");
  await runJj(base, ["git", "init", big]);
  await mkdir(join(big, "sub"));
  await writeFile(join(big, "top.txt"), "t\n");
  ok((await runJj(big, ["commit", "-m", "b0"])).code === 0, "big baseline");
  await writeFile(join(big, "top.txt"), "t2\n");       // outside the sub "workspace"
  await writeFile(join(big, "sub", "in.txt"), "i\n");  // inside it
  const stC = await jjWorkspaceStatus(join(big, "sub"));
  ok(stC.ok, "sub-workspace status ok: " + JSON.stringify(stC));
  const paths = stC.changes.map((e) => e.path);
  ok(paths.includes("in.txt") && !paths.includes("../top.txt"), "outside-workspace change filtered: " + JSON.stringify(paths));
}

// jj's `diff -r <merge>` (the dropdown's payload) is the commit's own
// contribution over its parent(s), `jj log -p` semantics. A clean auto-merge
// contributes nothing, so the patch is empty (the client shows its "no
// changes in this commit" note). A conflicted merge's resolution is what
// shows instead.
{
  const m = join(base, "mergews");
  await runJj(base, ["git", "init", m]);
  await writeFile(join(m, "f.txt"), "a\n");
  ok((await runJj(m, ["commit", "-m", "m0"])).code === 0, "m0");
  await writeFile(join(m, "f.txt"), "ab\n");
  ok((await runJj(m, ["commit", "-m", "m1"])).code === 0, "m1");
  await writeFile(join(m, "x.txt"), "x\n");
  ok((await runJj(m, ["commit", "-m", "m2"])).code === 0, "m2");
  const idLog = (await runJj(m, ["--no-integrate-operation", "--color", "never", "log", "-G", "-T", 'change_id.short() ++ " " ++ description.first_line() ++ "\\n"'])).out;
  const pick = (d) => idLog.split("\n").find((l) => l.trim().endsWith(" " + d))?.trim().split(" ")[0];
  const merge = await runJj(m, ["new", pick("m1") + "|" + pick("m2"), "-m", "mm"]);
  ok(merge.code === 0, "merge commit made: " + merge.err);
  // The merge sits at @ (jj's "uncommitted" position), the list shows
  // ancestors(@-), i.e. commits BEHIND the worktree. Move the worktree forward
  // (jj new, NOT jj commit, commit -m would OVERWRITE the merge's
  // description) so the merge becomes a real @- entry.
  ok((await runJj(m, ["new", "-m", "post"])).code === 0, "worktree moved past the merge");
  const stM = await jjWorkspaceStatus(m, { force: true });
  ok(stM.ok && stM.commits.some((c) => c.description === "mm"), "merge listed in commits: " + JSON.stringify(stM.commits));
  ok(stM.commits.find((c) => c.description === "mm")?.empty === true, "clean merge flagged (empty) like jj log: " + JSON.stringify(stM.commits));
  ok(stM.commits.find((c) => c.description === "m1")?.empty === false, "real commit not flagged empty: " + JSON.stringify(stM.commits));
  const MM = stM.commits.find((c) => c.description === "mm").id;
  const r = await jj(m, ["diff", "-r", MM, "--git"]);
  ok(r.ok && r.value === "", "clean merge's own diff is EMPTY (jj log -p semantics): " + JSON.stringify(r.ok ? r.value : r.code));
}

await rm(base, { recursive: true, force: true });
console.log(`jj: ${n} assertions passed (parse + real jj ${await new Promise((r) => execFile("jj", ["--version"], (_, so) => r(so.trim().split("\n")[0])))})`);
