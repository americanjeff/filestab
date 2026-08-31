// Workspace path containment for filestab's read-only file browser.
//
// All host-side FS access resolves through here. The (untrusted) client cannot
// read outside the current session's workspace root. This is the security core
// of the plugin: the browse endpoints (list / diff / fileshow) touch only paths
// this function proves to be inside the workspace.

import { realpath } from "node:fs/promises";
import { resolve, dirname, basename, isAbsolute, sep } from "node:path";

/** 403-class marker: the handler catches this by name and maps it to the RPC `forbidden` code (wire: `workspace-invalid-path`), not `internal`. */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function underRoot(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * Resolve a workspace-relative path to a canonical absolute path guaranteed to
 * stay inside `workspaceRoot`.
 *
 * Rules:
 *  - `""` or `"/"`  → the workspace root itself.
 *  - an absolute path, or a `..` that climbs above the root → WorkspacePathError.
 *  - a symlink (or symlinked directory) that points outside the root →
 *    WorkspacePathError (the code realpaths the path against its deepest
 *    EXISTING ancestor, then re-checks it).
 *  - the resolved path need not exist. Callers decide how to report a
 *    missing file/directory (this guarantees containment only, not existence).
 *
 * @param workspaceRoot absolute path of the session workspace
 * @param relPath       workspace-relative path (`""` = root)
 * @returns canonical absolute path inside the workspace
 * @throws WorkspacePathError on any attempt to escape the workspace
 */
export async function resolveInWorkspace(workspaceRoot: string, relPath = ""): Promise<string> {
  const root = await realpath(workspaceRoot);

  const raw = String(relPath ?? "").replace(/\/+$/, "");
  // A NUL byte surfaces later as a raw TypeError from realpath (or morphs the
  // path). The code rejects it as a path error, like any other escape attempt.
  if (raw.includes("\u0000")) throw new WorkspacePathError(`NUL byte not allowed in path: ${raw.replace(/\u0000/g, "\\0")}`);
  if (raw === "" || raw === "/") return root;
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new WorkspacePathError(`absolute path not allowed: ${relPath}`);
  }
  const clean = raw.replace(/^\/+/, "");                // safety net (no-op for non-absolute)
  if (clean === "") return root;

  // 1) Lexical containment: resolve(root, clean) cancels `..`. If the result
  //    still sits above the root, the code rejects it outright.
  const target = resolve(root, clean);
  if (!underRoot(root, target)) {
    throw new WorkspacePathError(`path escapes workspace: ${relPath}`);
  }

  // 2) Symlink containment: the code walks up to the deepest EXISTING ancestor,
  //    realpaths it, re-checks it is still under the root, then re-joins any
  //    non-existent tail.
  let dir = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const realDir = await realpath(dir);
      if (!underRoot(root, realDir)) {
        throw new WorkspacePathError(`symlink escapes workspace: ${relPath}`);
      }
      return tail.length ? resolve(realDir, ...tail.reverse()) : realDir;
    } catch (err) {
      if (err instanceof WorkspacePathError) throw err;
      if (dir === root) return target; // root is real (realpath'd above). The code falls back to the target
      const code = (err as { code?: string } | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        tail.push(basename(dir));
        dir = dirname(dir);
        continue;
      }
      throw err;
    }
  }
}
