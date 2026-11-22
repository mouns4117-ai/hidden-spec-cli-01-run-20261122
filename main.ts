// mend — one patch tool for every AI edit format.
//
// Reads a patch (from a file, or from stdin when no file is given or the file
// is "-") and applies it to the files of the current directory. A patch may
// be written in any of four shapes:
//
//   * unified diff        (---/+++ headers, @@ hunks, +/-/space body lines)
//   * SEARCH/REPLACE      (<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE)
//   * V4A patch           (*** Begin Patch ... *** End Patch)
//   * JSON tool calls     (an array of create/str_replace/insert objects,
//                          or one such object per line)
//
// The shape is guessed from the patch itself unless --format=NAME names one.
// With --check the patch is validated but no file is touched. With --strict
// only byte-exact matches count.
//
// Nothing is written until every edit of the patch has succeeded: a patch
// that fails part-way leaves every file exactly as it was. A patch that
// succeeds prints one line per changed file (A = added, D = deleted,
// M = modified, R = renamed), then "ok: N files".
//
// Usage: node main.ts [--format=unified|search-replace|v4a|json|auto]
//                     [--check] [--strict] [--] [PATCH]
//
// Exit codes: 0 = applied (or, with --check, would apply); 1 = the patch
// parsed but one or more edits could not be applied; 2 = the command line
// or the patch itself was wrong.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Two kinds of failure, kept apart on purpose: a patch that cannot be
// parsed at all is an exit-2 problem, while an edit that cannot be applied
// to the tree is an exit-1 problem and is collected, one per failed edit.
// ---------------------------------------------------------------------------

class ParseFault extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

class EditFault extends Error {
  readonly kind: string;
  readonly target: string;
  constructor(kind: string, target: string) {
    super(`${kind} ${target}`);
    this.kind = kind;
    this.target = target;
  }
}

type Edit = (tree: WorkTree) => void;

// ---------------------------------------------------------------------------
// Small text helpers. A "blank" line is one made only of spaces and tabs.
// ---------------------------------------------------------------------------

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function trimRight(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trimLeft(s: string): string {
  return s.replace(/^[ \t]+/, '');
}

// Split a patch text into lines the way a file is split: a trailing line
// break does not create one more empty line, and a trailing CR is removed.
function splitLines(text: string): string[] {
  if (text === '') return [];
  const rows = text.split('\n');
  if (text.endsWith('\n')) rows.pop();
  return rows.map((row) => (row.endsWith('\r') ? row.slice(0, -1) : row));
}

// A path is safe when it is relative, has no backslashes, and no segment
// is empty, "." or "..". Paths are checked against the current directory
// only, so an absolute or escaping path is never touched.
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// A file held as its lines plus two facts about its ends: which line break
// it uses, and whether it ends with one. The split keeps an empty file as
// zero rows and never invents a final empty row.
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  rows: string[];
  tail: boolean;
}

function readModel(text: string): FileModel {
  if (text === '') return { br: '\n', rows: [], tail: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const rows = text.split(br);
  const tail = text.endsWith(br);
  if (tail) rows.pop();
  return { br, rows, tail };
}

function writeModel(m: FileModel): string {
  if (m.rows.length === 0) return '';
  return m.rows.join(m.br) + (m.tail ? m.br : '');
}

// ---------------------------------------------------------------------------
// Matching. A search block matches a run of file lines at a tier:
//   tier 0 — the lines are byte-identical,
//   tier 1 — they agree once trailing spaces and tabs are ignored,
//   tier 2 — they agree once leading and trailing spaces and tabs are
//            ignored.
// The first tier that matches anywhere is the tier that counts; when a
// block matches in several places at that tier the caller decides which
// occurrence to take.
// ---------------------------------------------------------------------------

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRight(a) === trimRight(b);
  return trimBoth(a) === trimBoth(b);
}

