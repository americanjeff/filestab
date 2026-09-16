[![npm version](https://img.shields.io/npm/v/filestab)](https://www.npmjs.com/package/filestab)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

# ![filestab icon](assets/icons/filestab-icon.png) filestab

English | [中文](README.zh.md)

A replacement file viewer with vcs support for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) ![DeepSeek logo](assets/icons/deepseek.png)

## Features

Live change tracking (jj or git) with file diffs rendered side-by-side or unified depending on pane width:

![filestab file browser with per-folder change rollups, per-file status markers, and the diff of a changed file](assets/rollups-dark.png)

![filestab side-by-side diff of the same changed file, the column in fullscreen](assets/diff-side-by-side.png)

Markdown with task lists, syntax highlighting, and mermaid diagrams:

![filestab rendering a markdown file: task lists, a highlighted TypeScript code fence, and a mermaid diagram in a sealed frame](assets/preview-markdown.png)

## Install

```sh
dsh plugin --profile web add filestab
```

Install it into the web profile, the one that runs the GUI.

## Development

To test a local checkout instead of the published package, install it directly: `dsh plugin --profile web add /path/to/filestab`

The published npm package ships a prebuilt `dist/` bundle (built during `prepack`), so registry installs need no build step. For a source checkout or local path install, run `pnpm install && npm run build` first so the bundle exists.

```sh
pnpm install     # a local (uncommitted) .npmrc may pin the pnpm store repo-locally
npm run build    # tsc (host + client) + tsdown bundle
npm test         # build + the full suite (pure parser tests + real jj/git I/O when the binaries are on PATH)
npm run e2e      # browser journeys against a sandboxed dsh instance
```

## Changelog

Coarse, per-release: [CHANGELOG.md](CHANGELOG.md) · [Releases](https://github.com/americanjeff/filestab/releases).

## License

MIT. See [LICENSE](./LICENSE).
