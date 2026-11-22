# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mouns4117-ai/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mouns4117-ai/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies an edit written by an AI model to a
tree of text files. Models write edits in four shapes, and `mend` reads them
all:

- **unified diffs** — `---`/`+++` headers, `@@` hunks, `+`/`-`/space body
  lines, often with wrong line numbers;
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` … `=======` … `>>>>>>> REPLACE`;
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add File`,
  `Delete File` and `Update File` sections, `@@` anchors and `*** Move to:`;
- **JSON tool calls** — an array of `create` / `str_replace` / `insert`
  objects, or one such object per line.

The shape is detected from the patch itself, or named with
`--format=NAME`. The full contract is `SPEC.md`.

## Usage

    node main.ts [--format=unified|search-replace|v4a|json|auto]
                 [--check] [--strict] [--] [PATCH]

`PATCH` is the patch file, relative to the working directory; when it is
absent, or is `-`, the patch is read from standard input. The working
directory is the root of the tree: every path in a patch is relative to it.

- `--check` validates and reports exactly as a real run would, but writes
  nothing.
- `--strict` matches lines byte-for-byte only (tier 0); without it, a search
  block also matches when the lines agree after trailing whitespace is
  ignored (tier 1), or after leading and trailing whitespace is ignored
  (tier 2, with fresh lines re-indented to the file's own indentation).

Exit codes: `0` applied (or would apply, with `--check`); `1` the patch
parsed but one or more edits could not be applied; `2` the command line or
the patch itself was wrong. On success the tool prints one line per changed
file — `A` added, `D` deleted, `M` modified, `R old -> new` moved — then
`ok: N files`.

## How it works

- **Three-tier matching.** A search block is looked up at the first tier
  where it occurs at all. A unified hunk takes the occurrence nearest its
  (possibly wrong) line number, drifting with earlier hunks; a SEARCH/REPLACE
  block fails as ambiguous when it occurs more than once; a V4A chunk takes
  the first occurrence at or after its cursor, or after its `@@` anchor.
- **Context lines are the file's own.** A line that is both old and new is
  written exactly as the file has it, never as the patch wrote it.
- **Atomicity.** Nothing is written until every edit of the patch has
  succeeded. A patch that fails part-way leaves every file exactly as it
  was, and reports every failed edit. A file whose bytes end up unchanged is
  not listed.
- **Safe paths only.** A path that is empty, absolute, holds a backslash, or
  has an empty, `.` or `..` segment is refused before anything else about
  the edit is looked at. Parent directories are created as files need them.
- **Line endings kept.** A file keeps its own line break (CRLF or LF) and
  its final line break, except where a unified hunk's `\ No newline at end
  of file` says otherwise. Files a patch creates use LF. A JSON `create`
  writes its `file_text` byte for byte.

## Files

- `main.ts` — the tool itself. Node 22, standard library only, no network.
- `runner.ts` — the kit's trial runner, kept byte-identical. When
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
- `check.ts` — the kit's local grader: `node check.ts
  ../program/generator/practice.json` from this directory (with the kit
  beside it).
- `SPEC.md` — the specification this tool implements.
- `LICENSE` — MIT.

## Verification

- Practice set (`program/generator/practice.json` in the kit): **100 of 100
  passed, practice score 1000** — every family (unified 30, SEARCH/REPLACE
  20, V4A 20, JSON 15, CLI 15).
- A hand-built edge suite of 57 cases covering SPEC.md sentences the
  practice set does not show (usage errors, `--` handling, lone `--- ` lines
  in headers and bodies, path inheritance, pure V4A moves, empty chunks,
  JSON parse faults, insert bounds, CRLF `create` bytes): **57 of 57
  passed**.
- Determinism: one case from each format group, run twice in fresh
  directories, gives byte-identical exit codes, stdout and files.
- Each run takes about 0.2 s, most of it Node starting up; the tool itself
  is a single pass over the patch and the files it touches.
