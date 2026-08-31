import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import assert from "node:assert";
import {
  git, parseNameStatus, parseUntracked, parseUnmerged, parseHead, parseCommitLog,
  unquoteGitPath, insideWorkspace, isBadRevision, gitWorkspaceStatus, gitUntrackedDiff,
  gitCommitChanges, gitSnapshotListing, gitFileShow,
} from "../dist/git.js";
import { WorkspacePathError } from "../dist/containment.js";
import { apply } from "../dist/index.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

// unquoteGitPath: git C-quoting, the residue after core.quotepath=0.
eq(unquoteGitPath("plain.txt"), "plain.txt", "unquoted path passes through");
eq(unquoteGitPath("my file.txt"), "my file.txt", "spaces are not quoted (quotepath=0)");
eq(unquoteGitPath('"a b.txt"'), "a b.txt", "wrapper quotes stripped");
eq(unquoteGitPath('"a\\"q.txt"'), 'a"q.txt', 'escaped quote');
eq(unquoteGitPath('"a\\\\b.txt"'), "a\\b.txt", "escaped backslash");
eq(unquoteGitPath('"\\303\\274"'), "ü", "octal escape (0xC3 0xBC = ü)");
eq(unquoteGitPath('"\\t\\n"'), "\t\n", "t/n escapes");

eq(parseNameStatus("M\ta.txt\nA\tb/c.txt\nD\td.txt"),
  [
    { path: "a.txt", status: "M" },
    { path: "b/c.txt", status: "A" },
    { path: "d.txt", status: "D" },
  ], "plain letters");
eq(parseNameStatus("R100\tsub/s.txt\tsub/s2.txt"),
  [{ path: "sub/s2.txt", status: "R", oldPath: "sub/s.txt" }], "rename (3-field)");
eq(parseNameStatus("R92\told.txt\tnew.txt"),
  [{ path: "new.txt", status: "R", oldPath: "old.txt" }], "rename, any similarity");
eq(parseNameStatus("C100\tsrc.txt\tdest.txt"),
  [{ path: "dest.txt", status: "A", oldPath: "src.txt" }], "copy maps to A at the destination");
eq(parseNameStatus("T\tt.txt"),
  [{ path: "t.txt", status: "M" }], "typechange maps to M");
eq(parseNameStatus("M\tmy file.txt"),
  [{ path: "my file.txt", status: "M" }], "path with spaces");
eq(parseNameStatus('M\t"we\\"ird.txt"'),
  [{ path: 'we"ird.txt', status: "M" }], "C-quoted path unquoted");
eq(parseNameStatus(""), [], "empty input");
eq(parseNameStatus("junk line\n\n  \n"), [], "unknown lines skipped");

eq(parseUntracked("a.txt\nsub/b.txt\n"), ["a.txt", "sub/b.txt"], "one per line");
eq(parseUntracked(""), [], "empty input");
eq(parseUntracked('"a b.txt"\n'), ["a b.txt"], "quoted line unquoted");

eq(parseUnmerged("1 100644 aaa 2 100644 bbb\tfile.txt\n3 100644 ccc\tfile.txt\n"),
  ["file.txt"], "stages deduped to the path");
eq(parseUnmerged(""), [], "clean → none");
eq(parseUnmerged("no-tab line\n"), [], "non-conforming lines skipped");

eq(parseHead("f11e978bb855abcdef0123456789abcdef0123\tbase commit\n"),
  { id: "f11e978bb855", description: "base commit" }, "head sliced to 12 hex");
eq(parseHead("f11e978bb855\t\n"), { id: "f11e978bb855", description: "" }, "empty subject");
assert.strictEqual(parseHead(""), null, "no input → null");
assert.strictEqual(parseHead("no tab here\n"), null, "no TSV line → null");
n += 2;

// same containment contract as the jj side
ok(insideWorkspace("a.txt") && insideWorkspace("sub/b.txt") && insideWorkspace("a/../b.txt"), "inside ok");
ok(!insideWorkspace("") && !insideWorkspace("../x") && !insideWorkspace("/abs") && !insideWorkspace("a/../../x"), "escapes rejected");

