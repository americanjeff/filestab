// Workspace path containment for filestab's read-only file browser.
//
// All host-side FS access resolves through here. Containment is LEXICAL: the
// code checks the path TEXT (no absolute paths, no `..` climbing above the
// root) and does not follow symlinks to re-check. A symlink inside the
// workspace that points outside is therefore readable — deliberate, for a
// local, operator-controlled tool: a link target the user could already read
// is not a new privilege, so the plugin does not pay to block it. The browse
// endpoints (list / diff / fileshow) touch only paths whose spelling stays
// inside the session's workspace root.

import { realpath } from "node:fs/promises";
import { resolve, isAbsolute, sep } from "node:path";

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

  // Lexical containment: resolve(root, clean) cancels `..`. If the result
  // still sits above the root, the code rejects it outright. Symlinks are not
  // followed (see the file header).
  const target = resolve(root, clean);
  if (!underRoot(root, target)) {
    throw new WorkspacePathError(`path escapes workspace: ${relPath}`);
  }
  return target;
}
