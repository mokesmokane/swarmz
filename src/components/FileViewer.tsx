import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import rust from "highlight.js/lib/languages/rust";
import kotlin from "highlight.js/lib/languages/kotlin";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import swift from "highlight.js/lib/languages/swift";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ipc, type FileView } from "../lib/ipc";
import { useStore } from "../store";
import { hostLabel, machineLabel } from "../lib/workspace";

/** The languages the viewer colours, by file extension (file viewing spec §3). */
export const HIGHLIGHT_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", rs: "rust", kt: "kotlin", kts: "kotlin", py: "python", sh: "bash", zsh: "bash", bash: "bash",
  yml: "yaml", yaml: "yaml", md: "markdown", html: "xml", xml: "xml", svg: "xml", plist: "xml", css: "css",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini", sql: "sql", go: "go", swift: "swift", java: "java",
  gradle: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", mm: "cpp",
};

let registered = false;
function registerLanguages() {
  if (registered) return;
  registered = true;
  for (const [name, lang] of Object.entries({ typescript, javascript, json, rust, kotlin, python, bash, yaml, markdown, xml, css, ini, sql, go, swift, java, c, cpp })) {
    hljs.registerLanguage(name, lang);
  }
}

export function languageOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return HIGHLIGHT_LANGUAGES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Each line coloured on its own, so a line can be numbered, marked and found in the DOM. */
export function highlightLines(text: string, language: string | null): string[] {
  registerLanguages();
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    if (!language) return escapeHtml(line);
    try {
      return hljs.highlight(line, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(line);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/** The file a tile named, over the workbench (file viewing spec §3). */
export function FileViewer() {
  const view = useStore((s) => s.fileView);
  const closeFile = useStore((s) => s.closeFile);
  const host = useStore((s) => {
    if (!view) return null;
    const ssh = s.settings[view.id]?.ssh;
    return ssh?.host && s.sshConnected[view.id] ? ssh.host : null;
  });
  const connecting = useStore((s) => (view && s.settings[view.id]?.ssh?.host ? !s.sshConnected[view.id] : false));
  const machine = useStore((s) => {
    if (!view) return null;
    const ssh = s.settings[view.id]?.ssh;
    if (!ssh?.host) return null;
    return ssh.machine ? machineLabel(ssh.machine, s.machines[ssh.machine]) : hostLabel(ssh.host);
  });
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [raw, setRaw] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    setNote(null);
    setRaw(false);
    if (!view) return;
    if (connecting) {
      setError("not connected: connect the tile first");
      return;
    }
    let live = true;
    ipc.readFile(host, view.path).then(
      (f) => live && setFile(f),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [view, host, connecting]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view) closeFile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, closeFile]);

  const language = view ? languageOf(view.path) : null;
  const lines = useMemo(() => (file?.kind === "text" && file.text !== undefined ? highlightLines(file.text, language) : []), [file, language]);
  const isMarkdown = language === "markdown";
  const rendered = useMemo(() => (isMarkdown && !raw && file?.text !== undefined ? renderMarkdown(file.text) : null), [isMarkdown, raw, file]);

  // The linked line into view once the lines are in the DOM.
  useEffect(() => {
    if (!view?.line || lines.length === 0 || rendered) return;
    const el = bodyRef.current?.querySelector(`[data-line="${view.line}"]`);
    // jsdom has no scrollIntoView.
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") (el as HTMLElement).scrollIntoView({ block: "center" });
  }, [view, lines, rendered]);

  if (!view) return null;
  const title = view.path + (view.line ? `:${view.line}` : "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={closeFile} data-testid="file-viewer">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={view.path}
        className="flex h-full w-full max-w-6xl flex-col rounded-lg border border-neutral-700 bg-neutral-900 text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          {machine && <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300" title="The Mac the file is on">{machine}</span>}
          <span className="min-w-0 flex-1 truncate font-mono text-neutral-100" title={view.path}>{title}</span>
          {file && <span className="shrink-0 text-neutral-500">{sizeText(file.size)}{file.truncated ? " · first 2 MB" : ""}</span>}
          {file?.kind === "text" && isMarkdown && (
            <button className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800" onClick={() => setRaw((r) => !r)}>
              {raw ? "Rendered" : "Raw"}
            </button>
          )}
          {file?.kind === "text" && (!isMarkdown || raw) && (
            <button className={`rounded border px-1.5 py-0.5 hover:bg-neutral-800 ${wrap ? "border-blue-600 text-blue-300" : "border-neutral-700 text-neutral-300"}`} onClick={() => setWrap((w) => !w)}>
              Wrap
            </button>
          )}
          <button
            className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
            onClick={() => {
              writeText(view.path).then(
                () => setNote("Copied"),
                (e) => setNote(message(e)),
              );
            }}
          >
            Copy path
          </button>
          {note && <span className="text-neutral-500">{note}</span>}
          <button className="ml-1 text-neutral-500 hover:text-neutral-200" onClick={closeFile} title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto" data-testid="file-body">
          {error && <div className="p-3 text-red-400">{error}</div>}
          {!file && !error && <div className="p-3 text-neutral-500">Reading…</div>}
          {file?.kind === "binary" && (
            <div className="p-3 text-neutral-400">{`Not a text file (${sizeText(file.size)}). Open it in the app that owns it.`}</div>
          )}
          {file?.kind === "image" && file.base64 && (
            <div className="p-3">
              <img src={`data:${file.mime};base64,${file.base64}`} alt={view.path} className="max-w-none" />
            </div>
          )}
          {file?.kind === "text" && rendered !== null && (
            <div className="md-body max-w-none p-4 text-sm" dangerouslySetInnerHTML={{ __html: rendered }} />
          )}
          {file?.kind === "text" && rendered === null && (
            <table className="w-full border-collapse font-mono text-[12px] leading-5">
              <tbody>
                {lines.map((html, i) => {
                  const n = i + 1;
                  const marked = view.line === n;
                  return (
                    <tr key={n} data-line={n} className={marked ? "bg-amber-900/40" : undefined}>
                      <td className="select-none border-r border-neutral-800 px-2 text-right align-top text-neutral-600">{n}</td>
                      <td className={`px-2 align-top text-neutral-200 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} dangerouslySetInnerHTML={{ __html: html || " " }} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