ok(isBadRevision({ ok: false, message: "fatal: bad revision 'HEAD'" }), "bad revision");
ok(isBadRevision({ ok: false, message: "error: unknown revision HEAD~1" }), "unknown revision");
ok(!isBadRevision({ ok: false, code: "not-a-workspace", message: "fatal: not a git repository" }), "not-a-repo is not a bad revision");
ok(!isBadRevision({ ok: true, value: "" }), "success is not a bad revision");

const hasGit = await new Promise((res) => execFile("git", ["--version"], (e) => res(!e)));
if (!hasGit) {
  console.log(`git: pure tests only (${n} assertions) — no git on PATH, I/O sections skipped`);
  process.exit(0);
}

const runGit = (cwd, args) => new Promise((res) =>
  execFile("git", args, { cwd }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: so, err: se, msg: e ? String(e.message || "") : "" })));

const base = await mkdtemp(join(tmpdir(), "filez-git-"));
const ws = join(base, "ws");
await mkdir(ws);
// PURE git repo (no jj), a co-located repo would resolve to the jj backend
// in the real dispatch. Config inside the fixture only.
ok((await runGit(ws, ["init", "-q"])).code === 0, "git init");
await runGit(ws, ["config", "user.email", "test@example.com"]);
await runGit(ws, ["config", "user.name", "TestUser"]);

await writeFile(join(ws, "a.txt"), "l1\nl2\nl3\n");
await writeFile(join(ws, "k.txt"), "keep\n");
await writeFile(join(ws, "mv.txt"), "move me\n");
await writeFile(join(ws, "s.txt"), "original\n");
await writeFile(join(ws, ".gitignore"), "ignored.txt\n");
ok((await runGit(ws, ["add", "-A"])).code === 0, "stage baseline");
ok((await runGit(ws, ["commit", "-qm", "base commit"])).code === 0, "baseline commit");
const sha = (await runGit(ws, ["rev-parse", "HEAD"])).out.trim();
ok(/^[0-9a-f]{40}$/.test(sha), "fixture has a real sha");
await writeFile(join(ws, "a.txt"), "l1\nl2 CHANGED\nl3\n");            // M (unstaged)
await writeFile(join(ws, "s.txt"), "staged change\n");                  // M (staged)
await runGit(ws, ["add", "s.txt"]);
await writeFile(join(ws, "new.txt"), "brand new\n");                     // U
await rm(join(ws, "k.txt"));                                             // D (unstaged)
await mkdir(join(ws, "sub"));
await rename(join(ws, "mv.txt"), join(ws, "sub", "moved.txt"));          // R
// git detects renames only once the pair is in the index (diff.renames is
// on by default); the new file must be staged, or it is a D + a U.
await runGit(ws, ["add", "-A", "mv.txt", "sub/moved.txt"]);
await writeFile(join(ws, "ignored.txt"), "should not appear\n");         // gitignored → absent
await writeFile(join(ws, "üñí.txt"), "utf8 untracked\n");                // U, non-ASCII

const d1 = await git(ws, ["diff", "HEAD", "--name-status"]);
ok(d1.ok, "diff with differences → ok (exit 1 tolerated): " + JSON.stringify(d1).slice(0, 200));
ok(d1.ok && d1.value.includes("a.txt"), "diff content present");
const d2 = await git(ws, ["diff", "HEAD", "--", "nothing-here.txt"]);
ok(d2.ok && d2.value === "", "no-difference diff → ok, empty");

const plain = join(base, "plain");
await mkdir(plain);
const nw1 = await git(plain, ["diff", "HEAD", "--name-status"]);
ok(nw1.ok === false && nw1.code === "not-a-workspace", "non-repo → not-a-workspace: " + JSON.stringify(nw1));
const st0 = await gitWorkspaceStatus(plain);
ok(st0.ok === false && st0.code === "not-a-workspace", "status: non-repo → not-a-workspace");
const st0b = await gitWorkspaceStatus(plain); // cached, no re-probe
ok(st0b.ok === false && st0b.code === "not-a-workspace", "structural failure cached");
const st0c = await gitWorkspaceStatus(plain, { force: true });
ok(st0c.ok === false && st0c.code === "not-a-workspace", "force re-probes");

