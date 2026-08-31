// The CLI is the only stable jj interface (no Node bindings. The .jj/ store
// formats are binary and churn). Every call here is READ-ONLY and must stay
// that way:
//   - `--no-integrate-operation` (jj >= 0.41): without it, every read
//     INTEGRATES the snapshot op. The current op advances. A polling browser
//     hammers the op store. With it, the read still snapshots (view stays
//     fresh) but the op is ORPHANED: never retained, current op unchanged
//     (verified across reads, test/jj.test.mjs). The `--ignore-working-copy`
//     flag avoids the brief op-store residue per read, but the view goes
//     stale until an integrated jj command. The trade is wrong for a live view.
//   - `--color never`: machine-parseable output (explicit, regardless of the
//     user's ui.color).
//   - No editor-opening commands: a `jj commit`/`jj new` without `-m` pops
//     the user's ui.editor. This module runs only diff/show/status/log reads.
//
// The output shapes match jj 0.44.0 (golden tables in test/jj.test.mjs):
//   - `diff --summary` letters A/M/D/R (+C defensively). Renames use git's
//     BRACE form `R {old => new}` / `R prefix/{old => new}suffix`, NOT
//     `old -> new`.
//   - The "uncommitted" diff is `jj diff` (default = `-r @`): jj auto-snapshots
//     the worktree into @, so @ vs @- IS the worktree diff.
//   - Head info is `jj show -r @ -T <tsv>`: one TSV line, no graph. `jj log -T`
//     needs `-G` because 0.44 renders the log graph by default (see LOG_TSV).
//     Flag-order gotcha (verified 0.44): `-G` is a LOG option, NOT global.
//     `jj -G log …` silently runs the default command with `log` as a PATHSPEC.
//   - Conflicts appear in NO diff (a conflicted merge commit diffs empty
//     against its auto-merged parents). `jj status`'s "Warning: There are
//     unresolved conflicts at these paths:" section is the machine source.
//   - A workspace that is a SUBDIRECTORY of a jj repo sees `../` pathspecs in
//     summary output. `insideWorkspace()` filters them (badges are about THIS
//     workspace. The diff endpoint re-checks containment per request anyway).

import { execFile } from "node:child_process";

const JJ_FLAGS = ["--no-integrate-operation", "--color", "never"];
const HEAD_TSV = 'commit_id.short() ++ "\t" ++ description.first_line() ++ "\n"';
// Commit list for the review dropdown: change id (STABLE across rebase/amend,
// what the client persists) + empty flag + first description line. `-G` = flat
// list (no graph). `-n` caps the count (log lists newest first by default,
// verified 0.44). The empty flag mirrors jj's own `(empty)` marker: a commit
// whose diff vs its parent(s) adds/removes nothing (verified 0.44 to agree
// with the default log template's rendering).
const LOG_TSV =
  'change_id.short() ++ "\\t" ++ ' +
  'if(diff.stat().total_added() == 0 && diff.stat().total_removed() == 0, "1", "0") ++ ' +
  '"\\t" ++ description.first_line() ++ "\\n"';
const MAX_COMMITS = 50; // dropdown length: `-n` caps the process. The parser caps the array

// Failure codes safe to remember per workspace (structural, not transient).
const STRUCTURAL = new Set(["jj-missing", "not-a-workspace"]);
const jjFailCache = new Map<string, string>(); // workspaceRoot → structural failure code

export type JjCode = "jj-missing" | "not-a-workspace" | "jj-timeout" | "jj-overflow" | "jj-error";
export type JjResult =
  | { ok: true; value: string | Buffer }
  | { ok: false; code: JjCode; message: string };

/**
 * The function runs jj in the workspace. It resolves and never throws
 * (result shape: JjResult). `value` is a Buffer when opts.encoding is
 * "buffer".
 */
export function jj(
  workspaceRoot: string,
  args: string[],
  { maxBuffer = 4 * 1024 * 1024, timeout = 8000, encoding = "utf8" }: { maxBuffer?: number; timeout?: number; encoding?: BufferEncoding | "buffer" } = {},
): Promise<JjResult> {
  return new Promise((resolve) => {
    execFile("jj", [...JJ_FLAGS, ...args], { cwd: workspaceRoot, maxBuffer, timeout, encoding },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as { code?: string | number; message?: string; killed?: boolean };
          const msg = (String(stderr || "").trim() || String(err.message || "").trim()).split("\n")[0] || "jj failed";
          if (e.code === "ENOENT") {
            // ENOENT is ambiguous: the jj binary is missing (structural,
            // safe to cache) OR the cwd (workspace dir) is gone (transient.
            // Caching it as jj-missing poisons the verdict forever).
            // The one-shot probe decides which.
            return jjBinaryOnPath().then((onPath) => resolve(onPath
              ? { ok: false, code: "jj-error", message: "jj spawn failed (workspace directory missing?)" }
              : { ok: false, code: "jj-missing", message: "jj binary not found on PATH" }));
          }
          if (/maxBuffer length exceeded/i.test(msg))
            return resolve({ ok: false, code: "jj-overflow", message: "jj output exceeded the buffer cap" });
          if (e.killed)
            return resolve({ ok: false, code: "jj-timeout", message: "jj timed out" });
          if (/no jj repo/i.test(msg))
            return resolve({ ok: false, code: "not-a-workspace", message: msg });
          return resolve({ ok: false, code: "jj-error", message: msg });
        }
        resolve({ ok: true, value: stdout as string | Buffer });
      });
  });
}

