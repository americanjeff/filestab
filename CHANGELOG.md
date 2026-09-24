# Changelog

## [0.1.7] - 2026-09-24

- Right column: filestab coexists with the built-in file browser. It registers its own `filestab` tab kind next to the builtin `files` page, so both guide capsules show ("Files" and "Filestab") and both page tabs can be open side by side. The built-in file browser is fully available: file opens (chat file chips, "Files changed" rows, the stock tree) route to the built-in file viewer, and filestab's selection is independent of it. Capturing those opens is a possible follow-up option (re-register the type to claim `dsh-resource://file/**` on the extension band).
- Files view: restored pane state (the expanded set in localStorage) is normalized on load, and the live-update tick's targets are deduped — the tick's positional listing mapping stays aligned, so a re-opened pane shows the workspace root contents immediately.

## [0.1.6] - 2026-09-17

- Files view: selecting a file now opens it as its CONTENT (preview for markdown, raw view otherwise) — never as a diff, even for a VCS-changed file (a deleted file still opens as its diff, which is its only view). Picking Diff explicitly is soft-sticky for the session: subsequent diffable selections also start in Diff until an explicit View/Preview pick, a session switch, or closing the Files view disarms it. The preference is in-memory only — a page reload drops it.
- Files view: click a character in the raw view to get a precise ref to exactly that location — the head row morphs from the file path into the exact `@path:line:col` token, with copy and add-to-chat buttons. Clicking the rendered markdown preview resolves to the source line too (a code fence or plain paragraph gives the exact `:line:col`).
- The file list, the change marks, and the open preview now update live while the view is open — edits by the agent or on disk appear within a few seconds, no reload or re-selection.
- jj workspaces: a new file shows the unadded (U) marker, matching git's `??` — jj has no staging area, so a worktree add is the unadded state.

## [0.1.5] - 2026-09-15

- Right column: on dsh 0.1.5, filestab serves the right sidebar's files slot — the column opens straight onto one filestab view (replacing the built-in per-file tabs and the conversation-area Files tab), and file chips select their file in that view, scrolling to the mentioned line. The file list toggles as a hide/restore state pair and is preserved when a file is opened from a chip.
- External section: pin any file outside the workspace by absolute path — the footer's "Open file…", or a file chip whose workspace resolution fails. Pinned files persist per session and preview in the same pane (view/preview only). The viewed file's name now appears at the top of the preview in every mode.
- Diff view: side-by-side falls back to unified below ~66 columns; working-copy and last-commit image diffs render the old|new images; a text file whose content contains git diff marker strings no longer reports as binary. Containment: workspace path resolution is lexical — a symlink inside the workspace reads through to its target.

## [0.1.4] - 2026-09-11

- Works with dsh 0.1.5: the Files tab (main area, sibling of the Chat and Trajectory tabs) works again — dsh 0.1.5's broken custom RPC channel registration had left the view empty.

## [0.1.3] - 2026-09-05

- Files view: the collapsed file list now shows a pane-edge rail instead of a small header icon.
- Markdown preview links open in a new tab instead of navigating the session away.

## [0.1.2] - 2026-09-03

- Files view: selecting a file references it as @path (toolbar, context menu, add-to-chat); "open locally" and "copy path" actions; file rows show size and last-modified time.
- Files view: the collapsed file list is now noticeable; a deleted folder shows a friendly note and returns to the workspace root instead of a raw error.
- Diff view: intra-line change spans no longer fragment into word islands — whitespace inside a changed phrase is highlighted with it.

## [0.1.1] - 2026-09-01

- Files view now supports cold (persisted, not-live) sessions.
- Nested jj/git repos no longer appear in worktree listings.
- Dropped the machine-local `.npmrc` from the published tree.

## [0.1.0] - 2026-08-31

- Initial release: read-only Files tab for the dsh web GUI — browse, VCS change rollups, side-by-side diffs, in-pane previews (Markdown, highlighted source, sandboxed HTML, images/PDF), and snapshot mode.