const st = await gitWorkspaceStatus(ws);
ok(st.ok, "status ok: " + JSON.stringify(st).slice(0, 300));
{
  const by = Object.fromEntries(st.changes.map((e) => [e.path, e]));
  ok(st.backend === "git", "backend tag is git");
  ok(st.head.marker === "HEAD", "marker is HEAD: " + JSON.stringify(st.head));
  ok(st.head.id === sha.slice(0, 12), "head id = first 12 hex of the real sha: " + st.head.id);
  ok(st.head.description === "base commit", "head subject");
  ok(by["a.txt"]?.status === "M" && by["a.txt"].base === "worktree", "M a.txt (unstaged)");
  ok(by["s.txt"]?.status === "M" && by["s.txt"].base === "worktree", "M s.txt (staged — diff HEAD sees both)");
  ok(by["new.txt"]?.status === "U" && by["new.txt"].base === "worktree", "U new.txt (untracked)");
  ok(by["üñí.txt"]?.status === "U", "U with a non-ASCII name (quotepath=0): " + JSON.stringify(Object.keys(by)));
  ok(by["k.txt"]?.status === "D", "D k.txt (deleted)");
  ok(by["sub/moved.txt"]?.status === "R" && by["sub/moved.txt"]?.oldPath === "mv.txt", "R mv.txt → sub/moved.txt: " + JSON.stringify(by["sub/moved.txt"]));
  ok(!by["ignored.txt"], "gitignored file absent (ls-files --exclude-standard)");
  ok(st.conflicts.length === 0, "no conflicts");
  eq(st.commits, [{ id: sha.slice(0, 12), description: "base commit" }], "single-commit repo: the root (HEAD) is in the list");
  ok(!by[".gitignore"] || by[".gitignore"].status !== "U", ".gitignore (tracked, unchanged) has no letter");
}

const ud = await gitUntrackedDiff(ws, "new.txt");
ok(ud.ok, "--no-index diff ok (exit 1 tolerated): " + JSON.stringify(ud).slice(0, 200));
ok(ud.ok && ud.value.startsWith("diff --git"), "diff-shaped header: " + ud.value.split("\n")[0]);
ok(ud.ok && ud.value.includes("new file mode"), "new file mode line (parseDiff's isNew hook)");
ok(ud.ok && ud.value.includes("+brand new"), "the file's content as additions");
await writeFile(join(ws, "empty-new.txt"), "");
const ud0 = await gitUntrackedDiff(ws, "empty-new.txt");
// git reports even an empty file as a new-file MODE addition: a header-only
// patch (no hunks), still exit 1, parseDiff renders it as "added, no lines".
ok(ud0.ok && ud0.value.startsWith("diff --git") && ud0.value.includes("new file mode") && !ud0.value.includes("@@"),
  "empty untracked file → header-only new-file patch: " + JSON.stringify(ud0).slice(0, 160));

await writeFile(join(ws, "c1.txt"), "first extra\n");
await runGit(ws, ["add", "-A"]);
ok((await runGit(ws, ["commit", "-qm", "mid commit"])).code === 0, "mid commit created");
await writeFile(join(ws, "c2.txt"), "second extra\n");
await writeFile(join(ws, "a.txt"), "l1\nl2 CHANGED again\nl3\n");
await runGit(ws, ["add", "-A"]);
ok((await runGit(ws, ["commit", "-qm", "top commit"])).code === 0, "top commit created");
const topSha = (await runGit(ws, ["rev-parse", "HEAD"])).out.trim();
const midSha = (await runGit(ws, ["rev-parse", "HEAD~1"])).out.trim();
const rootSha = (await runGit(ws, ["rev-parse", "HEAD~2"])).out.trim();

// HEAD INCLUDED (jj parity): the worktree entry above the list is the LIVE
// tree, a different view, the newest commit must stay individually reviewable.
const st3 = await gitWorkspaceStatus(ws);
ok(st3.head.id === topSha.slice(0, 12) && st3.head.description === "top commit", "head is the newest commit");
ok(st3.commits.length === 3, "dropdown lists all 3 commits incl HEAD: " + JSON.stringify(st3.commits));
eq(st3.commits[0], { id: topSha.slice(0, 12), description: "top commit" }, "HEAD first (newest-first)");
eq(st3.commits[1], { id: midSha.slice(0, 12), description: "mid commit" }, "then mid");
eq(st3.commits[2].id, rootSha.slice(0, 12), "root commit included (git's root is a real commit)");

