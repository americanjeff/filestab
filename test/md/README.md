# Markdown preview comparison fixtures

`kitchen-sink.md` exercises every CommonMark + GFM construct the filestab
preview renderer is being brought up to (roadmap section 2: markdown
appearance + feature coverage). Each section is labeled with what to look for.

`kitchen-sink.gfm.html` is the same document rendered by cmark-gfm (the exact
engine GitHub runs) with GitHub-like styling, for side-by-side comparison
against the filestab rendering of `kitchen-sink.md`.

The reference is **reproducible**: `gen-gfm.mjs` renders the fixture through
cmark-gfm (table + strikethrough + tasklist + autolink extensions, safe mode,
i.e. GitHub's behavior) and wraps the output in the page template. The
committed `kitchen-sink.gfm.html` is byte-identical to a fresh run of:

```sh
node test/md/gen-gfm.mjs   # needs cmark-gfm on PATH (v0.29.0 tested)
```

Regenerate it after editing the fixture and commit the result, so the
reference always matches the fixture.
