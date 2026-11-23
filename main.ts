// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

let STRICT = false;
const TIERS: ((s: string) => string)[] = [(s) => s, (s) => s.replace(/[ \t]+$/, ''), (s) => s.replace(/^[ \t]+|[ \t]+$/g, '')];
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}
function parseDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function render(d: Doc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : '');
}

/** Occurrences of O at the first tier that has any (positions at or after `from`, accepted by `accept`). */
function occurrences(file: string[], O: string[], from = 0, accept: (p: number) => boolean = () => true): { tier: number; pos: number[] } | null {
  for (let t = 0; t < (STRICT ? 1 : 3); t++) {
    const f = TIERS[t]!;
    const o = O.map(f);
    const fl = file.map(f);
    const pos: number[] = [];
    for (let i = from; i + O.length <= fl.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (fl[i + j] !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok && accept(i)) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface Ent {
  k: ' ' | '-' | '+';
  t: string;
}
/** The lines that replace the k matched lines at `pos`. */
function build(file: string[], pos: number, tier: number, ents: Ent[]): string[] {
  const O = ents.filter((e) => e.k !== '+');
  const F = lead(file[pos]!);
  const P = lead(O[0]!.t);
  let oi = 0;
  const out: string[] = [];
  for (const e of ents) {
    if (e.k === '-') oi += 1;
    else if (e.k === ' ') {
      out.push(file[pos + oi]!);
      oi += 1;
    } else out.push(tier === 2 && e.t.trim() !== '' && e.t.startsWith(P) ? F + e.t.slice(P.length) : e.t);
  }
  return out;
}

function checkSafe(...ps: string[]): void {
  for (const p of ps) if (!safe(p)) throw new Fail('unsafe', p);
}

function need(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified (section 6) ----------
interface Hunk {
  A: number;
  ents: Ent[];
  noeol: boolean; // a `\` line follows the last context or + line
  plusNoeol: boolean; // a `\` line follows the last + line
}
interface Section {
  gitA: string | null;
  gitB: string | null;
  oldP: string | null;
  newP: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

function pathOf(l: string): string {
  const rest = l.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).replace(/^ +| +$/g, '');
}
const strip = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function unifiedEdits(L: string[]): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => ({ gitA: null, gitB: null, oldP: null, newP: null, hasPair: false, renFrom: null, renTo: null, newMode: false, delMode: false, hunks: [] });
  const n = L.length;
  let i = 0;
  while (i < n) {
    const l = L[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitA = m[1]!;
      cur.gitB = m[2]!;
      secs.push(cur);
      inHeader = true;
      i += 1;
    } else if (l.startsWith('--- ') && (L[i + 1] ?? '').startsWith('+++ ')) {
      if (!(cur !== null && inHeader && !cur.hasPair)) {
        cur = fresh();
        secs.push(cur);
        inHeader = true;
      }
      cur.hasPair = true;
      const o = pathOf(l);
      const nw = pathOf(L[i + 1]!);
      cur.oldP = o === '/dev/null' ? o : strip(o);
      cur.newP = nw === '/dev/null' ? nw : strip(nw);
      i += 2;
    } else if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const b = L[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (L[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const h: Hunk = { A: Number(m[1]), ents: [], noeol: false, plusNoeol: false };
      let lastNew = -1;
      let lastPlus = -1;
      for (const b of body) {
        if (b[0] === '\\') {
          if (h.ents.length - 1 === lastNew && lastNew >= 0) h.noeol = true;
          if (h.ents.length - 1 === lastPlus && lastPlus >= 0) h.plusNoeol = true;
        } else if (b === '') {
          h.ents.push({ k: ' ', t: '' });
          lastNew = h.ents.length - 1;
        } else {
          h.ents.push({ k: b[0] as ' ' | '-' | '+', t: b.slice(1) });
          if (b[0] !== '-') lastNew = h.ents.length - 1;
          if (b[0] === '+') lastPlus = h.ents.length - 1;
        }
      }
      cur.hunks.push(h);
      inHeader = false;
      i = j;
    } else {
      if (cur !== null && inHeader) {
        if (l.startsWith('rename from ')) cur.renFrom = l.slice(12).replace(/^ +| +$/g, '');
        else if (l.startsWith('rename to ')) cur.renTo = l.slice(10).replace(/^ +| +$/g, '');
        else if (l.startsWith('new file mode')) cur.newMode = true;
        else if (l.startsWith('deleted file mode')) cur.delMode = true;
      }
      i += 1;
    }
  }
  return secs.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: Section): Edit {
  const oldName = s.hasPair ? s.oldP! : (s.renFrom ?? s.gitA ?? '');
  const newName = s.hasPair ? s.newP! : (s.renTo ?? s.gitB ?? '');
  const creation = oldName === '/dev/null' || s.newMode;
  const deletion = !creation && (newName === '/dev/null' || s.delMode);
  if (creation) {
    const p = newName === '/dev/null' ? '' : newName;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noeol = false;
      for (const h of s.hunks) {
        const ps = h.ents.filter((e) => e.k === '+');
        if (ps.length > 0) noeol = h.plusNoeol;
        for (const e of ps) plus.push(e.t);
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
    };
  }
  if (deletion) {
    const p = oldName === '/dev/null' ? '' : oldName;
    return (tree) => {
      checkSafe(p);
      need(tree, p);
      tree.now.set(p, null);
    };
  }
  const move = oldName !== newName;
  return (tree) => {
    if (move) checkSafe(oldName, newName);
    else checkSafe(oldName);
    const text = need(tree, oldName);
    if (move && tree.get(newName) !== null) throw new Fail('exists', newName);
    const doc = parseDoc(text);
    const lines = doc.lines;
    let d = 0;
    for (const h of s.hunks) {
      const O = h.ents.filter((e) => e.k !== '+');
      const N = h.ents.filter((e) => e.k !== '-');
      if (O.length === 0) {
        const at = Math.min(Math.max(h.A + d, 0), lines.length);
        const atEnd = at === lines.length;
        lines.splice(at, 0, ...N.map((e) => e.t));
        if (atEnd) doc.final = !h.noeol;
      } else {
        const occ = occurrences(lines, O.map((e) => e.t));
        if (occ === null) throw new Fail('no-match', oldName);
        const target = h.A - 1 + d;
        let best = occ.pos[0]!;
        for (const p of occ.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        const rep = build(lines, best, occ.tier, h.ents);
        const atEnd = best + O.length === lines.length;
        lines.splice(best, O.length, ...rep);
        if (atEnd) doc.final = !h.noeol;
      }
      d += N.length - O.length;
    }
    const out = render(doc);
    if (move) {
      tree.now.set(oldName, null);
      tree.now.set(newName, out);
      tree.moves.push([oldName, newName]);
    } else tree.now.set(oldName, out);
  };
}

// ---------- SEARCH/REPLACE (section 7) ----------
function searchReplaceEdits(L: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < L.length) {
    if (L[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let mid = -1;
    for (let j = i + 1; j < L.length; j++) {
      if (L[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let j = mid + 1; j < L.length; j++) {
        if (L[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = L[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    prevPath = path;
    prevEnd = end;
    edits.push(searchReplaceEdit(path, L.slice(i + 1, mid), L.slice(mid + 1, end)));
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(p: string, oldL: string[], newL: string[]): Edit {
  return (tree) => {
    checkSafe(p);
    if (oldL.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const doc = parseDoc(need(tree, p));
    const occ = occurrences(doc.lines, oldL);
    if (occ === null) throw new Fail('no-match', p);
    if (occ.pos.length > 1) throw new Fail('ambiguous', p);
    const ents: Ent[] = [...oldL.map((t): Ent => ({ k: '-', t })), ...newL.map((t): Ent => ({ k: '+', t }))];
    doc.lines.splice(occ.pos[0]!, oldL.length, ...build(doc.lines, occ.pos[0]!, occ.tier, ents));
    tree.now.set(p, render(doc));
  };
}

// ---------- V4A (section 8) ----------
interface Chunk {
  anchor: string | null;
  ents: Ent[];
  eof: boolean;
}

function v4aEdits(L: string[]): Edit[] {
  const n = L.length;
  const b = L.findIndex((l) => !blank(l));
  if (b < 0) throw new Exit2('error: parse 1');
  if (L[b]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${b + 1}`);
  let e = n - 1;
  while (e >= 0 && blank(L[e]!)) e -= 1;
  if (L[e]!.trim() !== '*** End Patch' || e === b) throw new Exit2(`error: parse ${n + 1}`);
  const isHead = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = b + 1;
  while (i < e) {
    const l = L[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < e && !isHead(L[j]!)) j += 1;
    let k = j;
    while (k > i + 1 && blank(L[k - 1]!)) k -= 1;
    const body = L.slice(i + 1, k);
    const bodyAt = i + 2; // 1-based number of body[0]
    const idx = l.indexOf(': ');
    const path = l.slice(idx + 2).replace(/^ +| +$/g, '');
    if (l.startsWith('*** Add File: ')) {
      const lines: string[] = [];
      body.forEach((x, q) => {
        if (x === '') lines.push('');
        else if (x[0] === '+') lines.push(x.slice(1));
        else throw new Exit2(`error: parse ${bodyAt + q}`);
      });
      edits.push((tree) => {
        checkSafe(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File: ')) {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyAt}`);
      edits.push((tree) => {
        checkSafe(path);
        need(tree, path);
        tree.now.set(path, null);
      });
    } else {
      let q = 0;
      let moveTo: string | null = null;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice(13).replace(/^ +| +$/g, '');
        q = 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; q < body.length; q++) {
        const x = body[q]!;
        if (x.startsWith('@@')) {
          open = { anchor: x.slice(2).replace(/^ +| +$/g, '') || null, ents: [], eof: false };
          chunks.push(open);
        } else if (x.trim() === '*** End of File' && open !== null) {
          open.eof = true;
          open = null;
        } else if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${bodyAt + q}`);
            open = { anchor: null, ents: [], eof: false };
            chunks.push(open);
          }
          open.ents.push(x === '' ? { k: ' ', t: '' } : { k: x[0] as ' ' | '-' | '+', t: x.slice(1) });
        } else throw new Exit2(`error: parse ${bodyAt + q}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdate(path, moveTo, chunks));
    }
    i = j;
  }
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return (tree) => {
    if (moveTo !== null) checkSafe(path, moveTo);
    else checkSafe(path);
    const doc = parseDoc(need(tree, path));
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const lines = doc.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const a = occurrences(lines, [c.anchor], cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      const O = c.ents.filter((x) => x.k !== '+');
      const N = c.ents.filter((x) => x.k !== '-');
      if (O.length === 0) {
        const at = c.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...N.map((x) => x.t));
        cursor = at + N.length;
      } else {
        const occ = occurrences(lines, O.map((x) => x.t), cursor, c.eof ? (p) => p + O.length === lines.length : () => true);
        if (occ === null) throw new Fail('no-match', path);
        const pos = occ.pos[0]!;
        const rep = build(lines, pos, occ.tier, c.ents);
        lines.splice(pos, O.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = render(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else tree.now.set(path, out);
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    STRICT = strict;
    edits =
      kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? searchReplaceEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowList: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null && !consumed.has(o) && !consumed.has(nw)) {
      consumed.add(o);
      consumed.add(nw);
      rowList.push({ key: nw, line: `R ${o} -> ${nw}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!consumed.has(p)) rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