function findRuns(rows: string[], block: string[], tier: number, from = 0): number[] {
  const hits: number[] = [];
  const n = block.length;
  for (let i = from; i + n <= rows.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!tierEqual(rows[i + j]!, block[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

function locate(rows: string[], block: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = findRuns(rows, block, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

// A replacement line that came from the patch itself (ctx -1) is written
// as the patch wrote it. A context line (ctx >= 0) is written exactly as
// the file has it at the matched place. At tier 2 a fresh line is
// re-indented: it keeps the patch's indentation relative to the search
// block's first line and takes the file's indentation for that first line.
function reindent(text: string, fileLead: string, oldLead: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (text.startsWith(oldLead)) return fileLead + text.slice(oldLead.length);
  return text;
}

interface NewPiece {
  text: string;
  ctx: number;
}

function buildReplacement(rows: string[], old: string[], pieces: NewPiece[], tier: number, pos: number): string[] {
  const fileLead = leadingWs(rows[pos]!);
  const oldLead = leadingWs(old[0]!);
  return pieces.map((pc) => {
    if (pc.ctx >= 0) return rows[pos + pc.ctx]!;
    if (tier === 2) return reindent(pc.text, fileLead, oldLead);
    return pc.text;
  });
}

// ---------------------------------------------------------------------------
// The work tree: what the files look like on disk (read lazily, once per
// path) plus the edits staged so far. Every edit reads through the tree
// and writes only into the staged map, so a later edit in the same patch
// sees the earlier edits, and nothing touches disk until the end.
// ---------------------------------------------------------------------------

class WorkTree {
  private seen = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let value: string | null = null;
      try {
        if (fs.statSync(p).isFile()) value = fs.readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.seen.set(p, value);
    }
    return this.seen.get(p)!;
  }

  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.original(p);
  }

  noteMove(from: string, to: string): void {
    this.moves.push([from, to]);
  }
}

// ---------------------------------------------------------------------------
// Unified diff.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  c: number;
  lines: BodyLine[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk && sec) {
      while (
        hunk.lines.length > 0 &&
        hunk.lines[hunk.lines.length - 1]!.kind === 'ctx' &&
        hunk.lines[hunk.lines.length - 1]!.text === ''
      ) {
        hunk.lines.pop();
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec) sections.push(sec);
    sec = null;
  };

  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitHead = /^diff --git a\/(.+) b\/(.+)$/;
  const pairAfter = (idx: number): boolean => (lines[idx + 1] ?? '').startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && pairAfter(i))) {
        closeHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        const kind: BodyLine['kind'] =
          line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'mark';
        hunk.lines.push({ kind, text: line === '' ? '' : line.slice(1), raw: line });
        i++;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (!m || !sec) throw new ParseFault(i + 1);
      hunk = { a: Number(m[1]), c: Number(m[3]), lines: [] };
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = gitHead.exec(line);
      if (!m) throw new ParseFault(i + 1);
      closeSection();
      sec = {
        oldPath: m[1]!,
        newPath: m[2]!,
        hasPair: false,
        renameFrom: undefined,
        renameTo: undefined,
        isNew: false,
        isDel: false,
        hunks: [],
      };
      i++;
      continue;
    }
    if (line.startsWith('--- ') && pairAfter(i)) {
      if (sec && !sec.hasPair && sec.hunks.length === 0) {
        sec.oldPath = stripAB(headerPath(line));
        sec.newPath = stripAB(headerPath(lines[i + 1]!));
        sec.hasPair = true;
        i += 2;
        continue;
      }
      closeSection();
      sec = {
        oldPath: stripAB(headerPath(line)),
        newPath: stripAB(headerPath(lines[i + 1]!)),
        hasPair: true,
        renameFrom: undefined,
        renameTo: undefined,
        isNew: false,
        isDel: false,
        hunks: [],
      };
      i += 2;
      continue;
    }
    if (sec) {
      if (line.startsWith('--- ') && sec.hunks.length === 0) throw new ParseFault(i + 2);
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  closeSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

// A hunk's result ends with a line break unless a "\" line follows the
// hunk's last context or "+" line.
function hunkNoBreak(h: Hunk): boolean {
  for (let k = h.lines.length - 1; k >= 0; k--) {
    const l = h.lines[k]!;
    if (l.kind === 'ctx' || l.kind === 'new') return h.lines[k + 1]?.kind === 'mark';
  }
  return false;
}

// The same rule, for a created file: a "\" line after the last "+" line
// of the whole section.
function createdNoBreak(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi]!;
    for (let k = h.lines.length - 1; k >= 0; k--) {
      if (h.lines[k]!.kind === 'new') return h.lines[k + 1]?.kind === 'mark';
    }
  }
  return false;
}

// Apply every hunk of one section to a file's text, in order. The drift
// d tracks how many lines the earlier hunks added or removed, so each
// hunk's line number stays relative to the file as it is now.
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): FileModel {
  const model = readModel(text);
  let d = 0;
  for (const h of hunks) {
    const oldLines: string[] = [];
    const newPieces: NewPiece[] = [];
    for (const l of h.lines) {
      if (l.kind === 'ctx') {
        oldLines.push(l.text);
        newPieces.push({ text: l.text, ctx: oldLines.length - 1 });
      } else if (l.kind === 'old') {
        oldLines.push(l.text);
      } else if (l.kind === 'new') {
        newPieces.push({ text: l.text, ctx: -1 });
      }
    }
    const noBreak = hunkNoBreak(h);
    if (oldLines.length === 0) {
      const at = Math.min(Math.max(0, h.a + d), model.rows.length);
      const wasEnd = at === model.rows.length;
      const ins = newPieces.map((pc) => pc.text);
      model.rows.splice(at, 0, ...ins);
      if (wasEnd) model.tail = !noBreak;
      d += newPieces.length;
      continue;
    }
    const found = locate(model.rows, oldLines, strict);
    if (!found) throw new EditFault('no-match', failPath);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const repl = buildReplacement(model.rows, oldLines, newPieces, found.tier, pos);
    const atEnd = pos + oldLines.length === model.rows.length;
    model.rows.splice(pos, oldLines.length, ...repl);
    if (atEnd) model.tail = !noBreak;
    d += newPieces.length - oldLines.length;
  }
  return model;
}

