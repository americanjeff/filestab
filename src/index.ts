// One surface: the /filez-browse connection.rpc channel (list / diff /
// fileshow). It carries the deployment's trusted-host fence like every
// other /api call.
// Every read stays inside the workspace (the session tether). The client
// sends sessionId. The code re-resolves the workspace server-side and
// containment-checks every relPath (src/containment.ts), including symlink
// escapes.
// The code ships NO HTTP file route. File bytes travel over the RPC as
// text or base64. The browser never loads a workspace file as a
// same-origin document (no served HTML/SVG to execute, no whole-FS read
// surface).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { listDirectory } from "./filesystem.js";
import { resolveInWorkspace } from "./containment.js";
import { jj, jjWorkspaceStatus, jjCommitChanges, jjEscapePath, type ChangeEntry, type JjWorkspaceStatusResult } from "./jj.js";
import { git, gitWorkspaceStatus, gitUntrackedDiff, gitSnapshotListing, gitFileShow, gitCommitChanges, gitLiteralPath, isBadRevision, parseNameStatus, type GitWorkspaceStatusResult } from "./git.js";
import { snapshotListing, fileShow, worktreeFileShow, REV_RE, type FileShowValue } from "./snapshot.js";
import type { ListingValue } from "./filesystem.js";

const name = "filestab";
// No hard `inject`. The code reads connection/sessions/sandboxPolicy
// lazily. connection is absent in tui/headless profiles, so the surface
// no-ops there.
const inject: string[] = [];
const BROWSE_CHANNEL = "/filez-browse";
// The host serves package-local assets (the vendored mermaid bundle) by
// absolute path. It resolves the path from this module's own directory.
const HERE = dirname(fileURLToPath(import.meta.url));

type BrowsePayload = Record<string, unknown>;
interface RpcError {
  code: string;
  message?: string;
  details?: Record<string, unknown>;
}
type RpcResult = { ok: true; value: unknown } | { ok: false; error: RpcError };
type VcsStatus =
  | (Extract<JjWorkspaceStatusResult, { ok: true }> & { backend: "jj" })
  | Extract<GitWorkspaceStatusResult, { ok: true }>
  | { ok: false; code: string; message?: string };
type EnrichedListing = ListingValue & { vcs?: VcsStatus; commitChanges?: ChangeEntry[] };
const asText = (v: string | Buffer): string => (typeof v === "string" ? v : v.toString("utf8"));

function apply(ctx: Context): void {
  const log = (level: "info" | "error", msg: string) => {
    // ctx.logger is the LoggerService (not a facade). The code indexes the
    // severity method defensively. An absent logger is a silent no-op.
    try { (ctx.logger as unknown as Record<string, ((msg: string) => void) | undefined>)?.[level]?.(msg); } catch { /* no logger, fine */ }
  };
  let browseInstalled = false;
  const install = () => {
    if (browseInstalled) return;
    const connection = ctx.get("connection");
    if (connection === undefined) return;
    try {
      // The 3rd `options` arg is required (register() reads `options.authority`).
      // The code omits `authority` to get the default trusted-host fence:
      // loopback always trusted AND the deployment's --trusted-host.
      connection.rpc.handle(BROWSE_CHANNEL, makeBrowseHandler(ctx), {});
      browseInstalled = true;
      log("info", `filestab: browse channel registered at ${BROWSE_CHANNEL}`);
    } catch (error) {
      log("error", `filestab: browse registration failed: ${(error as { message?: string })?.message ?? String(error)}`);
    }
  };
  install();
  // The shell can provide connection after this plugin's apply runs (a
  // global listener receives service notifications from any fiber).
  ctx.on("internal/service", (svc: string) => {
    if (svc === "connection") install();
  }, { global: true });
}

const DIFF_PATCH_CAP = 1_000_000; // chars, ~1 MB. It keeps the RPC payload and client row count sane

// Cold-session workspace cache (sessionId → workspaceRoot). The persisted
// header's cwd is IMMUTABLE — a session is ever re-created under its id via
// resume, which reuses the stored header — so a resolved root never goes
// stale, and skipping the re-inspect spares a full log read from disk per
// poll. Misses are deliberately NOT cached: a not-persisted id is cheap to
// re-check, and a log written after the first check (a crash mid-write) must
// not stay invisible for the process's lifetime.
const coldWorkspaceRoots = new Map<string, string>();

