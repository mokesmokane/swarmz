import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findPaths, findUrls, resolvePath } from "./paneLinks";
import { useStore } from "../store";
import { ipc } from "./ipc";

/** The folder a tile's relative paths resolve against: the shell's, wherever it runs. */
export function tileFolder(id: string): string | null {
  const s = useStore.getState();
  const st = s.settings[id];
  if (st?.ssh?.host) return st.ssh.cwd ?? null;
  if (st?.foreign) return st.foreign.cwd;
  return s.terminals[id]?.cwd ?? null;
}

/**
 * xterm.js link provider for a pane (file viewing spec §2): the file paths and URLs on the
 * hovered row, underlined, opened on click. Columns are 1-based in xterm's ranges; a row's text
 * is read with its trailing blanks trimmed, so a match's columns are its string offsets plus one.
 */
export function paneLinkProvider(term: Terminal, id: string): ILinkProvider {
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      const range = (start: number, end: number): IBufferRange => ({ start: { x: start + 1, y }, end: { x: end, y } });
      for (const u of findUrls(text)) {
        links.push({
          range: range(u.start, u.end),
          text: u.url,
          decorations: { underline: true, pointerCursor: true },
          activate: () => {
            void ipc.openUrl(u.url).catch(() => {});
          },
        });
      }
      for (const p of findPaths(text)) {
        links.push({
          range: range(p.start, p.end),
          text: p.path,
          decorations: { underline: true, pointerCursor: true },
          activate: () => {
            useStore.getState().openFile(id, resolvePath(p.path, tileFolder(id)), p.line);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
