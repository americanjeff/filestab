// Read-only git backend: the fallback for a git repo that is not a jj repo
// (jj wins on co-located repos. index.ts dispatches jj first). The code
// never calls `git status`. That command refreshes `.git/index`. Every
// read stays read-only.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { resolveInWorkspace } from "./containment.js";
import { snapshotDirListing, finishFileShow, FILE_SHOW_CAP } from "./snapshot.js";

// Failure codes safe to remember per workspace (structural, not transient).
const STRUCTURAL = new Set(["git-missing", "not-a-workspace"]);
const gitFailCache = new Map<string, string>(); // workspaceRoot → structural failure code

const MAX_COMMITS = 50; // dropdown length (mirrors src/jj.ts)

export type GitCode = "git-missing" | "not-a-workspace" | "git-timeout" | "git-overflow" | "git-error";
export type GitResult =
  | { ok: true; value: string | Buffer }
  | { ok: false; code: GitCode; message: string };

/**
 * Runs git in the workspace. The function always resolves. It returns a
 * GitResult (it never throws). Exit code 1 is a SUCCESS for the diff
 * commands (git signals "differences exist" with 1). Every other non-zero
 * exit code is a failure.
 */
export function git(
  workspaceRoot: string,
  args: string[],
  { maxBuffer = 4 * 1024 * 1024, timeout = 8000, encoding = "utf8" }: { maxBuffer?: number; timeout?: number; encoding?: BufferEncoding | "buffer" } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workspaceRoot, maxBuffer, timeout, encoding },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as { code?: string | number; message?: string; killed?: boolean };
          if (e.code === "ENOENT") {
            // ENOENT is ambiguous: the git binary is missing (structural,
            // safe to cache) OR the cwd (workspace dir) is gone (transient,
            // caching it as git-missing poisons the verdict forever).
            // The one-shot probe decides which.
            return gitBinaryOnPath().then((onPath) => resolve(onPath
              ? { ok: false, code: "git-error", message: "git spawn failed (workspace directory missing?)" }
              : { ok: false, code: "git-missing", message: "git binary not found on PATH" }));
          }
          const msg = (String(stderr || "").trim() || String(err.message || "").trim()).split("\n")[0] || "git failed";
          if (e.killed)
            return resolve({ ok: false, code: "git-timeout", message: "git timed out" });
          if (/maxBuffer length exceeded/i.test(msg))
            return resolve({ ok: false, code: "git-overflow", message: "git output exceeded the buffer cap" });
          if (e.code === 1 && !/fatal|error|warning/i.test(msg))
            return resolve({ ok: true, value: stdout as string | Buffer }); // "differences exist"
          if (/not a git repository/i.test(msg))
            return resolve({ ok: false, code: "not-a-workspace", message: msg });
          return resolve({ ok: false, code: "git-error", message: msg });
        }
        resolve({ ok: true, value: stdout as string | Buffer });
      });
  });
}

/**
 * The function prefixes a path with git's `:(literal)` pathspec magic so
 * it matches LITERALLY. Unescaped, a path with glob metacharacters
 * (`a*b.txt`) is a glob. It also matches sibling files (`aXb.txt`). The
 * code verifies this against git 2.55. `git show <rev>:<path>`, `ls-tree`
 * paths, and `--no-index` paths are already literal. The code must NOT add
 * this prefix to them.
 */
export function gitLiteralPath(p: string): string {
  return ":(literal)" + p;
}

// One-shot: is the git binary on PATH? `git --version` needs no
// repo and no cwd, so it isolates "binary missing" from "cwd missing".
let gitOnPath: Promise<boolean> | null = null;
function gitBinaryOnPath(): Promise<boolean> {
  if (!gitOnPath) {
    gitOnPath = new Promise((resolve) => {
      execFile("git", ["--version"], { timeout: 8000 }, (err) => resolve(!err));
    });
  }
  return gitOnPath;
}

/** Is this a "bad revision" failure (HEAD/HEAD~1 unresolvable, no commits yet)? */
export function isBadRevision(res: GitResult | null | undefined): boolean {
  return !!res && res.ok === false && /bad revision|unknown revision|ambiguous argument/i.test(res.message || "");
}

export interface NameStatusEntry {
  path: string;
  status: string;
  oldPath?: string | null;
}

export interface GitHead {
  id: string;
  description: string;
}

export interface GitCommitEntry {
  id: string;
  description: string;
}