function unifiedEdit(s: DiffSection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.oldPath : (s.renameFrom ?? s.oldPath);
  const newP = s.hasPair ? s.newPath : (s.renameTo ?? s.newPath);
  const create = oldP === null || s.isNew;
  const remove = newP === null || s.isDel;
  return (tree) => {
    if (create) {
      const np = newP ?? '';
      if (!isSafePath(np)) throw new EditFault('unsafe', np);
      if (tree.current(np) !== null) throw new EditFault('exists', np);
      const plus = s.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'new').map((l) => l.text));
      const noBreak = createdNoBreak(s.hunks);
      tree.pending.set(np, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (remove) {
      const op = oldP ?? '';
      if (!isSafePath(op)) throw new EditFault('unsafe', op);
      if (tree.current(op) === null) throw new EditFault('missing', op);
      tree.pending.set(op, null);
      return;
    }
    const op = oldP ?? '';
    const np = newP ?? '';
    if (!isSafePath(op)) throw new EditFault('unsafe', op);
    if (!isSafePath(np)) throw new EditFault('unsafe', np);
    const isMove = op !== np;
    const before = tree.current(op);
    if (before === null) throw new EditFault('missing', op);
    if (isMove && tree.current(np) !== null) throw new EditFault('exists', np);
    const model = applyHunks(before, s.hunks, strict, op);
    const out = writeModel(model);
    if (isMove) {
      tree.pending.set(np, out);
      tree.pending.set(op, null);
      tree.noteMove(op, np);
    } else {
      tree.pending.set(op, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new ParseFault(searchNo);
      p = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new ParseFault(searchNo);
    }
    if (sep === -1) throw new ParseFault(searchNo);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new ParseFault(searchNo);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(p, oldLines, newLines, strict));
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.current(p) !== null) throw new EditFault('exists', p);
      tree.pending.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.current(p);
    if (before === null) throw new EditFault('missing', p);
    const model = readModel(before);
    const found = locate(model.rows, oldLines, strict);
    if (!found) throw new EditFault('no-match', p);
    if (found.at.length > 1) throw new EditFault('ambiguous', p);
    const pos = found.at[0]!;
    const pieces: NewPiece[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const repl = buildReplacement(model.rows, oldLines, pieces, found.tier, pos);
    model.rows.splice(pos, oldLines.length, ...repl);
    tree.pending.set(p, writeModel(model));
  };
}

// ---------------------------------------------------------------------------
// V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

// A blank line at the end of a chunk's body does not belong to it: a
// context line for an empty file line, written as an empty line or as a
// single space, is dropped from the end of the body.
function stripChunk(chunk: V4aChunk): void {
  while (
    chunk.body.length > 0 &&
    chunk.body[chunk.body.length - 1]!.kind === 'ctx' &&
    chunk.body[chunk.body.length - 1]!.text === ''
  ) {
    chunk.body.pop();
  }
}