/**
 * The workspace root for one NOT-LIVE session, resolved from its persisted
 * header — the same source the host's own history path reads (the session
 * log outlives the live session store; a finished turn or a restarted
 * runtime leaves a session listed but not attached). Returns null when the id
 * is not persisted, or persistence itself is absent (headless profiles): the
 * caller then reports session-not-found, the pre-existing behavior.
 */
async function persistedWorkspaceRoot(
  ctx: Context,
  sessionId: string,
): Promise<{ root: string } | { error: RpcError } | null> {
  const cached = coldWorkspaceRoots.get(sessionId);
  if (cached !== undefined) return { root: cached };
  const persistence = ctx.get("sessionPersistence") as
    | { inspect?: (id: string) => Promise<{ meta?: { cwd?: unknown } }> }
    | null
    | undefined;
  if (typeof persistence?.inspect !== "function") return null;
  let meta: { cwd?: unknown } | undefined;
  try {
    meta = (await persistence.inspect(sessionId)).meta;
  } catch {
    return null; // no persisted log for this id → genuinely gone
  }
  const cwd = meta?.cwd;
  // Route the root through the SAME policy resolver as the live path, so the
  // cold root gets identical normalization (canonicalPath + resolvePath) and
  // the deployment's fallback root applies to a cwd-less header exactly as it
  // does for a live session. The resolver reads only `header.cwd` (plus
  // `events`, for the mode-override scan — filestab ignores the mode half),
  // so a minimal structural session is a sufficient input.
  const pseudo = { id: sessionId, header: meta, events: [] };
  const root = ctx.get("sandboxPolicy")?.resolve?.({ session: pseudo })?.workspaceRoot;
  if (typeof root !== "string" || root.length === 0)
    return { error: { code: "no-workspace", message: "session has no workspace root" } };
  coldWorkspaceRoots.set(sessionId, root);
  return { root };
}

async function resolveWorkspace(ctx: Context, sessionId: unknown): Promise<{ root: string } | { error: RpcError }> {
  if (typeof sessionId !== "string" || sessionId.length === 0)
    return { error: { code: "bad-request", message: "sessionId is required" } };
  const session = ctx.get("sessions")?.get?.(sessionId);
  if (session !== undefined) {
    const root = ctx.get("sandboxPolicy")?.resolve?.({ session })?.workspaceRoot;
    if (typeof root !== "string" || root.length === 0)
      return { error: { code: "no-workspace", message: "session has no workspace root" } };
    return { root };
  }
  // NOT live. The conversation view still renders such a session (its history
  // is served straight from persistence), so the browse surface must not
  // dead-end on a live-store miss: resolve the root from the persisted
  // header instead. A genuinely unknown id still reports session-not-found.
  const cold = await persistedWorkspaceRoot(ctx, sessionId);
  if (cold !== null) return cold;
  return { error: { code: "session-not-found", message: `no live or persisted session for ${sessionId}` } };
}

// VCS backend dispatch (git-support.md §2). jj comes FIRST. A co-located
// jj+git repo (`.git` exists) must resolve to jj. jj's auto-snapshot
// worktree diff and git's staged+unstaged view disagree. On jj's failure
// the code tries git. If both fail, the code degrades to non-VCS with
// the most meaningful code.
// The code caches the per-workspace verdict (list refreshes it per poll,
// `force` re-probes). A diff request reads the backend, not the full
// status. A positive verdict is safe for a session (Reload re-probes).
const backendVerdict = new Map<string, "jj" | "git" | "none">(); // workspaceRoot → verdict

async function vcsStatus(root: string, { force = false }: { force?: boolean } = {}): Promise<VcsStatus> {
  const jjSt = await jjWorkspaceStatus(root, { force });
  if (jjSt.ok) {
    const { ok: _ok, head, changes, conflicts, commits } = jjSt;
    return { ok: true, backend: "jj", head, changes, conflicts, commits };
  }
  const gitSt = await gitWorkspaceStatus(root, { force });
  if (gitSt.ok) return gitSt;
  // Both failed. The code prefers a transient code (a reportable read hiccup) over a structural code.
  const transient = (c: string | undefined) => c === "jj-timeout" || c === "jj-overflow" || c === "jj-error"
    || c === "git-timeout" || c === "git-overflow" || c === "git-error";
  if (transient(jjSt.code)) return { ok: false, code: jjSt.code, message: jjSt.message };
  if (transient(gitSt.code)) return { ok: false, code: gitSt.code, message: gitSt.message };
  // Structural failure: a plain directory maps to `not-a-workspace`, not
  // to a code like jj-missing.
  if (jjSt.code === "not-a-workspace" || gitSt.code === "not-a-workspace")
    return { ok: false, code: "not-a-workspace", message: "no jj or git workspace" };
  return { ok: false, code: "vcs-error", message: "no usable VCS backend" };
}