/**
 * `git diff <a> <b> --name-status` (or `diff HEAD --name-status`) stdout →
 * [{ path, status, oldPath? }]. Letters: M/A/D/R/T/C. **T (typechange) maps
 * to M** (the badge set A|M|D|R|C|U has no typechange letter). **C (copy)
 * maps to A at the destination** (a copy creates a new tracked file).
 * R<C>/<C<C> use the 3-field form `R100\told\tnew` (path = new,
 * oldPath = old). The parser skips unknown lines (never fatal). Paths keep
 * spaces. The parser unquotes C-quoted lines (a path with `"` or a newline)
 * when possible.
 */
export function parseNameStatus(text: string | Buffer): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  for (const line of String(text).split("\n")) {
    let m = line.match(/^([MADT])\t(.+)$/);
    if (m) { out.push({ path: unquoteGitPath(m[2]!), status: m[1]! === "T" ? "M" : m[1]! }); continue; }
    m = line.match(/^([MRC])\d*\t(.+)\t(.+)$/);
    if (m) {
      const status = m[1]! === "R" ? "R" : "A"; // copy → added at the destination
      const o = unquoteGitPath(m[2]!);
      const nw = unquoteGitPath(m[3]!);
      if (o && nw) out.push({ path: nw, status, oldPath: o });
      continue;
    }
    // git C-quotes the whole line when the path has special characters and
    // no tab survived: `M\t"path with \"quote"` → the parser tries the
    // quoted rest.
    m = line.match(/^([MADT])\t(.+)$/);
    if (m) { out.push({ path: unquoteGitPath(m[2]!), status: m[1]! === "T" ? "M" : m[1]! }); continue; }
  }
  return out;
}

/**
 * `git ls-files --others --exclude-standard` stdout → [path]. One path per
 * line. With core.quotepath=0 the only remaining quoting is the C-quote
 * wrapper (paths that contain `"` or a newline).
 */
export function parseUntracked(text: string | Buffer): string[] {
  const out: string[] = [];
  for (const line of String(text).split("\n")) {
    if (line === "") continue;
    const p = unquoteGitPath(line);
    if (p) out.push(p);
  }
  return out;
}

/**
 * `git ls-files -u` stdout → unique unmerged paths. Line shape:
 * `<mode> <sha> [<mode> <sha>…]\t<path>`. The tab is the split point.
 */
export function parseUnmerged(text: string | Buffer): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    const p = line.slice(i + 1).trim();
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

/** `git log -1 --format=%H%x09%s` stdout → { id: 12-hex, description } | null. */
export function parseHead(text: string | Buffer): GitHead | null {
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([0-9a-f]{7,40})\t(.*)$/);
    if (m) return { id: m[1]!.slice(0, 12), description: m[2]! };
  }
  return null;
}

/**
 * `git log --format=%H%x09%s` stdout → [{ id: 12-hex, description }] (newest
 * first, capped at MAX_COMMITS). The shape is the same as jj's
 * parseCommitLog. Git ids are hex (sliced to 12, the same width as jj's
 * friendly 12-char change ids). The client's `[0-9a-z]` rev alphabet covers
 * both. The parser skips non-TSV lines (never fatal).
 */
export function parseCommitLog(text: string | Buffer): GitCommitEntry[] {
  const out: GitCommitEntry[] = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([0-9a-f]{7,40})\t(.*)$/);
    if (!m) continue;
    out.push({ id: m[1]!.slice(0, 12), description: m[2]! });
    if (out.length >= MAX_COMMITS) break;
  }
  return out;
}

/**
 * The function undoes git's C-quoting (a path wrapped in double quotes,
 * JSON-ish escapes: \" \\ \t \n and octal \NNN for the rest. The only cases
 * core.quotepath=0 leaves). The function returns a non-quoted path as-is.
 * Best-effort: an unparseable quoted line yields the raw inner text.
 */
