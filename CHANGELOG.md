# Changelog

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