// The connection.rpc result envelope is a CLOSED discriminated union (dsh's
// rpcErrorSchema, validated client-side). A foreign code or a missing
// `details` shape fails as `invalid_union`. The pane then shows a raw
// zod error blob instead of a clean note. The code maps every browse error
// onto a standard code with its branch's required details shape. The
// plugin-specific detail rides in `message`.
function envelopeError(error: { code?: string; message?: string } | null | undefined, payload: BrowsePayload | null | undefined): RpcResult {
  const code = error && error.code;
  const message = (error && error.message) || String(code ?? "error");
  switch (code) {
    case "bad-request":
    case "not-a-directory":
    case "unknown-endpoint":
      return { ok: false, error: { code: "bad-request", message, details: { issues: [message] } } };
    case "session-not-found":
      return { ok: false, error: { code: "session-not-found", message, details: { sessionId: String(payload?.sessionId ?? "") } } };
    case "forbidden":
      return { ok: false, error: { code: "workspace-invalid-path", message, details: { path: String(payload?.relPath ?? "") } } };
    default:
      // VCS/git/jj backend codes, no-workspace, io-error → the catch-all (the
      // original code rides in the message for debugging).
      return { ok: false, error: { code: "internal", message: code && code !== message ? `${code}: ${message}` : message, details: {} } };
  }
}