function findAnchorLine(rows: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < rows.length; i++) {
      if (tierEqual(rows[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const p = line.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
          continue;
        }
        if (l === '') {
          fileLines.push('');
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const p = line.slice('*** Delete File:'.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isBlank(l)) {
          i++;
          continue;
        }
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
        throw new ParseFault(i + 1);
      }
      edits.push(v4aDelEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const p = line.slice('*** Update File:'.length).trim();
      const updNo = i + 1;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      let seenBody = false;
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l === '') {
          if (chunk) chunk.body.push({ kind: 'ctx', text: '', raw: '' });
          i++;
          continue;
        }
        if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
        if (moveTo === null && !seenBody && l.startsWith('*** Move to:')) {
          moveTo = l.slice('*** Move to:'.length).trim();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (chunk) {
            stripChunk(chunk);
            chunks.push(chunk);
          }
          chunk = { anchor: l.slice(2).trim(), body: [], eof: false };
          seenBody = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (!chunk) throw new ParseFault(i + 1);
          chunk.eof = true;
          stripChunk(chunk);
          chunks.push(chunk);
          chunk = null;
          seenBody = true;
          i++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!chunk) {
            if (seenBody) throw new ParseFault(i + 1);
            chunk = { anchor: null, body: [], eof: false };
            seenBody = true;
          }
          const kind: BodyLine['kind'] = l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          chunk.body.push({ kind, text: l.slice(1), raw: l });
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      if (chunk) {
        stripChunk(chunk);
        chunks.push(chunk);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updNo);
      edits.push(v4aUpdEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (tree.current(p) !== null) throw new EditFault('exists', p);
    tree.pending.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelEdit(p: string): Edit {
  return (tree) => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (tree.current(p) === null) throw new EditFault('missing', p);
    tree.pending.set(p, null);
  };
}

function v4aUpdEdit(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.current(p);
    if (before === null) throw new EditFault('missing', p);
    if (moveTo !== null && tree.current(moveTo) !== null) throw new EditFault('exists', moveTo);
    const model = readModel(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const idx = findAnchorLine(model.rows, ch.anchor, cursor, strict);
        if (idx < 0) throw new EditFault('no-match', p);
        cursor = idx + 1;
      }
      const oldLines: string[] = [];
      const newPieces: NewPiece[] = [];
      for (const l of ch.body) {
        if (l.kind === 'ctx') {
          oldLines.push(l.text);
          newPieces.push({ text: l.text, ctx: oldLines.length - 1 });
        } else if (l.kind === 'old') {
          oldLines.push(l.text);
        } else if (l.kind === 'new') {
          newPieces.push({ text: l.text, ctx: -1 });
        }
      }
      if (oldLines.length === 0) {
        const at = ch.eof ? model.rows.length : cursor;
        const ins = newPieces.map((pc) => pc.text);
        model.rows.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = locate(model.rows, oldLines, strict, cursor);
      if (!found) throw new EditFault('no-match', p);
      let positions = found.at;
      if (ch.eof) positions = positions.filter((pos) => pos + oldLines.length === model.rows.length);
      if (positions.length === 0) throw new EditFault('no-match', p);
      const pos = positions[0]!;
      const repl = buildReplacement(model.rows, oldLines, newPieces, found.tier, pos);
      model.rows.splice(pos, oldLines.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = writeModel(model);
    if (moveTo !== null) {
      tree.pending.set(moveTo, out);
      tree.pending.set(p, null);
      tree.noteMove(p, moveTo);
    } else {
      tree.pending.set(p, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON tool calls: an array of objects, or one object per line.
// ---------------------------------------------------------------------------

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const item of v) {
      const e = jsonEdit(item);
      if (!e) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (!e) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const need = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.current(p) !== null) throw new EditFault('exists', p);
      tree.pending.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const add = splitLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const model = readModel(before);
      if (atLine < 0 || atLine > model.rows.length) throw new EditFault('no-match', p);
      model.rows.splice(atLine, 0, ...add);
      tree.pending.set(p, writeModel(model));
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Format detection, from the patch itself.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) =>
        l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The command line and the run.
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface Outcome {
  code: number;
  lines: string[];
}

function run(argv: string[]): Outcome {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
        continue;
      }
      if (a === '--check' && !checkOnly) {
        checkOnly = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, lines: ['error: usage'] };
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, lines: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = fs.readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, lines: ['error: no-patch'] };
  }
  const lines = splitLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, lines: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, lines: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new WorkTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const saved = new Map(tree.pending);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.pending.clear();
      for (const [k, v] of saved) tree.pending.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      lines: [...failures.map((f) => `error: ${f.kind} ${f.target}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // One summary line per file that changed. A move whose destination was
  // created by the move itself prints as R and hides the D/A pair.
  const rows: Array<{ key: string; text: string }> = [];
  const hidden = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.current(oldP) === null &&
      tree.original(newP) === null &&
      tree.current(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      hidden.add(oldP);
      hidden.add(newP);
    }
  }
  for (const p of tree.pending.keys()) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${kind} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!checkOnly) {
    for (const p of tree.pending.keys()) {
      const was = tree.original(p);
      const now = tree.pending.get(p)!;
      if (was === now) continue;
      if (now === null) {
        fs.rmSync(p, { force: true });
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, now);
      }
    }
  }
  return { code: 0, lines: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = run(process.argv.slice(2));
  fs.writeSync(1, result.lines.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