const ccTop = await gitCommitChanges(ws, topSha);
const ccTopMap = Object.fromEntries(ccTop.map((e) => [e.path, e.status]));
ok(ccTopMap["c2.txt"] === "A", "top commit changeset includes A c2.txt");
ok(ccTopMap["a.txt"] === "M", "top commit changeset includes M a.txt");
const ccRoot = await gitCommitChanges(ws, rootSha);
ok(ccRoot.length >= 3 && ccRoot.every((e) => e.status === "A"), "root commit changeset is all A: " + JSON.stringify(ccRoot));
eq(await gitCommitChanges(ws, "0123456789abcdef"), [], "unresolvable rev → []");

const sl = await gitSnapshotListing(ws, midSha, "");
ok(!sl.error, "snapshot listing ok");
const slNames = sl.entries.map((e) => e.name);
ok(slNames.includes("c1.txt") && slNames.includes("a.txt"), "mid tree has c1.txt and a.txt");
ok(!slNames.includes("c2.txt"), "top commit's file absent at mid");
ok(!slNames.includes(".gitignore"), "hidden files hidden by default");
const slHidden = await gitSnapshotListing(ws, midSha, "", { showHidden: true });
ok(slHidden.entries.some((e) => e.name === ".gitignore"), "showHidden includes .gitignore");
const slSub = await gitSnapshotListing(ws, midSha, "sub");
eq(slSub.entries.map((e) => e.name), ["moved.txt"], "scoped snapshot listing (sub/ from rename)");
const slBad = await gitSnapshotListing(ws, "0123456789abcdef", "");
ok(slBad.error, "unresolvable rev → error shape");
await assert.rejects(() => gitSnapshotListing(ws, topSha, "../escape"), WorkspacePathError, "containment: ../escape rejected");

const fsMid = await gitFileShow(ws, midSha, "c1.txt");
eq(fsMid.kind, "text", "fileshow text kind");
eq(fsMid.text, "first extra\n", "fileshow bytes at mid commit");
const fsTop = await gitFileShow(ws, topSha, "a.txt");
eq(fsTop.text, "l1\nl2 CHANGED again\nl3\n", "fileshow reflects commit-specific content");
const fsGone = await gitFileShow(ws, rootSha, "c1.txt");
ok(fsGone.error, "fileshow path absent at rev → error");
await assert.rejects(() => gitFileShow(ws, topSha, "../escape.txt"), WorkspacePathError, "fileshow containment");

// --format= keeps the output a bare patch (no commit header); git show is root-commit-safe.
const cdRoot = await git(ws, ["show", "--format=", rootSha, "--", "a.txt"]);
ok(cdRoot.ok && cdRoot.value.startsWith("diff --git") && cdRoot.value.includes("new file mode"), "root-commit file diff (vs empty tree)");
const cdTop = await git(ws, ["show", "--format=", topSha, "--", "a.txt"]);
ok(cdTop.ok && cdTop.value.includes("+l2 CHANGED again"), "top commit per-file patch");
const cdNone = await git(ws, ["show", "--format=", topSha, "--", "c1.txt"]);
ok(cdNone.ok && cdNone.value === "", "file untouched by commit → empty patch (state)");

