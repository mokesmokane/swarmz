/**
 * Links in a pane (file viewing spec §2): the file paths and URLs on a row, found on hover and
 * opened on click. A path only has to look like one; the viewer says "not found" otherwise, so
 * hovering costs no round trip.
 */

export interface PathMatch {
  /** 0-based start and end (exclusive) in the row's text. */
  start: number;
  end: number;
  /** The path as written, without the `:line:col` suffix and wrapping punctuation. */
  path: string;
  line: number | null;
  col: number | null;
}

export interface UrlMatch {
  start: number;
  end: number;
  url: string;
}

/** Bare single-segment names count only with one of these extensions: `v0.4.4` is not a file. */
const BARE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "rs", "md", "kt", "kts", "py", "toml", "yml", "yaml", "sh", "zsh", "txt",
  "html", "css", "swift", "go", "java", "c", "h", "cpp", "hpp", "m", "mm", "xml", "sql", "lock", "cfg", "ini", "conf", "log",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "plist", "gradle", "env", "csv", "tsv", "svelte", "vue", "rb", "php",
]);

const PATH_CHARS = "A-Za-z0-9._\\-+@%~";
// An absolute, home or dot path, or a bare relative one with a slash, or a bare name with an
// extension; then an optional :line[:col].
const PATH_RE = new RegExp(
  `(?:~|\\.{1,2})?/[${PATH_CHARS}/]+` + // /abs, ~/x, ./x, ../x
    `|[${PATH_CHARS}]+(?:/[${PATH_CHARS}]+)+` + // src/store.ts
    `|[A-Za-z0-9_\\-+@%.]+\\.[A-Za-z0-9]{1,8}`, // README.md, foo.store.ts
  "g",
);
const SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
const URL_RE = /(?:https?|file):\/\/[^\s<>"'`)\]]+/g;
const TRAILING = new Set([".", ",", ";", ":", ")", "]", "'", '"', "`", "}", ">"]);

/** Every path on the row, left to right, with URLs left out. */
export function findPaths(text: string): PathMatch[] {
  const urls = findUrls(text);
  const out: PathMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    let start = m.index;
    let raw = m[0];
    let end = start + raw.length;
    if (urls.some((u) => start < u.end && end > u.start)) continue;
    // The character before must not be part of a word (`a.b.c` is not `b.c`), nor a URL scheme.
    const before = start > 0 ? text[start - 1] : "";
    if (/[A-Za-z0-9_\-]/.test(before) || before === "@") continue;
    // Nor the one after (`node.js-ish` is a word): the class stops at a `-` a word may go on with.
    const after = end < text.length ? text[end] : "";
    if (/[A-Za-z0-9_\-]/.test(after)) continue;
    // A `:line:col` suffix the character class does not take.
    const suffix = /^:(\d+)(?::(\d+))?/.exec(text.slice(end));
    if (suffix) {
      raw += suffix[0];
      end += suffix[0].length;
    }
    // Claude wraps paths in backticks, quotes or parentheses and ends sentences with them.
    while (raw.length > 0 && TRAILING.has(raw[raw.length - 1])) {
      raw = raw.slice(0, -1);
      end -= 1;
    }
    const s = SUFFIX_RE.exec(raw);
    const path = s ? raw.slice(0, s.index) : raw;
    if (!looksLikePath(path)) continue;
    out.push({ start, end, path, line: s ? Number(s[1]) : null, col: s?.[2] ? Number(s[2]) : null });
  }
  return out;
}

function looksLikePath(p: string): boolean {
  if (p.length < 2 || p === "/" || p === "./" || p === "../") return false;
  if (p.startsWith("/") || p.startsWith("~") || p.startsWith("./") || p.startsWith("../")) return true;
  if (p.includes("/")) return !/^\d+\/\d+$/.test(p); // `31/34` is a count
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return BARE_EXTENSIONS.has(ext) && !/^\d/.test(p);
}

/** Every URL on the row, left to right. */
export function findUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    let url = m[0];
    while (url.length > 0 && TRAILING.has(url[url.length - 1])) url = url.slice(0, -1);
    out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

/**
 * A path as the core takes it: absolute or `~`-relative. Relative ones resolve against the
 * tile's folder (which tracks the shell); `.` and `..` segments are folded. `~` stays for the
 * core, which knows the home of the Mac the shell runs on.
 */
export function resolvePath(path: string, cwd: string | null): string {
  if (path.startsWith("/") || path === "~" || path.startsWith("~/")) return normalise(path);
  const base = cwd && cwd.trim() ? cwd.trim() : "~";
  return normalise(`${base}/${path}`);
}

function normalise(p: string): string {
  const abs = p.startsWith("/");
  const home = p === "~" || p.startsWith("~/");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "~") out.pop();
    } else {
      out.push(part);
    }
  }
  if (abs) return "/" + out.join("/");
  if (home) return out.join("/");
  return out.join("/");
}