export function unquoteGitPath(p: string): string {
  if (typeof p !== "string" || p.length < 2 || p[0] !== "\"" || p[p.length - 1] !== "\"") return p;
  const inner = p.slice(1, -1);
  // Octal escapes are raw BYTES (the UTF-8 encoding of the path). The code
  // builds the unquoted result byte-wise and decodes it as UTF-8 at the
  // end. "\303\274" is the 2-byte UTF-8 for ü, not two Latin-1 characters.
  const bytes: number[] = [];
  const push = (c: string) => { for (const b of Buffer.from(c, "utf8")) bytes.push(b); };
  let i = 0;
  while (i < inner.length) {
    const c = inner[i]!;
    if (c !== "\\") { push(c); i++; continue; }
    const n = inner[i + 1];
    if (n === undefined) break;
    if (n >= "0" && n <= "7") {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 1 + oct.length;
      continue;
    }
    const map: Record<string, string> = { a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': "\"", "\\": "\\", " ": " " };
    const mapped = map[n];
    push(mapped !== undefined ? mapped : n);
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A cwd-relative pathspec stays inside the workspace (no absolute, no `..` escape). */
export function insideWorkspace(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel)) return false;
  let depth = 0;
  for (const part of rel.split("/")) {
    if (part === "..") depth -= 1;
    else if (part !== "." && part !== "") depth += 1;
    if (depth < 0) return false;
  }
  return true;
}

export interface GitChangeEntry {
  path: string;
  status: string;
  oldPath: string | null;
  base: "worktree" | "conflict";
}

export type GitWorkspaceStatusResult =
  | {
      ok: true;
      backend: "git";
      head: { id: string; description: string; marker: string };
      changes: GitChangeEntry[];
      conflicts: string[];
      commits: GitCommitEntry[];
    }
  | { ok: false; code: GitCode; message?: string };

/**
 * One poll → the whole `vcs` block for the list response (git backend).
 * The function returns GitWorkspaceStatusResult. head.id is 12-hex (""
 * when no commits yet), marker "HEAD", change statuses A|M|D|R|C|U,
 * commits ≤50 newest first with HEAD INCLUDED (jj parity: the newest
 * commit stays reviewable).
 *
 * Changes are worktree-vs-HEAD (staged + unstaged). Git has no snapshot
 * boundary, so `diff HEAD` is the single source. Untracked files are the
 * **U** letter (jj never emits it, jj auto-snapshots). A conflict
 * (ls-files -u) overrides the letter and sets base "conflict".
 */
export async function gitWorkspaceStatus(
  workspaceRoot: string,
  { force = false }: { force?: boolean } = {},
): Promise<GitWorkspaceStatusResult> {
  if (!force) {
    const cached = gitFailCache.get(workspaceRoot);
    if (cached) return { ok: false, code: cached as GitCode };
  }
  const fail = (code: GitCode, message?: string): { ok: false; code: GitCode; message?: string } => {
    if (STRUCTURAL.has(code)) gitFailCache.set(workspaceRoot, code);
    return { ok: false, code, message: message || undefined };
  };

  // 1) tracked changes via `diff HEAD`. A no-commits-yet repo fails with a
  //    bad revision → head degrades. The untracked read still describes the
  //    workspace (everything is U there).
  const s1 = await git(workspaceRoot, ["diff", "HEAD", "--name-status"]);
  let tracked: NameStatusEntry[] = [];
  if (s1.ok) tracked = parseNameStatus(s1.value);
  else if (!isBadRevision(s1)) return fail(s1.code, s1.message);

  // 2) untracked + conflicts + head & commit list, in parallel (each failure
  //    non-fatal: the remaining letters/sources stand on their own). The log
  //    read serves both head (line 0) and the dropdown list (lines 1..N). A
  //    no-commits-yet repo fails both (head → empty marker, list → []).
  const [un, st, log] = await Promise.all([
    git(workspaceRoot, ["-c", "core.quotepath=0", "ls-files", "--others", "--exclude-standard"]),
    git(workspaceRoot, ["ls-files", "-u"]),
    git(workspaceRoot, ["log", "-n", String(MAX_COMMITS), "--format=%H%x09%s"]),
  ]);
  const untracked = un.ok ? parseUntracked(un.value).filter(insideWorkspace) : [];
  const conflicts = st.ok ? parseUnmerged(st.value).filter(insideWorkspace) : [];
  const logText = log.ok ? log.value : "";
  const head = log.ok ? parseHead(logText) : null;
  // Includes line 0 (HEAD): the dropdown's worktree entry is the LIVE tree
  // (a different view), so HEAD must stay selectable for its own diff.
  const commits = log.ok ? parseCommitLog(logText) : [];

  // 3) merge: tracked (worktree base) → U's (worktree base. The diff
  //    endpoint special-cases them via --no-index) → conflicts override.
  const keep = (e: NameStatusEntry) => insideWorkspace(e.path) || (e.oldPath !== null && e.oldPath !== undefined && insideWorkspace(e.oldPath));
  const byPath = new Map<string, GitChangeEntry>();
  for (const e of tracked.filter(keep))
    byPath.set(e.path, { path: e.path, status: e.status, oldPath: e.oldPath ?? null, base: "worktree" });
  for (const p of untracked) {
    const cur = byPath.get(p);
    if (cur) cur.status = cur.status === "C" ? "C" : "U"; // tracked+untracked is impossible. The code keeps C precedence.
    else byPath.set(p, { path: p, status: "U", oldPath: null, base: "worktree" });
  }
  for (const p of conflicts) {
    const cur = byPath.get(p);
    if (cur) cur.status = "C";
    else byPath.set(p, { path: p, status: "C", oldPath: null, base: "conflict" });
  }
  return {
    ok: true,
    backend: "git",
    head: { ...(head ?? { id: "", description: "" }), marker: "HEAD" },
    changes: [...byPath.values()],
    conflicts,
    commits,
  };
}

/**
 * The selected commit's own changeset (vs its parent. Root = vs the empty
 * tree): `git log -1 --name-status --format= <rev>` → [{ path, status,
 * oldPath }]. Same shape and letters as gitWorkspaceStatus's changes. The
 * output feeds the snapshot-mode badges/rollups (index.ts's
 * commitChanges slot). Root commits diff against the empty tree (git log's
 * default). A failure (non-git workspace, rewritten rev) → [] (badges
 * absent, the listing stands).
 */
export async function gitCommitChanges(workspaceRoot: string, rev: string): Promise<NameStatusEntry[]> {
  const s = await git(workspaceRoot, ["log", "-1", "--name-status", "--format=", rev]);
  if (!s.ok) return [];
  const keep = (e: NameStatusEntry) => insideWorkspace(e.path) || (e.oldPath !== null && e.oldPath !== undefined && insideWorkspace(e.oldPath));
  return parseNameStatus(s.value).filter(keep);
}

export type GitSnapshotListingResult =
  | { root: string; relPath: string; entries: { name: string; path: string; isDirectory: boolean; hidden: boolean }[]; truncated: boolean }
  | { error: string; message?: string; relPath: string };

/**
 * One directory of a git commit's snapshot (host): scoped `git ls-tree -r
 * --name-only <rev>` → snapshotDirListing (same pure synthesis as jj).
 * READ-ONLY. A dir pathspec scopes to its subtree (boundary match). The
 * root lists the whole tree (the code raises the buffer cap to 16 MB. A
 * full tree is thousands of entries). Paths are repo-root-relative.
 * Containment via resolveInWorkspace (it walks to the deepest EXISTING
 * ancestor, so a history-only dir still resolves). The function returns
 * {error} shapes. The endpoint catches the WorkspacePathError from
 * resolveInWorkspace.
 */
export async function gitSnapshotListing(
  workspaceRoot: string,
  rev: string,
  relPath: string,
  { showHidden = false }: { showHidden?: boolean } = {},
): Promise<GitSnapshotListingResult> {
  const clean = String(relPath ?? "").replace(/\/+$/, "");
  await resolveInWorkspace(workspaceRoot, clean); // containment (throws WorkspacePathError)
  const res = await git(workspaceRoot, ["ls-tree", "-r", "--name-only", rev, ...(clean ? ["--", clean] : [])],
    { maxBuffer: 16 * 1024 * 1024 });
  if (!res.ok) return { error: res.code, message: res.message, relPath: clean };
  const { entries, truncated } = snapshotDirListing(res.value, clean, { showHidden });
  return { root: workspaceRoot, relPath: clean, entries, truncated };
}

/**
 * A file's bytes at a git revision: `git show <rev>:<path>` (buffer). A
 * missing path → git-error ("does not exist in <rev>"), the jj "No such
 * path" analog. Post-processing (sniff / 1 MB cap / displayable-binary
 * base64) is the shared snapshot.finishFileShow.
 */
export async function gitFileShow(workspaceRoot: string, rev: string, relPath: string): Promise<import("./snapshot.js").FileShowResult> {
  const clean = String(relPath ?? "").replace(/\/+$/, "");
  await resolveInWorkspace(workspaceRoot, clean);
  const res = await git(workspaceRoot, ["show", rev + ":" + clean],
    { encoding: "buffer", maxBuffer: FILE_SHOW_CAP + 4096 });
  if (!res.ok) return { error: res.code, message: res.message };
  const buf = Buffer.isBuffer(res.value) ? res.value : Buffer.from(String(res.value));
  return finishFileShow(buf, clean);
}

/**
 * `git diff --no-index -- /dev/null <abs>` → the whole file as ADDED (the U
 * file's diff, the analog of jj's A: the worktree has the bytes, the "old"
 * side is the void). Read-only (the read touches no repo state). The
 * exit-1 tolerance in `git()` applies (content ⇒ exit 1 ⇒ success). An
 * empty file exits 0 with an empty patch (a state, not an error).
 */
export function gitUntrackedDiff(workspaceRoot: string, relPath: string): Promise<GitResult> {
  return git(workspaceRoot, ["diff", "--no-index", "--", "/dev/null", join(workspaceRoot, relPath)]);
}
