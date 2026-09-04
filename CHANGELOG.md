# Changelog

Coarse, per-release — deliberately not a commit log. Full history lives in the release notes on GitHub and in the (private) jj dev line. Newest first.

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