/**
 * The function escapes glob metacharacters so jj's FILESET argument matches
 * the path LITERALLY. A fileset arg containing glob chars is a glob. An
 * unescaped `a*b.txt` also matches `aXb.txt` in diff/show/list (verified
 * against jj 0.44). The git analog is the `:(literal)` pathspec magic
 * (git.ts).
 */
export function jjEscapePath(p: string): string {
  return p.replace(/[\\*?\[\]{}!]/g, "\\$&");
}

// One-shot: the jj binary is on PATH or absent. `jj --version` needs no repo
// (the flags are repo-independent), so the probe isolates "binary missing"
// from "cwd missing".
let jjOnPath: Promise<boolean> | null = null;
function jjBinaryOnPath(): Promise<boolean> {
  if (!jjOnPath) {
    jjOnPath = new Promise((resolve) => {
      execFile("jj", [...JJ_FLAGS, "--version"], { timeout: 8000 }, (err) => resolve(!err));
    });
  }
  return jjOnPath;
}

export interface ChangeEntry {
  path: string;
  status: string;
  oldPath?: string | null;
}

/**
 * `jj diff --summary` stdout → [{ path, status, oldPath? }]. The parser skips
 * unknown lines, never fatal. Paths keep their spaces.
 */
export function parseSummary(text: string | Buffer): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([AMDRC])\s+(.*)$/);
    if (!m) continue;
    const status = m[1]!;
    const rest = m[2]!.trim();
    if (!rest) continue;
    if (status === "R") {
      const i = rest.indexOf("{");
      const j = rest.lastIndexOf("}");
      if (i >= 0 && j > i) {
        const prefix = rest.slice(0, i);
        const suffix = rest.slice(j + 1);
        const inner = rest.slice(i + 1, j);
        const k = inner.indexOf(" => ");
        if (k > 0) {
          const o = prefix + inner.slice(0, k) + suffix;
          const nw = prefix + inner.slice(k + 4) + suffix;
          if (o && nw) { out.push({ path: nw, status, oldPath: o }); continue; }
        }
      }
      const k = rest.indexOf(" => ");
      if (k > 0) { out.push({ path: rest.slice(k + 4).trim(), status, oldPath: rest.slice(0, k).trim() }); continue; }
      out.push({ path: rest, status, oldPath: null }); // opaque last resort
      continue;
    }
    out.push({ path: rest, status });
  }
  return out;
}

/** `jj show -r @ -T <tsv>` stdout → { id, description } | null (first hex-id + tab line). */
export function parseHead(text: string | Buffer): { id: string; description: string } | null {
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([0-9a-f]{7,40})\t(.*)$/);
    if (m) return { id: m[1]!, description: m[2]! };
  }
  return null;
}

export interface CommitRow {
  id: string;
  empty: boolean;
  description: string;
}

/**
 * `jj log -G -T <tsv>` stdout → [{ id: changeId, empty, description }]
 * (newest first, capped at MAX_COMMITS). The parser excludes the root
 * revision (all-z change id). It changes nothing. The parser skips non-TSV
 * lines, never fatal. The middle column mirrors jj's own `(empty)` marker
 * (see LOG_TSV): a commit whose diff vs its parent(s) adds/removes nothing.
 * `change_id.short()` is jj's FRIENDLY form, 12 lowercase a–z letters
 * (NOT hex. Full change ids and commit ids are hex). The class is
 * deliberately `[0-9a-z]` so a hex full-id TSV parses too.
 */
export function parseCommitLog(text: string | Buffer): CommitRow[] {
  const out: CommitRow[] = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([0-9a-z]{7,40})\t(0|1)\t(.*)$/);
    if (!m) continue;
    if (m[1] === "z".repeat(m[1]!.length)) continue; // root
    out.push({ id: m[1]!, empty: m[2] === "1", description: m[3]! });
    if (out.length >= MAX_COMMITS) break;
  }
  return out;
}