// The /filez-browse wire contract. The client calls three endpoints. Every
// payload carries sessionId. The server re-resolves the workspace from it.
//   list     { sessionId, relPath?, showHidden?, force?, rev? } → listing + a
//     `vcs` WORKTREE status block (backend jj|git, git-support.md §4) +
//     `commitChanges`. `rev` (a change/commit id) switches the listing to
//     that commit's snapshot tree (read-only). `vcs` still describes the
//     worktree. `commitChanges` carries the selected commit's own changeset.
//   diff     { sessionId, relPath, base: "worktree"|"commit"|<id> } →
//     { patch, truncated, base }. The host computes it (the old file version
//     exists only in the VCS object store). Empty patch = "no changes"
//     state. An UNTRACKED file gets a synthetic full-added diff. The code
//     refuses a git submodule/gitlink (it does not parse it).
//   fileshow { sessionId, relPath, rev } → { kind: "text"|"binary", … }, the
//     file's bytes for the preview. rev "worktree" = the live on-disk file
//     (plain contained read, no VCS). A change/commit id = that revision.
//   Errors   map onto the client's CLOSED rpcErrorSchema code set
//     (envelopeError). Plugin-specific codes ride in `message`.
function makeBrowseHandler(ctx: Context): (endpoint: string, payload: BrowsePayload | null | undefined) => Promise<RpcResult> {
  const inner = async (endpoint: string, payload: BrowsePayload | null | undefined): Promise<RpcResult> => {
    const p = payload ?? {};
    if (endpoint === "list") {
      try {
        const ws = await resolveWorkspace(ctx, p.sessionId);
        if ("error" in ws) return { ok: false, error: ws.error };
        const relPath = typeof p.relPath === "string" ? p.relPath : "";
        // Snapshot mode: `rev` (a change id, id-alphabet-validated, never a
        // revset) → the listing is that commit's tree, not the worktree's.
        let rev: string | null = null;
        if (p.rev !== undefined && p.rev !== null) {
          // "worktree"/"commit" are diff's BASE keywords, not revisions.
          // A rev that passes the id alphabet but names them is still
          // invalid.
          if (typeof p.rev === "string" && p.rev !== "worktree" && p.rev !== "commit" && REV_RE.test(p.rev)) rev = p.rev;
          else return { ok: false, error: { code: "bad-request", message: "rev must be a change id" } };
        }
        // Snapshot mode needs the backend to pick the tree reader. The code
        // probes VCS first (the result doubles as the enrichment). Worktree
        // mode is unchanged.
        let vcs: VcsStatus | null = null;
        if (rev) {
          try { vcs = await vcsStatus(ws.root, { force: p.force === true }); }
          catch { vcs = { ok: false, code: "vcs-error", message: "status failed" }; }
        }
        const listing = rev
          ? (vcs && vcs.ok === true && vcs.backend === "git"
              ? await gitSnapshotListing(ws.root, rev, relPath, { showHidden: !!p.showHidden })
              : await snapshotListing(ws.root, rev, relPath, { showHidden: !!p.showHidden }))
          : await listDirectory(ws.root, relPath, { showHidden: !!p.showHidden });
        if ("error" in listing) {
          // All three listing backends' error shapes are this (message is
          // optional, listDirectory's variant omits it).
          const err = listing as { error: string; message?: string; relPath: string };
          return { ok: false, error: { code: err.error, message: err.message ?? err.error, details: { relPath } } };
        }
        const value: EnrichedListing = listing;
        // VCS enrichment (git-support.md). It never blocks or fails the
        // listing. A non-VCS workspace or a missing binary degrades to
        // vcs.ok:false. In snapshot mode the block is still the WORKTREE's
        // state (it keeps the review dropdown live). A rewritten rev makes
        // the dropdown fall back to the worktree.
        if (!vcs) {
          try { vcs = await vcsStatus(ws.root, { force: p.force === true }); }
          catch { vcs = { ok: false, code: "vcs-error", message: "status failed" }; }
        }
        (value as { vcs?: VcsStatus }).vcs = vcs;
        // The verdict cache feeds diff requests (they need the backend, not
        // the status). A force (Reload) re-probed it earlier.
        backendVerdict.set(ws.root, vcs.ok === true ? vcs.backend : "none");
        // Snapshot mode: the nav-pane markers describe the SELECTED commit's
        // tree (vs its parent), not the worktree's. The vcs block is
        // strictly the worktree's. A failure degrades to no badges, never a
        // broken listing.
        if (rev && vcs.ok === true) {
          try {
            (value as { commitChanges?: unknown[] }).commitChanges = vcs.backend === "git"
              ? await gitCommitChanges(ws.root, rev)
              : await jjCommitChanges(ws.root, rev);
          }
          catch { (value as { commitChanges?: unknown[] }).commitChanges = []; }
        }
        return { ok: true, value };
      } catch (error) {
        const e = error as { name?: string; message?: string } | null;
        if (e?.name === "WorkspacePathError")
          return { ok: false, error: { code: "forbidden", message: e.message ?? "" } };
        return { ok: false, error: { code: "io-error", message: e?.message ?? String(error) } };
      }
    }
    if (endpoint === "diff") {
      try {
        const ws = await resolveWorkspace(ctx, p.sessionId);
        if ("error" in ws) return { ok: false, error: ws.error };
        const relPath = typeof p.relPath === "string" ? p.relPath : "";
        // base: "worktree" | "commit" (= @-) | a change/commit id. Change
        // ids are jj's 12-char a–z form. Full/commit ids are hex. The
        // [0-9a-z] class covers both. The code validates base to that id
        // alphabet before it reaches the arg array. A revset injection via
        // `base` is impossible.
        const base = p.base === "worktree" || p.base === "commit" || (typeof p.base === "string" && REV_RE.test(p.base))
          ? String(p.base) : null;
        if (!base)
          return { ok: false, error: { code: "bad-request", message: "base must be 'worktree', 'commit', or a change id" } };
        // Containment: the path need not exist (deleted files diff fine).
        await resolveInWorkspace(ws.root, relPath);
        // The code pathspec-escapes the client-supplied path per backend.
        // git treats an unescaped path with glob chars as a glob (`a*b.txt`
        // can also match `aXb.txt`). jj fileset args behave the same
        // (jjEscapePath).
        const gitPath = gitLiteralPath(relPath);
        const jjPath = jjEscapePath(relPath);
        // Backend dispatch (git-support.md §6): the verdict cache picks the backend.
        const backend = backendVerdict.get(ws.root);
        let res: import("./jj.js").JjResult | import("./git.js").GitResult;
        if (backend === "git") {
          if (base === "worktree") {
            res = await git(ws.root, ["diff", "HEAD", "--", gitPath]);
            if (!res.ok && !isBadRevision(res))
              return { ok: false, error: { code: res.code, message: res.message } };
            // An empty patch is a STATE for a tracked-clean file. An
            // UNTRACKED (U) file must show as fully added instead. `ls-files
            // --error-unmatch` (a read-only index read) distinguishes the
            // two. U then gets the synthetic /dev/null diff.
            if (!res.ok || asText(res.value).trim() === "") {
              const tracked = await git(ws.root, ["ls-files", "--error-unmatch", "--", gitPath]);
              if (!tracked.ok) {
                const ni = await gitUntrackedDiff(ws.root, relPath);
                if (!ni.ok) return { ok: false, error: { code: ni.code, message: ni.message } };
                res = ni;
              }
            }
          } else if (base === "commit") {
            res = await git(ws.root, ["diff", "HEAD~1", "HEAD", "--", gitPath]);
          } else {
            // A selected commit: its patch vs its parent. `git show
            // --format= <sha>` is ROOT-COMMIT-SAFE. It diffs a parentless
            // root against the empty tree. `diff <sha>^ <sha>` fatals
            // "bad revision". Empty patch = the commit did not touch this
            // path. A merge's combined diff ("diff --cc …") trips the guard
            // after the call → the error note.
            res = await git(ws.root, ["show", "--format=", base, "--", gitPath]);
          }
          if (!res.ok) return { ok: false, error: { code: res.code, message: res.message } };
          // Guard (git-support.md §6). A submodule/gitlink emits non-diff-
          // shaped output ("Subproject commit …"). The code never feeds it
          // to parseDiff.
          const gitOut = asText(res.value);
          if (gitOut !== "" && gitOut.indexOf("diff --git") !== 0)
            return { ok: false, error: { code: "vcs-error", message: "non-diff-shaped VCS output" } };
        } else {
          // jj (the default, every jj workspace, plus a git workspace the
          // list has not seen yet): the host builds the full arg array. User
          // text is never spliced. `-r <id>` diffs that commit vs its
          // parent(s). A path the commit never touched yields an EMPTY patch
          // (a state). An unresolvable id (history rewritten) → jj-error →
          // client note.
          const args = base === "worktree"
            ? ["diff", "--git", "--", jjPath]
            : base === "commit"
              ? ["diff", "-r", "@-", "--git", "--", jjPath] // @- not @: after `jj commit`, @ is the fresh EMPTY worktree commit
              : ["diff", "-r", base, "--git", "--", jjPath];
          res = await jj(ws.root, args);
          if (!res.ok) return { ok: false, error: { code: res.code, message: res.message } };
        }
        let patch = asText(res.value);
        let truncated = false;
        if (patch.length > DIFF_PATCH_CAP) {
          // The code cuts at a line boundary. A mid-line cut hands the parser
          // a broken row. The code keeps the terminator, so the patch stays
          // a series of complete lines (cut+1 ≤ DIFF_PATCH_CAP because
          // lastIndexOf is bounded at cap-1). If it finds no terminator (a
          // single >1 MB line), it hard-cuts. The parser degrades to one
          // oversized row. It never crashes.
          const cut = patch.lastIndexOf("\n", DIFF_PATCH_CAP - 1);
          patch = patch.slice(0, cut > 0 ? cut + 1 : DIFF_PATCH_CAP);
          truncated = true;
        }
        // A binary patch ("Binary files … differ") or a rename: the code
        // attaches the file's BYTES at the rev AND its parent. The client
        // renders old|new for a displayable image/PDF. A side absent (new/
        // deleted, or a root with no parent) → null. Over-cap or
        // non-displayable → no `data` (the card). `noBinary: true` skips the
        // reads (the bytes are history-stable. The client keeps its first
        // fetch's copy). Change-id bases only: "worktree"/"commit" have no
        // stable parent read.
        // A rename is the marker-less binary: jj's --git output emits only
        // the rename lines (no "Binary files" line), and the two sides live
        // at DIFFERENT paths. The gate accepts the rename lines, and each
        // side reads under its own name (`rename to` at the rev, `rename
        // from` at the parent).
        let binary: { new: FileShowValue | null; old: FileShowValue | null } | undefined;
        if (p.noBinary !== true && base !== "worktree" && base !== "commit" && REV_RE.test(base)) {
          let isNew = patch.indexOf("new file mode") >= 0;
          let isDeleted = patch.indexOf("deleted file mode") >= 0;
          let renameFrom: string | null = null;
          let renameTo: string | null = null;
          for (const line of patch.split("\n")) {
            if (line.startsWith("rename from ")) renameFrom = line.slice(12);
            else if (line.startsWith("rename to ")) renameTo = line.slice(10);
          }
          if (backend === "git" && renameTo === null && (isNew || isDeleted)) {
            // git show under a single pathspec decomposes a rename into a
            // new/deleted file; recover the pair from the commit's -M
            // name-status so the old side reads under the OLD name. A
            // rename is neither an add nor a delete: both sides exist.
            const ns = await git(ws.root, ["show", "--format=", "-M", "--name-status", base]);
            if (ns.ok) {
              for (const e of parseNameStatus(ns.value)) {
                if (e.status === "R" && (e.path === relPath || e.oldPath === relPath)) {
                  renameTo = e.path;
                  renameFrom = e.oldPath ?? null;
                  isNew = false;
                  isDeleted = false;
                  break;
                }
              }
            }
          }
          const hasMarker = patch.indexOf("Binary files ") >= 0;
          if (hasMarker || renameTo !== null) {
            const side = async (r: string, path: string): Promise<FileShowValue | null> => {
              const v = backend === "git"
                ? await gitFileShow(ws.root, r, path)
                : await fileShow(ws.root, r, path);
              return v && "kind" in v && v.kind === "binary" ? v : null;
            };
            // Parent read per backend: jj's `<id>-` operator, git's `<sha>^`
            // (a root commit's parent read fails cleanly → null side, the
            // "(none)" slot, same as a new file's missing old side).
            const [nw, oldv] = await Promise.all([
              isDeleted ? Promise.resolve(null) : side(base, renameTo ?? relPath),
              isNew ? Promise.resolve(null) : side(backend === "git" ? `${base}^` : base + "-", renameFrom ?? relPath),
            ]);
            // A marker-less rename attaches only when some side resolved:
            // an all-null block would make the client show a binary card for
            // a text-file rename. The marker path stays authoritative.
            if (hasMarker || nw || oldv) binary = { new: nw, old: oldv };
          }
        }
        return { ok: true, value: { patch, truncated, base, ...(binary ? { binary } : {}) } };
      } catch (error) {
        const e = error as { name?: string; message?: string } | null;
        if (e?.name === "WorkspacePathError")
          return { ok: false, error: { code: "forbidden", message: e.message ?? "" } };
        return { ok: false, error: { code: "io-error", message: e?.message ?? String(error) } };
      }
    }
    if (endpoint === "fileshow") {
      try {
        const ws = await resolveWorkspace(ctx, p.sessionId);
        if ("error" in ws) return { ok: false, error: ws.error };
        const relPath = typeof p.relPath === "string" ? p.relPath : "";
        // rev "worktree" = the live file on disk (the in-pane preview's
        // normal mode). A plain contained read. No VCS backend needed.
        if (p.rev === "worktree") {
          const r = await worktreeFileShow(ws.root, relPath);
          if ("error" in r) return { ok: false, error: { code: r.error, message: r.message } };
          return { ok: true, value: r };
        }
        if (typeof p.rev !== "string" || p.rev === "commit" || !REV_RE.test(p.rev))
          return { ok: false, error: { code: "bad-request", message: "rev must be 'worktree' or a change id" } };
        // Backend dispatch via the verdict cache (always set here, an
        // at-revision fileshow only follows a snapshot listing).
        const backend = backendVerdict.get(ws.root);
        const r = backend === "git"
          ? await gitFileShow(ws.root, p.rev, relPath)
          : await fileShow(ws.root, p.rev, relPath);
        if ("error" in r) return { ok: false, error: { code: r.error, message: r.message } };
        return { ok: true, value: r };
      } catch (error) {
        const e = error as { name?: string; message?: string } | null;
        if (e?.name === "WorkspacePathError")
          return { ok: false, error: { code: "forbidden", message: e.message ?? "" } };
        return { ok: false, error: { code: "io-error", message: e?.message ?? String(error) } };
      }
    }
    if (endpoint === "mermaid") {
      // The mermaid renderer bundle (dist/mermaid.min.js).
      // scripts/copy-mermaid.mjs copies it at build time from the
      // build-time-only mermaid devDep. The file is package-local, not
      // workspace content, so no session resolution or containment applies.
      // The client inlines the text into a sealed sandbox iframe's srcdoc,
      // where the diagram runs.
      try {
        const text = await readFile(join(HERE, "mermaid.min.js"), "utf8");
        return { ok: true, value: { text } };
      } catch (error) {
        const e = error as { name?: string; message?: string } | null;
        return { ok: false, error: { code: "io-error", message: e?.message ?? String(error) } };
      }
    }
    return { ok: false, error: { code: "unknown-endpoint", message: String(endpoint) } };
  };
  // Envelope boundary. The code maps plugin error codes onto the closed
  // rpcErrorSchema set (see envelopeError). Successes pass through
  // untouched.
  return async (endpoint, payload) => {
    const result = await inner(endpoint, payload);
    if (result && result.ok === true) return result;
    return envelopeError(result && result.error, payload);
  };
}

export { apply, inject, name };