// Wire contract: every error code must be a legal member of the closed
// union, or the client rejects the whole response.
let gitHandler = null;
apply({
  get(name) {
    if (name === "connection") return { rpc: { handle: (ch, h) => { gitHandler = h; } } };
    if (name === "sessions") return { get: (id) => (id === "git-sess" ? { id, header: { cwd: ws } } : undefined) };
    if (name === "sandboxPolicy") return { resolve: ({ session }) => ({ mode: "workspace-write", workspaceRoot: session?.header?.cwd }) };
    return undefined;
  },
  on() {}, effect: (fn) => { fn(); }, logger: { info() {}, error() {} },
});
ok(typeof gitHandler === "function", "browse handler registered on the git repo");
const gcall = (endpoint, payload) => gitHandler(endpoint, payload);
{
  const r = await gcall("list", { sessionId: "git-sess", rev: midSha.slice(0, 12) });
  ok(r.ok, "list@rev ok: " + JSON.stringify(r).slice(0, 300));
  const names = r.value.entries.map((e) => e.name);
  ok(names.includes("c1.txt") && !names.includes("c2.txt"), "snapshot listing = the mid tree: " + JSON.stringify(names));
  ok(r.value.vcs && r.value.vcs.ok === true && r.value.vcs.backend === "git", "vcs block reports the git backend");
  ok(Array.isArray(r.value.vcs.commits) && r.value.vcs.commits.some((c) => c.id === rootSha.slice(0, 12)), "dropdown commits in the vcs block");
  const cc = Object.fromEntries((r.value.commitChanges ?? []).map((e) => [e.path, e.status]));
  ok(cc["c1.txt"] === "A" && cc["a.txt"] === "M", "commitChanges = the selected commit's own changeset: " + JSON.stringify(cc));
  n++;
}
{
  // regression: diff at the ROOT commit (a parentless sha) must succeed,
  // git show diffs the root against the empty tree.
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "a.txt", base: rootSha.slice(0, 12) });
  ok(r.ok, "diff at the ROOT commit ok (root-safe): " + JSON.stringify(r).slice(0, 300));
  ok(r.value.patch.startsWith("diff --git") && r.value.patch.includes("new file mode"), "root diff = the full-added patch");
  ok(r.value.base === rootSha.slice(0, 12), "base echoed");
  n++;
}
{
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "a.txt", base: topSha.slice(0, 12) });
  ok(r.ok && r.value.patch.includes("+l2 CHANGED again"), "diff at the top commit shows its change");
  n++;
}
{
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "c1.txt", base: topSha.slice(0, 12) });
  ok(r.ok && r.value.patch === "", "file untouched by the commit → empty patch (a state, not an error)");
  n++;
}
{
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "a.txt", base: "0123456789abcdef" });
  ok(!r.ok && r.error.code === "internal" && typeof r.error.message === "string", "unresolvable base → internal (envelope-legal): " + JSON.stringify(r).slice(0, 200));
  ok(r.error.details && typeof r.error.details === "object" && Object.keys(r.error.details).length === 0, "internal carries details {}");
  n++;
}
{
  // git treats an unescaped pathspec with glob chars as a glob (`a*b.txt`
  // would also match `aXb.txt`), so the endpoint's pathspecs carry `:(literal)`.
  await writeFile(join(ws, "aXb.txt"), "ax\n");
  await writeFile(join(ws, "a*b.txt"), "ab\n");
  ok((await runGit(ws, ["add", "aXb.txt", "a*b.txt"])).code === 0, "stage glob-metachar files");
  ok((await runGit(ws, ["commit", "-qm", "glob0"])).code === 0, "glob0 commit");
  await writeFile(join(ws, "aXb.txt"), "ax2\n"); // BOTH change in the commit,
  await writeFile(join(ws, "a*b.txt"), "ab2\n"); // so a glob leak shows up
  ok((await runGit(ws, ["add", "aXb.txt", "a*b.txt"])).code === 0, "stage changes");
  ok((await runGit(ws, ["commit", "-qm", "glob1"])).code === 0, "glob1 commit");
  const globSha = (await git(ws, ["rev-parse", "HEAD"])).value.trim();
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "a*b.txt", base: globSha.slice(0, 12) });
  ok(r.ok, "glob-metachar diff ok: " + JSON.stringify(r).slice(0, 200));
  ok(r.value.patch.includes("a*b.txt") && !r.value.patch.includes("aXb.txt"), ":(literal) pathspec scopes to the literal file (no glob sibling leak): " + r.value.patch);
  const r2 = await gcall("fileshow", { sessionId: "git-sess", relPath: "a*b.txt", rev: globSha.slice(0, 12) });
  ok(r2.ok && r2.value.text === "ab2\n", "fileshow of the glob-metachar path (rev:path is already literal): " + JSON.stringify(r2).slice(0, 200));
  n++;
}
{
  // A binary RENAME in git: `git show <sha> -- <new name>` shows only the
  // new-file half of the pair (the pathspec hides the old side), so the
  // endpoint recovers the pair from the commit's -M name-status and reads
  // the old bytes under the OLD name.
  // PNG magic + ~100 KB of filler: git's rename similarity is hunk-based, so
  // a few-byte change in a TINY blob scores below the default -M threshold
  // (add+delete) while the same change in a large one scores R099+.
  const GPNG1 = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), Buffer.from("ABCD".repeat(25000))]);
  const GPNG2 = Buffer.from(GPNG1); GPNG2[50000] ^= 0x42; GPNG2[60000] ^= 0x42; GPNG2[70000] ^= 0x42;
  await writeFile(join(ws, "old.png"), GPNG1);
  ok((await runGit(ws, ["add", "old.png"])).code === 0, "stage old.png");
  ok((await runGit(ws, ["commit", "-qm", "add old.png"])).code === 0, "old.png committed");
  await writeFile(join(ws, "new.png"), GPNG2);
  ok((await runGit(ws, ["rm", "-q", "old.png"])).code === 0, "old.png removed");
  ok((await runGit(ws, ["add", "new.png"])).code === 0, "stage new.png");
  ok((await runGit(ws, ["commit", "-qm", "rename old.png"])).code === 0, "rename committed");
  const renSha = (await runGit(ws, ["rev-parse", "HEAD"])).out.trim();
  const r = await gcall("diff", { sessionId: "git-sess", relPath: "new.png", base: renSha.slice(0, 12) });
  ok(r.ok, "rename-binary diff ok: " + JSON.stringify(r).slice(0, 200));
  ok(r.value.binary, "git rename-binary diff carries the binary block: " + JSON.stringify(r.value && Object.keys(r.value)));
  assert.strictEqual(Buffer.from(r.value.binary.old.data, "base64").toString("hex"), GPNG1.toString("hex"), "OLD side read under the OLD name (pair recovered from -M name-status)");
  assert.strictEqual(Buffer.from(r.value.binary.new.data, "base64").toString("hex"), GPNG2.toString("hex"), "NEW side read under the new name");
  n++;
}
{
  // fileshow dispatches to git (the verdict was set by the list@rev above)
  const r = await gcall("fileshow", { sessionId: "git-sess", relPath: "c1.txt", rev: midSha.slice(0, 12) });
  ok(r.ok && r.value.kind === "text" && r.value.text === "first extra\n", "fileshow bytes at a git rev: " + JSON.stringify(r).slice(0, 200));
  const r2 = await gcall("fileshow", { sessionId: "git-sess", relPath: "c1.txt", rev: rootSha.slice(0, 12) });
  ok(!r2.ok && r2.error.code === "internal", "fileshow path absent at the rev → internal, not a raw jj/git error code: " + JSON.stringify(r2).slice(0, 200));
  n++;
}
{
  const r = await gcall("list", { sessionId: "git-sess", relPath: "../escape" });
  ok(!r.ok && r.error.code === "workspace-invalid-path" && r.error.details.path === "../escape", "containment → workspace-invalid-path (envelope-legal)");
  n++;
}