/** `jj status` stdout → conflicted paths (the "unresolved conflicts" warning section). */
export function parseConflicts(text: string | Buffer): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of String(text).split("\n")) {
    if (!inSection) {
      if (/^Warning: There are unresolved conflicts at these paths:/.test(line)) inSection = true;
      continue;
    }
    const m = line.match(/^(.+?)\s{2,}\d+-sided conflict$/);
    if (m) { out.push(m[1]!.trim()); continue; }
    break; // section ended
  }
  return out;
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

/**
 * `jj diff --summary -r <rev>` → the SELECTED COMMIT's own changeset (vs its
 * parent(s)), same shape and letters as the worktree changes.
 * Workspace-scoped: the function drops `../` paths outside a subdirectory
 * workspace. A clean merge contributes nothing → [] (jj's own `diff -r`
 * semantics, so a file's badge and its per-file diff at that commit agree).
 * A failure (non-jj workspace, rewritten rev) → [] too: the badges are
 * simply absent, the listing stands.
 */
export async function jjCommitChanges(workspaceRoot: string, rev: string): Promise<ChangeEntry[]> {
  const s = await jj(workspaceRoot, ["diff", "--summary", "-r", rev]);
  if (!s.ok) return [];
  const keep = (e: ChangeEntry) => insideWorkspace(e.path) || (e.oldPath !== null && e.oldPath !== undefined && insideWorkspace(e.oldPath));
  return parseSummary(s.value).filter(keep);
}

export type JjWorkspaceStatusResult =
  | {
      ok: true;
      head: { id: string; description: string; marker: string };
      changes: (ChangeEntry & { base: "worktree" | "conflict" })[];
      conflicts: string[];
      commits: CommitRow[];
    }
  | { ok: false; code: JjCode; message?: string };

/**
 * One call → the whole `jj` block for the list response (shape:
 * JjWorkspaceStatusResult). Changes are STRICTLY the working copy
 * (`jj diff` = `@` vs `@-`): a clean worktree shows "no changes" by design.
 * `commits` feeds the review dropdown. A picked change id drives the diff
 * endpoint's `jj diff -r <id>`. The badges stay worktree-based. Conflicts
 * override the letter. They come from `jj status` (they appear in no diff).
 */
export async function jjWorkspaceStatus(
  workspaceRoot: string,
  { force = false }: { force?: boolean } = {},
): Promise<JjWorkspaceStatusResult> {
  if (!force) {
    const cached = jjFailCache.get(workspaceRoot);
    if (cached) return { ok: false, code: cached as JjCode };
  }
  const fail = (code: JjCode, message?: string): { ok: false; code: JjCode; message?: string } => {
    if (STRUCTURAL.has(code)) jjFailCache.set(workspaceRoot, code);
    return { ok: false, code, message: message || undefined };
  };

  // 1) Probe + the uncommitted diff in one read: `jj diff` = `@` vs `@-`.
  //    `@` is the anchor, always.
  const s1 = await jj(workspaceRoot, ["diff", "--summary"]);
  if (!s1.ok) return fail(s1.code, s1.message);
  // 2) head(@) + conflicts + the commit list. (`jj show` can append the diff
  //    below the template line. parseHead scans for the TSV line.) A log
  //    failure is NON-FATAL: commits degrades to [], the rest is untouched.
  const [headAt, st, log] = await Promise.all([
    jj(workspaceRoot, ["show", "-r", "@", "-T", HEAD_TSV]),
    jj(workspaceRoot, ["status"]),
    jj(workspaceRoot, ["log", "-G", "-n", String(MAX_COMMITS), "-r", "ancestors(@-)", "-T", LOG_TSV]),
  ]);
  if (!headAt.ok) return fail(headAt.code, headAt.message);
  const conflicts = (st.ok ? parseConflicts(st.value) : []).filter(insideWorkspace);
  const commits = log.ok ? parseCommitLog(log.value) : [];
  const keep = (e: ChangeEntry) => insideWorkspace(e.path) || (e.oldPath !== null && e.oldPath !== undefined && insideWorkspace(e.oldPath));
  const byPath = new Map<string, ChangeEntry & { base: "worktree" | "conflict" }>();
  for (const e of parseSummary(s1.value).filter(keep))
    byPath.set(e.path, { path: e.path, status: e.status, oldPath: e.oldPath ?? null, base: "worktree" });
  for (const p of conflicts) {
    const cur = byPath.get(p);
    if (cur) cur.status = "C";
    else byPath.set(p, { path: p, status: "C", oldPath: null, base: "conflict" });
  }
  const head = parseHead(headAt.value);
  return {
    ok: true,
    head: { ...(head ?? { id: "", description: "" }), marker: "@" },
    changes: [...byPath.values()],
    conflicts,
    commits,
  };
}
