// Fast Site Builder: a faster drop-in for makefun-site 1.0.0.
// Reimplements makefun-site's build() byte-exactly (same front matter, template
// dialect, Markdown subset, slug rule and report) with an optimised engine:
// segment-based inline rendering, regex-free Markdown lexing, a frame-stack
// template interpreter, and memoised slugs/dates. No imports, no I/O, no clock,
// no randomness. Caches are cleared at the start of every run() so each case is
// answered alone.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function byCodeUnits(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_CACHE = new Map();

/**
 * `text` with & < > " and ' escaped. Short strings take a cheap indexOf check
 * first (template values, hrefs); long ones go straight to the native replace.
 * Results are memoised per run: the same title or url is escaped once per case
 * although it is rendered on its page, the index, its tag pages and `recent`.
 */
function escapeHtml(text) {
  const cached = ESC_CACHE.get(text);
  if (cached !== undefined) return cached;
  let res;
  if (text.length < 256) {
    if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1 && text.indexOf('"') === -1 && text.indexOf("'") === -1) res = text;
    else res = text.replace(ESC_RE, (c) => ESCAPES[c]);
  } else {
    res = text.replace(ESC_RE, (c) => ESCAPES[c]);
  }
  ESC_CACHE.set(text, res);
  return res;
}

/** Whether char code `c` is JavaScript whitespace (\s): a table lookup. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

function isSpaceCode(c) {
  return WS_TABLE[c] === 1;
}

const SLUG_CACHE = new Map();
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure-ASCII input skips normalize(): NFKD is the identity there and ASCII holds
 * no combining marks.
 */
function slugify(text) {
  const cached = SLUG_CACHE.get(text);
  if (cached !== undefined) return cached;
  let res;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    res = out === '' ? 'untitled' : out;
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    res = out === '' ? 'untitled' : out;
  }
  SLUG_CACHE.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_CACHE = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const cached = DATE_CACHE.get(date);
  if (cached !== undefined) return cached;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const res = `${d} ${MONTHS[m - 1]} ${y}`;
  DATE_CACHE.set(date, res);
  return res;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The closing line is found with indexOf, so only the (short) front matter is split, never the body.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let after = -1;
  let searchFrom = firstNl;
  while (true) {
    const idx = text.indexOf('\n---', searchFrom);
    if (idx === -1) break;
    const a = idx + 4;
    if (a === text.length || text.charCodeAt(a) === 10) {
      closeStart = idx;
      after = a;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = firstNl === -1 ? '' : text.slice(firstNl + 1, closeStart);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: after === text.length ? '' : text.slice(after + 1) };
}

// ---------------------------------------------------------------- markdown

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open line's language, or null. /^```([A-Za-z0-9_+-]*)[ \t]*$/ */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  for (let j = k; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, k);
}

/** Whether `line` closes a fence. /^```[ \t]*$/ */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's [depth, text], or null (a heading's text is never empty). /^(#{1,6})[ \t]+(.*?)[ \t]*$/ */
function headingInfo(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d + 1;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return [d, line.slice(s, e)];
}

/** Whether `line` is a thematic break. /^(?:---|\*\*\*)[ \t]*$/ */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet line's item text, or null. /^[-*] (.*)$/ */
function bulletText(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.length >= 2 && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered-list line's [start, item text], or null. /^(\d{1,9})\. (.*)$/ */
function orderedInfo(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return [Number(line.slice(0, d)), line.slice(d + 2)];
}

/** Whether `line` continues a list item. /^ {2,}\S/ */
function isContinued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(k));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingInfo(line) !== null || isHr(line);
}

/** The characters a backslash escapes. */
const ESC_OK = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESC_OK[ch.charCodeAt(0)] = 1;

/**
 * Whether the character at `pos` is escaped: exactly when the maximal run of
 * backslashes immediately before it has odd length (the reference scans
 * left-to-right pairing each backslash with the escapable char after it, which
 * pairs a backslash run among itself from its start, since the char before the
 * run is not a backslash).
 */