// A workspace dir deleted out from under the session makes execFile fail
// with spawn ENOENT even though git IS on PATH. "git-missing" is a
// structural, per-workspace CACHED verdict (git.ts STRUCTURAL), labeling
// the transient dead-cwd case with it would poison every later probe.
{
  const deadWs = join(base, "dead-ws");
  await mkdir(deadWs);
  await rm(deadWs, { recursive: true, force: true });
  const gone = await git(deadWs, ["status"]);
  ok(gone.ok === false && gone.code === "git-error", "dead cwd → git-error, not the cached git-missing: " + JSON.stringify(gone));
  await rm(deadWs, { recursive: true, force: true });
}

const ws2 = join(base, "ws2");
await mkdir(ws2);
await runGit(ws2, ["init", "-q"]);
await runGit(ws2, ["config", "user.email", "test@example.com"]);
await runGit(ws2, ["config", "user.name", "TestUser"]);
await writeFile(join(ws2, "only.txt"), "hello\n");
const st2 = await gitWorkspaceStatus(ws2);
ok(st2.ok, "no-commits repo status ok: " + JSON.stringify(st2).slice(0, 300));
ok(st2.head.id === "" && st2.head.marker === "HEAD", "head degrades to the empty marker");
ok(st2.changes.length === 1 && st2.changes[0].path === "only.txt" && st2.changes[0].status === "U", "everything is U");
ok(st2.commits.length === 0, "no commits yet → empty dropdown list");
const ud2 = await gitUntrackedDiff(ws2, "only.txt");
ok(ud2.ok && ud2.value.includes("+hello"), "U diff works with no HEAD at all (--no-index needs no repo state)");

const gitVersion = (await runGit(plain, ["--version"])).out.trim().replace(/^git version /, "");
await rm(base, { recursive: true, force: true });
console.log(`git: ${n} assertions passed (parse + real git ${gitVersion})`);