function isEscaped(s, pos) {
  let n = 0;
  for (let p = pos - 1; p >= 0 && s.charCodeAt(p) === 92; p--) n++;
  return (n & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, within [from, end), or -1. */
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (j + what.length > end) return -1;
    if (!isEscaped(s, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, within [from, end), or -1. */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (isEscaped(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    if (isSpaceCode(s.charCodeAt(i))) return true;
  }
  return false;
}

const SPECIAL_RE = /[\\`*[\]&<>"']/g;
const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const out = [];
  inlineInto(s, env, out, 0, s.length);
  return out.join('');
}

/**
 * `s[start, end)` rendered inline into `out`. One scan handles both the
 * Markdown constructs and the HTML escaping: the plain run between two specials
 * holds neither kind, so it is pushed raw. Strong, emphasis and link text are
 * rendered by recursion into the same array, so no intermediate string, slice
 * or join is made for them.
 */
function inlineInto(s, env, out, start, end) {
  const re = SPECIAL_RE;
  let i = start;
  while (i < end) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null || m.index >= end) {
      out.push(s.slice(i, end));
      break;
    }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    i = j;
    const c = s[i];
    const ent = HTML_ENT[c];
    if (ent !== undefined) {
      out.push(ent);
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < end && ESC_OK[s.charCodeAt(i + 1)] === 1) {
      // Of the escapable characters only '>' is an HTML special.
      out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1 && k < end) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, end);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, env, out, i + 2, k);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, end);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s, env, out, i + 1, k);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, end);
      const m2 = k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= end ? '' : s.slice(k + 2, m2);
      if (target !== '' && !hasWhitespace(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, env, out, i + 1, k);
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A lone backslash before a non-escapable character, or a plain ']' outside
    // a link: itself (neither is an HTML special).
    out.push(c);
    i++;
  }
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else {
      if (!inWord) n++;
      inWord = true;
    }
  }
  return n;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lines are dispatched on their first character: only the block kinds a line can start can match it, so most
 * classifier calls are skipped.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const code = [];
        for (let q = 0; q < body.length; q++) code.push(escapeHtml(body[q]), '\n');
        blocks.push(`<pre><code${cls}>${code.join('')}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingInfo(line);
      if (heading !== null) {
        const depth = heading[0];
        const text = heading[1];
        const id = uniqueSlug(slugify(text), ids);
        const html = inline(text, env);
        blocks.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const bText = bulletText(line);
      if (bText !== null) {
        const items = [];
        let cur = null;
        while (i < L) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          if (d0 === 45 || d0 === 42) {
            const t = bulletText(l);
            if (t !== null) {
              if (cur !== null) items.push(cur.join('\n'));
              cur = [trimLine(t)];
              i++;
              continue;
            }
          }
          if (d0 === 32 && isContinued(l)) {
            cur.push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        if (cur !== null) items.push(cur.join('\n'));
        let list = '<ul>\n';
        for (let q = 0; q < items.length; q++) list += `<li>${inline(items[q], env)}</li>\n`;
        list += '</ul>';
        blocks.push(`${list}\n`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const trimmed = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimLine(body[q]);
        if (t !== '') trimmed.push(t);
      }
      blocks.push(trimmed.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(trimmed.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const oInfo = orderedInfo(line);
      if (oInfo !== null) {
        const items = [];
        let cur = null;
        while (i < L) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          if (d0 >= 48 && d0 <= 57) {
            const m = orderedInfo(l);
            if (m !== null) {
              if (cur !== null) items.push(cur.join('\n'));
              cur = [trimLine(m[1])];
              i++;
              continue;
            }
          }
          if (d0 === 32 && isContinued(l)) {
            cur.push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        if (cur !== null) items.push(cur.join('\n'));
        let list = oInfo[0] !== 1 ? `<ol start="${oInfo[0]}">\n` : '<ol>\n';
        for (let q = 0; q < items.length; q++) list += `<li>${inline(items[q], env)}</li>\n`;
        list += '</ol>';
        blocks.push(`${list}\n`);
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < L) {
      const l = lines[i];
      const d0 = l.charCodeAt(0);
      if (l.length === 0) break;
      if (d0 === 32 || d0 === 9) {
        if (isBlankLine(l)) break;
      } else if (d0 === 96) {
        if (fenceLang(l) !== null) break;
      } else if (d0 === 35) {
        if (headingInfo(l) !== null) break;
      } else if (d0 === 45 || d0 === 42) {
        if (isHr(l)) break;
      }
      body.push(trimLine(l));
      i++;
    }
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the frame stack: its first name from the innermost
 * frame holding it, then own properties. Every template-visible object is built
 * with a null prototype and never stores `undefined`, so a missing key reads as
 * `undefined` exactly as the reference's hasOwn check decides.
 */
function lookup(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const v0 = frames[f][first];
    if (v0 !== undefined) {
      let v = v0;
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object') return undefined;
        v = v[path[k]];
        if (v === undefined) return undefined;
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function nullObj() {
  return Object.create(null);
}

/**
 * `nodes` rendered into `out` under the frame stack `frames` (innermost last).
 * A for-loop reuses one frame and one loop object for all its iterations,
 * mutated in place; rendering is synchronous, so no iteration can observe a
 * half-updated frame. A `loop` binding always wins over an element bound under
 * the same name, as the reference's object literal `{[name]: x, loop: {...}}`
 * does (the loop key comes last).
 */
function renderInto(nodes, frames, ctx, depth, out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(frames, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(frames, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const branch = truthy(lookup(frames, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, frames, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const frame = nullObj();
        const loop = nullObj();
        frame.loop = loop;
        frames.push(frame);
        for (let k = 0; k < len; k++) {
          frame[n.name] = xs[k];
          frame.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          loop.length = len;
          renderInto(n.body, frames, ctx, depth, out);
        }
        frames.pop();
        break;
      }
      case 'include': {
        // Flattened includes carry their pre-expanded nodes; an unexpanded one
        // (only from the defensive fallback below) resolves by name instead.
        const t = n.nodes !== undefined ? n.nodes : ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, frames, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- pipeline

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenSet = taken.get(dir);
    if (takenSet === undefined) {
      takenSet = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenSet);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  const len = posts.length;
  for (let k = 0; k < len; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === len - 1 ? null : posts[k + 1];
  }
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const rawTags = s.data.tags ?? [];
    const res = [];
    for (let i = 0; i < rawTags.length; i++) {
      const name = rawTags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        res.push(name);
      }
    }
    return res;
  };
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = nullObj();
        tag.name = name;
        tag.slug = slug;
        tag.url = `${b.base}/tags/${slug}/`;
        tag.posts = [];
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (!s.post) {
      const names = ownTags(s);
      s.tagRefs = names.map((name) => {
        const slug = slugify(name);
        const t = bySlug.get(slug);
        if (t !== undefined) return t;
        const tag = nullObj();
        tag.name = name;
        tag.slug = slug;
        tag.url = '';
        tag.posts = [];
        return tag;
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  const o = nullObj();
  o.title = s.data.title;
  o.url = s.url;
  o.date = s.data.date ?? '';
  o.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
  return o;
}

/** A tag as templates read it (its posts as cards). */
function tagOf(b, t) {
  const o = nullObj();
  o.name = t.name;
  o.slug = t.slug;
  o.url = t.url;
  o.count = t.posts.length;
  o.posts = t.posts.map((p) => b.cards.get(p));
  return o;
}

/** A post's card, as lists show it. */
function cardOf(s) {
  const o = nullObj();
  o.title = s.data.title;
  o.url = s.url;
  o.date = s.data.date ?? '';
  o.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
  o.summary = s.data.summary ?? '';
  o.excerpt = s.excerpt;
  o.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
  o.tags = s.tagRefs.map((t) => {
    const tag = nullObj();
    tag.name = t.name;
    tag.slug = t.slug;
    tag.url = t.url;
    return tag;
  });
  return o;
}

/** A page as its layout reads it. `card` is its card (the cached one for a post). */
function pageOf(s, card) {
  const o = { ...card };
  o.slug = s.slug;
  o.content = s.html;
  o.toc = s.toc.map((h) => {
    const t = nullObj();
    t.level = h.level;
    t.id = h.id;
    t.html = h.html;
    return t;
  });
  o.newer = linkOf(s.newer ?? null);
  o.older = linkOf(s.older ?? null);
  o.is_post = s.post;
  return o;
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = nullObj();
  site.title = b.input.site.title;
  site.base_url = b.base;
  const allTags = b.tags.map((t) => {
    const tag = nullObj();
    tag.name = t.name;
    tag.slug = t.slug;
    tag.url = t.url;
    tag.count = t.posts.length;
    return tag;
  });
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const nodes = b.expand(name, 0);
    if (nodes === undefined) return null;
    const frame = nullObj();
    frame.site = site;
    frame.tags = allTags;
    frame.recent = recent;
    Object.assign(frame, vars);
    const out = [];
    renderInto(nodes, [frame], ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? b.cards.get(s) : cardOf(s)) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const pager = nullObj();
    pager.number = k;
    pager.total = pages;
    pager.url = indexUrl(k);
    pager.newer_url = k === 1 ? '' : indexUrl(k - 1);
    pager.older_url = k === pages ? '' : indexUrl(k + 1);
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager,
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pages = 0;
  for (let i = 0; i < b.sources.length; i++) if (!b.sources[i].post) pages++;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

const PIPELINE = [readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report];

/** One site's output tree: path -> text. */
export function run(input) {
  // Each case is answered alone: no memoised value survives into the next case.
  SLUG_CACHE.clear();
  DATE_CACHE.clear();
  ESC_CACHE.clear();
  const templates = new Map();
  const reportList = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportList.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportList,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  // Include flattening, per case: a template's nodes with every {% include %}
  // spliced in at its own depth (an include renders in the same scope, so
  // splicing its nodes is exact), memoised per (template, depth). An include
  // past depth 8 renders nothing, as the reference decides. A list that would
  // grow past the cap, or a spent budget, keeps a pre-resolved reference node
  // instead of splicing, so adversarial templates cannot blow the memory up.
  const flatCache = new Map();
  const flatBudget = { n: 200000 };
  const expandList = (nodes, depth) => {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === 'include') {
        if (depth >= INCLUDE_DEPTH) continue;
        const sub = expand(n.name, depth + 1);
        if (sub === undefined) continue;
        if (out.length + sub.length <= 1024 && flatBudget.n > 0) {
          flatBudget.n -= sub.length;
          for (let q = 0; q < sub.length; q++) out.push(sub[q]);
        } else {
          out.push({ kind: 'include', nodes: sub });
        }
      } else if (n.kind === 'for') {
        out.push({ kind: 'for', name: n.name, path: n.path, body: expandList(n.body, depth) });
      } else if (n.kind === 'if') {
        out.push({ kind: 'if', not: n.not, path: n.path, then: expandList(n.then, depth), else: n.else === null ? null : expandList(n.else, depth) });
      } else {
        out.push(n);
      }
    }
    return out;
  };
  const expand = (name, depth) => {
    const key = `${name} ${depth}`;
    let hit = flatCache.get(key);
    if (hit !== undefined) return hit;
    const nodes = templates.get(name);
    if (nodes === undefined) return undefined;
    hit = expandList(nodes, depth);
    flatCache.set(key, hit);
    return hit;
  };
  b.expand = expand;
  for (let i = 0; i < PIPELINE.length; i++) PIPELINE[i](b);
  return b.output;
}
