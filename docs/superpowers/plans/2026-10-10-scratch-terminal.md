# Scratch Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `>_` button on agent tiles that opens a small floating plain shell in the agent's folder (on the agent's Mac), and a `swarmz scratch` command that lets the agent pop it up for the user without ever seeing it.

**Architecture:** The scratch shell is an ordinary session holder with id `scratch-<tile id>`, created with `ipc.createTerminal` directly so it never enters the store's `terminals`/`order`/`settings`/layout (not saved, synced or listed). The store keeps an in-memory `scratch` map per agent tile; a `ScratchWindow` component floats inside `TerminalPane` and mounts the scratch xterm through the existing `xtermRegistry.attach`. Agents ask for it by appending a `Scratch` line to `events.log`, which `agents.rs` already streams to the app.

**Tech Stack:** Tauri 2 (Rust), the `swarmz-tool` crate, React 19 + TypeScript + zustand, xterm.js, vitest + Testing Library, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-10-scratch-terminal-design.md`

## Global Constraints

- Scratch terminal id: `scratch-<tile id>`; a holder id must be letters, digits and `-`, at most 64 characters (`paths::valid_tile_id`).
- Registry name requested: `<tile name>-scratch`.
- `swarmz scratch` limits: note at most 200 characters, command at most 500; any control character (including newline) is refused with `bad_text`.
- `swarmz scratch` reply: `{"v":1,"asked":true}` and nothing else.
- Error codes: `no_tile`, `self`, `too_long`, `bad_text` (scratch); `scratch` (a tile command given a scratch id).
- A `Scratch` event opens a window only when live: not older than launch, and within `SCRATCH_LIVE_MS` (30 000 ms) of now.
- Type it never sends CR or LF.
- Commit messages follow `type(scope): summary` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never build or bundle the desktop app locally (`npm run tauri build`); `npm run tauri dev` is fine.
- Component tests start with `// @vitest-environment jsdom`; every frontend test mocks `./lib/ipc`.

## Review Focus

- A remote folder starting with `~/` (or exactly `~`): the scratch ssh line must still land there, so `~` stays unquoted (Task 4 test).
- A tile with no known remote folder (`ssh.cwd` null): the scratch line must still open a login shell in the remote home (Task 4 test).
- Clicking `>_` twice quickly: only one holder is created (Task 5 test).
- The agent tile closing while its scratch shell is still starting: the new scratch holder is closed, not left running (Task 5 test).
- A burst of identical `Scratch` lines (an agent retrying, or the remote tail re-sending its backlog after a reconnect): one window open, no duplicate starts (Task 6 test).

---

### Task 1: Scratch ids in the tool, and tile commands refuse them

**Files:**
- Modify: `src-tauri/tool/src/paths.rs` (add `SCRATCH_PREFIX`, `is_scratch_id`)
- Modify: `src-tauri/tool/src/commands.rs:97` (`resolve_tile`)
- Modify: `src-tauri/tool/src/main.rs:289` (`info`)
- Test: `src-tauri/tool/src/paths.rs` (unit), `src-tauri/tool/tests/cli.rs`

**Interfaces:**
- Produces: `swarmz_tool::paths::SCRATCH_PREFIX: &str = "scratch-"`, `swarmz_tool::paths::is_scratch_id(id: &str) -> bool`. Every command that resolves a tile through `cmd::tile_arg`/`resolve_tile` (`output`, `pending`, `answer`, `send`, `key`, `restart`, `transcript`, `image`, `ask`, `card --tile`, `board --tile`, `watch`) and `info` fail with code `scratch`. `hold`, `attach` and `close` still accept scratch ids: the app's own leftover sweep uses `swarmz close` (`close_session`), and ending a scratch shell reveals nothing.

- [ ] **Step 1: Write the failing unit test** in the `#[cfg(test)]` module of `paths.rs` (create one at the end of the file if absent):

```rust
#[cfg(test)]
mod scratch_tests {
    use super::*;

    #[test]
    fn scratch_ids_are_recognised_and_valid_holder_ids() {
        let id = format!("{SCRATCH_PREFIX}0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
        assert!(is_scratch_id(&id));
        assert!(valid_tile_id(&id), "{id} must be usable as a holder id");
        assert!(!is_scratch_id("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"));
        assert!(!is_scratch_id("scratchpad"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test -p swarmz-tool scratch_ids_are_recognised`
Expected: FAIL to compile, `cannot find value SCRATCH_PREFIX`.

- [ ] **Step 3: Implement** in `paths.rs`, below `valid_tile_id`:

```rust
/// The id prefix of a tile's scratch shell (scratch terminal spec §2): a holder the user runs
/// beside an agent, never a tile, and never shown to agents.
pub const SCRATCH_PREFIX: &str = "scratch-";

pub fn is_scratch_id(id: &str) -> bool {
    id.starts_with(SCRATCH_PREFIX)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd src-tauri && cargo test -p swarmz-tool scratch_ids_are_recognised`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test** at the end of `src-tauri/tool/tests/cli.rs`:

```rust
#[test]
fn tile_commands_refuse_scratch_shells() {
    let h = home("scratchref");
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([{"id": "c1", "name": "api", "cwd": cwd, "origin": "mini"}]), serde_json::json!({}));
    let sid = "scratch-c1";
    // Not from a tile (the test itself may run inside one, and `close` checks the caller).
    const MINI: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];
    for args in [
        vec!["output", sid],
        vec!["pending", sid],
        vec!["send", sid, "--", "ls"],
        vec!["transcript", sid],
        vec!["info", sid],
        vec!["card", "--tile", sid],
    ] {
        let (code, v) = tool_env(&h.path, &args, MINI);
        assert_eq!((code, v["code"].as_str()), (1, Some("scratch")), "{args:?}: {v}");
    }
    // Ending one is still allowed (the app's own sweep uses it); nothing is running here.
    let (code, v) = tool_env(&h.path, &["close", sid], MINI);
    assert_eq!((code, v["closed"].as_bool()), (0, Some(false)), "{v}");
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli tile_commands_refuse_scratch_shells`
Expected: FAIL: the first command returns a code other than `scratch`.

- [ ] **Step 7: Implement.** At the top of `resolve_tile` in `commands.rs`, right after `let s = s.trim();`:

```rust
    // A scratch shell belongs to the user, not to any agent (scratch terminal spec §4).
    if crate::paths::is_scratch_id(s) {
        return Err(CliError::new("scratch", "a scratch shell is the user's; no command can read or drive it"));
    }
```

And in `main.rs`, in the `Some("info")` arm right after `let tile = tile_arg(&a)?;`:

```rust
            if swarmz_tool::paths::is_scratch_id(&tile) {
                return Err(CliError::new("scratch", "a scratch shell is the user's; no command can read or drive it"));
            }
```

- [ ] **Step 8: Run the tool tests**

Run: `cd src-tauri && cargo test -p swarmz-tool`
Expected: PASS (all, including the new ones).

- [ ] **Step 9: Commit**

```bash
git add src-tauri/tool/src/paths.rs src-tauri/tool/src/commands.rs src-tauri/tool/src/main.rs src-tauri/tool/tests/cli.rs
git commit -m "feat(tool): keep scratch shells out of agents' reach

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `swarmz scratch`, the briefing line and the pre-approved permission

**Files:**
- Create: `src-tauri/tool/src/scratch.rs`
- Modify: `src-tauri/tool/src/lib.rs` (add `pub mod scratch;`)
- Modify: `src-tauri/tool/src/commands.rs` (add `pub fn scratch`)
- Modify: `src-tauri/tool/src/main.rs` (add the `Some("scratch")` arm next to `Some("card")`)
- Modify: `src-tauri/tool/src/briefing.rs:7,11` (version 5 → 6, one paragraph)
- Modify: `src-tauri/src/agents.rs:24,37` (`AGENT_PERMISSIONS`, `CODEX_RULES`)
- Test: unit tests in `scratch.rs`; `src-tauri/tool/tests/cli.rs`

**Interfaces:**
- Consumes: `paths::is_scratch_id` (Task 1).
- Produces: event line `<at>\t<tile>\tScratch\t{"note":<string|null>,"command":<string|null>}` appended to `~/.swarmz/agents/events.log`; `swarmz_tool::scratch::{NOTE_MAX, COMMAND_MAX, check_text}`.

- [ ] **Step 1: Write the failing unit tests.** Create `src-tauri/tool/src/scratch.rs` with only the tests and stubs:

```rust
//! `swarmz scratch` (scratch terminal spec §4): an agent asks the app to open its tile's scratch
//! shell for the user, with an optional note and suggested command. It never sees the shell.

pub const NOTE_MAX: usize = 200;
pub const COMMAND_MAX: usize = 500;

/// Ok(None) for no text, Ok(Some) for acceptable text, Err(code) for `too_long` or `bad_text`.
pub fn check_text(_s: Option<&str>, _max: usize) -> Result<Option<String>, &'static str> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_one_line_within_its_limit() {
        assert_eq!(check_text(None, 10), Ok(None));
        assert_eq!(check_text(Some("  "), 10), Ok(None));
        assert_eq!(check_text(Some(" gh auth login "), 20), Ok(Some("gh auth login".into())));
        assert_eq!(check_text(Some(&"é".repeat(10)), 10), Ok(Some("é".repeat(10))));
        assert_eq!(check_text(Some(&"x".repeat(11)), 10), Err("too_long"));
        for bad in ["ls\nrm -rf ~", "ls\r", "a\tb", "\x1b[31m", "x\x7f"] {
            assert_eq!(check_text(Some(bad), 50), Err("bad_text"), "{bad:?}");
        }
    }
}
```

Add `pub mod scratch;` to `src-tauri/tool/src/lib.rs` beside the other `pub mod` lines.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test -p swarmz-tool text_is_one_line_within_its_limit`
Expected: FAIL (panics: `not implemented`).

- [ ] **Step 3: Implement `check_text`:**

```rust
pub fn check_text(s: Option<&str>, max: usize) -> Result<Option<String>, &'static str> {
    let Some(t) = s.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    // No control characters at all: a newline would press Enter in the user's shell.
    if t.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return Err("bad_text");
    }
    if t.chars().count() > max {
        return Err("too_long");
    }
    Ok(Some(t.to_string()))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test -p swarmz-tool text_is_one_line_within_its_limit`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test** at the end of `cli.rs`:

```rust
#[test]
fn scratch_asks_the_app_and_says_nothing_else() {
    let h = home("scratch");
    let env = |id: &'static str| -> Vec<(&'static str, &'static str)> { vec![("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", id)] };
    let (code, v) = tool_env(&h.path, &["scratch"], &env(""));
    assert_eq!((code, v["code"].as_str()), (1, Some("no_tile")), "{v}");
    let (code, v) = tool_env(&h.path, &["scratch"], &env("scratch-c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("self")), "{v}");
    let long = "x".repeat(201);
    let (code, v) = tool_env(&h.path, &["scratch", "--note", &long], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("too_long")), "{v}");
    let (code, v) = tool_env(&h.path, &["scratch", "--command", "ls\nrm -rf ~"], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("bad_text")), "{v}");
    // Nothing was logged for the refusals.
    assert!(!h.path.join(".swarmz/agents/events.log").exists());

    let (code, v) = tool_env(&h.path, &["scratch", "--note", "Please log in to GitHub", "--command", "gh auth login --web"], &env("c1"));
    assert_eq!(code, 0, "{v}");
    assert_eq!(v, serde_json::json!({"v": 1, "asked": true}));
    let log = std::fs::read_to_string(h.path.join(".swarmz/agents/events.log")).unwrap();
    let line = log.lines().last().unwrap();
    let parts: Vec<&str> = line.splitn(4, '\t').collect();
    assert_eq!((parts[1], parts[2]), ("c1", "Scratch"), "{line}");
    let payload: serde_json::Value = serde_json::from_str(parts[3]).unwrap();
    assert_eq!(payload, serde_json::json!({"note": "Please log in to GitHub", "command": "gh auth login --web"}));
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli scratch_asks_the_app`
Expected: FAIL: `unknown command` usage error instead of `no_tile`.

- [ ] **Step 7: Implement the command.** In `commands.rs`, after `pub fn card`:

```rust
/// `scratch [--note TEXT] [--command TEXT]` (scratch terminal spec §4): asks the app to open this
/// tile's scratch shell for the user. Says nothing about the shell, ever.
pub fn scratch(env: &Env, note: Option<&str>, command: Option<&str>) -> Result<Value, CliError> {
    let tile = match std::env::var("SWARMZ_TERMINAL_ID") {
        Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => return Err(CliError::new("no_tile", "swarmz scratch runs from an agent's tile: SWARMZ_TERMINAL_ID is not set")),
    };
    if crate::paths::is_scratch_id(&tile) {
        return Err(CliError::new("self", "this is already the scratch shell"));
    }
    if !crate::paths::valid_tile_id(&tile) {
        return Err(CliError::new("invalid", format!("invalid tile id {tile:?}")));
    }
    let bad = |field: &str, code: &'static str, max: usize| match code {
        "too_long" => CliError::new(code, format!("{field} is longer than {max} characters")),
        _ => CliError::new(code, format!("{field} must be one line with no control characters")),
    };
    let note = crate::scratch::check_text(note, crate::scratch::NOTE_MAX).map_err(|c| bad("--note", c, crate::scratch::NOTE_MAX))?;
    let command = crate::scratch::check_text(command, crate::scratch::COMMAND_MAX).map_err(|c| bad("--command", c, crate::scratch::COMMAND_MAX))?;
    let dir = env.home.join(".swarmz").join("agents");
    std::fs::create_dir_all(&dir).map_err(failed)?;
    let line = format!("{}\t{tile}\tScratch\t{}\n", now_iso_ms(), json!({"note": note, "command": command}));
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.log")).map_err(failed)?;
    std::io::Write::write_all(&mut f, line.as_bytes()).map_err(failed)?;
    Ok(json!({"v": 1, "asked": true}))
}
```

In `main.rs`, beside `Some("card")`:

```rust
        Some("scratch") => {
            a.expect_positional(1, "scratch [--note TEXT] [--command TEXT]")?;
            Ok(Some(cmd::scratch(&cmd::Env::from_process()?, a.opt("--note"), a.opt("--command"))?))
        }
```

If `Args::parse` rejects `--note`/`--command` as unknown flags, add both to the list of value-taking flags it knows (look at how `--recap` is declared in `Args::parse`, `main.rs:46-80`, and add the two names the same way).

- [ ] **Step 8: Run to verify it passes**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli scratch_asks_the_app`
Expected: PASS.

- [ ] **Step 9: Tell agents, and pre-approve the command.** In `briefing.rs` set `pub const BRIEFING_VERSION: u32 = 6;` and the header to `<!-- SWARMZ_BRIEFING_VERSION=6 -->`. Insert this paragraph just before the paragraph starting `One tile in the workspace is the conductor`:

```text
When you need the user to run something themselves (a login, a password, anything outside your sandbox or that you should not see), open a scratch shell for them in your tile with `~/.swarmz/bin/swarmz scratch --note "…" --command "…"`: a note (one line, at most 200 characters) and a suggested command (one line, at most 500) they can type with one click and run. You never see that shell or what it prints; ask the user how it went.
```

In `src-tauri/src/agents.rs` change line 24 to:

```rust
pub const AGENT_PERMISSIONS: [&str; 6] = ["Bash(~/.swarmz/bin/swarmz card:*)", "Bash(swarmz card:*)", "Bash(~/.swarmz/bin/swarmz board:*)", "Bash(swarmz board:*)", "Bash(~/.swarmz/bin/swarmz scratch:*)", "Bash(swarmz scratch:*)"];
```

and append to `CODEX_RULES` (before its closing `";`):

```rust
prefix_rule(pattern=[\"~/.swarmz/bin/swarmz\", \"scratch\"], decision=\"allow\")\n\
prefix_rule(pattern=[\"swarmz\", \"scratch\"], decision=\"allow\")\n";
```

(the previous last line loses its terminating `";` and gains `\` instead). Both are compared by content on install (`install_codex_in`, `install_hooks`), so existing machines pick them up on the next install.

- [ ] **Step 10: Run all Rust tests**

Run: `cd src-tauri && cargo test --workspace`
Expected: PASS. If a briefing test pins the old version number or text, update it to version 6.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/tool src-tauri/src/agents.rs
git commit -m "feat(tool): swarmz scratch lets an agent open the user's scratch shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The app reads `Scratch` events, and quitting ends scratch shells

**Files:**
- Modify: `src-tauri/src/agents.rs:473-520` (`AgentEvent`, `parse_line`)
- Modify: `src-tauri/src/commands.rs` (add `end_scratch_sessions`)
- Modify: `src-tauri/src/lib.rs:113-123` (`RunEvent::Exit`)
- Test: `src-tauri/src/agents.rs` tests module

**Interfaces:**
- Consumes: `swarmz_tool::paths::is_scratch_id` (Task 1); the log line from Task 2.
- Produces: `agent:event` payloads with `event: "Scratch"` carrying `note?: string`, `command?: string` (camelCase, omitted when absent).

- [ ] **Step 1: Write the failing test** in the `#[cfg(test)]` module of `agents.rs`:

```rust
    #[test]
    fn parses_a_scratch_request() {
        let e = parse_line("2026-10-10T10:00:00.000Z\tc1\tScratch\t{\"note\":\"Log in\",\"command\":\"gh auth login\"}").unwrap();
        assert_eq!((e.event.as_str(), e.note.as_deref(), e.command.as_deref()), ("Scratch", Some("Log in"), Some("gh auth login")));
        let bare = parse_line("2026-10-10T10:00:00.000Z\tc1\tScratch\t{\"note\":null,\"command\":null}").unwrap();
        assert_eq!((bare.note, bare.command), (None, None));
        // Other events never carry them, whatever their JSON says.
        let other = parse_line("2026-10-10T10:00:00.000Z\tc1\tStop\t{\"note\":\"x\",\"command\":\"y\"}").unwrap();
        assert_eq!((other.note, other.command), (None, None));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test -p swarmz parses_a_scratch_request`
Expected: FAIL to compile: no field `note`.

- [ ] **Step 3: Implement.** Add to `AgentEvent` after `board`:

```rust
    /// A `Scratch` request's note and suggested command (scratch terminal spec §4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
```

and in `parse_line`, after the `board:` line:

```rust
        note: if event == "Scratch" { s("note") } else { None },
        command: if event == "Scratch" { s("command") } else { None },
```

Fix any other `AgentEvent { … }` literals the compiler points at (tests) by adding `note: None, command: None`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test -p swarmz parses_a_scratch_request`
Expected: PASS.

- [ ] **Step 5: End scratch shells on quit.** In `commands.rs`, near `close_terminal`:

```rust
/// On quit (scratch terminal spec §2): scratch shells end with the app, while tiles only detach.
pub fn end_scratch_sessions(state: &AppState) {
    let ids: Vec<String> = state.sessions.lock().unwrap().keys().filter(|id| swarmz_tool::paths::is_scratch_id(id)).cloned().collect();
    for id in ids {
        state.registry.lock().unwrap().remove(&id);
        let session = state.sessions.lock().unwrap().remove(&id);
        if let Some((_, session)) = session {
            session.terminate();
        }
    }
}
```

(If `sessions` is not a map keyed by id, follow `close_terminal`'s access pattern: it calls `state.sessions.lock().unwrap().remove(&id)` and destructures `Some((_, session))`.)

In `lib.rs`, inside `if let tauri::RunEvent::Exit = event { if let Some(state) = … {`, before `state.sessions.lock().unwrap().clear();`:

```rust
                    commands::end_scratch_sessions(&state);
```

- [ ] **Step 6: Build and test**

Run: `cd src-tauri && cargo test --workspace`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat(core): deliver scratch requests, and end scratch shells on quit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pure frontend helpers: ids, the remote line, window geometry, liveness

**Files:**
- Create: `src/lib/scratch.ts`, `src/lib/scratch.test.ts`
- Modify: `src/lib/workspace.ts` (add `scratchSshLine` after `sshMasterLine`, ~line 293)
- Modify: `src/lib/workspace.test.ts` (or create `src/lib/scratchSshLine.test.ts` if `workspace.test.ts` does not exist)
- Modify: `src/lib/agentState.ts:16-31` (`AgentEvent` gains `note`, `command`)

**Interfaces:**
- Produces (`src/lib/scratch.ts`):
  - `SCRATCH_PREFIX = "scratch-"`, `isScratchId(id: string): boolean`, `scratchIdFor(tileId: string): string`, `scratchParent(id: string): string | null`
  - `interface ScratchRect { x: number; y: number; w: number; h: number }`
  - `interface ScratchRequest { note: string | null; command: string | null; agent: string; at: string }`
  - `interface ScratchState { started: boolean; open: boolean; rect: ScratchRect | null; request: ScratchRequest | null; focusToken: number; pulse: boolean; inHome: boolean; label: string }`
  - `MIN_W = 220`, `MIN_H = 120`, `defaultRect(bounds: { w: number; h: number }): ScratchRect`, `clampRect(r: ScratchRect, bounds: { w: number; h: number }): ScratchRect`
  - `SCRATCH_LIVE_MS = 30_000`, `scratchEventIsLive(ts: string, now: number, launchedAt: string): boolean`
  - `oneLine(s: string): string` (drops control characters)
- Produces (`workspace.ts`): `scratchSshLine(host: string, dir: string | null): string`

- [ ] **Step 1: Write the failing tests.** `src/lib/scratch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clampRect, defaultRect, isScratchId, MIN_H, MIN_W, oneLine, scratchEventIsLive, scratchIdFor, scratchParent, SCRATCH_LIVE_MS } from "./scratch";

describe("scratch ids", () => {
  it("round-trip between a tile and its scratch shell", () => {
    const id = scratchIdFor("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(id).toBe("scratch-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isScratchId(id)).toBe(true);
    expect(scratchParent(id)).toBe("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(isScratchId("t1")).toBe(false);
    expect(scratchParent("t1")).toBeNull();
  });
});

describe("window geometry", () => {
  it("starts bottom-right at about half the width and 40% of the height", () => {
    expect(defaultRect({ w: 1000, h: 600 })).toEqual({ x: 1000 - 500 - 12, y: 600 - 240 - 12, w: 500, h: 240 });
  });
  it("never smaller than the minimum, never outside the tile", () => {
    expect(clampRect({ x: -50, y: -10, w: 100, h: 50 }, { w: 800, h: 500 })).toEqual({ x: 0, y: 0, w: MIN_W, h: MIN_H });
    expect(clampRect({ x: 700, y: 450, w: 300, h: 200 }, { w: 800, h: 500 })).toEqual({ x: 500, y: 300, w: 300, h: 200 });
    // A tile smaller than the window: the window shrinks to the tile.
    expect(clampRect({ x: 0, y: 0, w: 400, h: 300 }, { w: 200, h: 100 })).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe("liveness", () => {
  const launched = "2026-10-10T10:00:00.000Z";
  const now = Date.parse("2026-10-10T10:05:00.000Z");
  it("only recent events after launch open a window", () => {
    expect(scratchEventIsLive("2026-10-10T10:04:59.000Z", now, launched)).toBe(true);
    expect(scratchEventIsLive(new Date(now - SCRATCH_LIVE_MS - 1).toISOString(), now, launched)).toBe(false);
    expect(scratchEventIsLive("2026-10-10T09:59:59.000Z", Date.parse("2026-10-10T10:00:01.000Z"), launched)).toBe(false);
    expect(scratchEventIsLive("garbage", now, launched)).toBe(false);
  });
});

describe("oneLine", () => {
  it("drops every control character", () => {
    expect(oneLine("gh auth login\r\n\x1b[31m\x7f")).toBe("gh auth login[31m");
  });
});
```

Add to the workspace tests:

```ts
import { scratchSshLine, sshLine } from "./workspace";

describe("scratchSshLine", () => {
  it("opens a login shell in the folder over the shared connection", () => {
    expect(scratchSshLine("me@box", "/srv/my app")).toBe(`${sshLine("me@box")} 'cd '\\''/srv/my app'\\'' && exec "$SHELL" -l'`);
  });
  it("survives a quote in the folder", () => {
    // The local shell unquotes this to the remote command: cd '/srv/it'\''s' && exec "$SHELL" -l
    expect(scratchSshLine("me@box", "/srv/it's")).toBe(`${sshLine("me@box")} 'cd '\\''/srv/it'\\''\\'\\'''\\''s'\\'' && exec "$SHELL" -l'`);
  });
  it("keeps ~ unquoted so it expands on the remote", () => {
    expect(scratchSshLine("me@box", "~/code")).toBe(`${sshLine("me@box")} 'cd ~/'\\''code'\\'' && exec "$SHELL" -l'`);
    expect(scratchSshLine("me@box", "~")).toBe(`${sshLine("me@box")} 'cd ~ && exec "$SHELL" -l'`);
  });
  it("with no folder, opens the remote home", () => {
    expect(scratchSshLine("me@box", null)).toBe(`${sshLine("me@box")} 'exec "$SHELL" -l'`);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/scratch.test.ts src/lib/workspace.test.ts`
Expected: FAIL: cannot resolve `./scratch`; `scratchSshLine` is not exported.

- [ ] **Step 3: Implement `src/lib/scratch.ts`:**

```ts
/** A tile's scratch shell (scratch terminal spec): a plain shell the user runs beside an agent,
 * kept out of the workspace and away from agents. */

export const SCRATCH_PREFIX = "scratch-";

export function isScratchId(id: string): boolean {
  return id.startsWith(SCRATCH_PREFIX);
}

export function scratchIdFor(tileId: string): string {
  return SCRATCH_PREFIX + tileId;
}

export function scratchParent(id: string): string | null {
  return isScratchId(id) ? id.slice(SCRATCH_PREFIX.length) : null;
}

/** Position and size in pixels, relative to the tile's pane. */
export interface ScratchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What an agent asked for with `swarmz scratch` (spec §4). */
export interface ScratchRequest {
  note: string | null;
  command: string | null;
  /** "Claude" or "Codex", for the banner. */
  agent: string;
  at: string;
}

export interface ScratchState {
  /** A holder is running for it. */
  started: boolean;
  /** The window is showing (hidden keeps the shell). */
  open: boolean;
  rect: ScratchRect | null;
  request: ScratchRequest | null;
  /** Bumped when the scratch shell should take the keyboard. */
  focusToken: number;
  /** An agent opened it while the user was elsewhere: the `>_` button pulses until it is seen. */
  pulse: boolean;
  /** The tile's folder was missing, so the shell started in the home folder. */
  inHome: boolean;
  /** `<folder>` or `<machine>:<folder>`, for the title bar. */
  label: string;
}

export const MIN_W = 220;
export const MIN_H = 120;
const MARGIN = 12;

export function defaultRect(bounds: { w: number; h: number }): ScratchRect {
  const w = Math.round(bounds.w / 2);
  const h = Math.round(bounds.h * 0.4);
  return clampRect({ x: bounds.w - w - MARGIN, y: bounds.h - h - MARGIN, w, h }, bounds);
}

export function clampRect(r: ScratchRect, bounds: { w: number; h: number }): ScratchRect {
  const w = Math.min(Math.max(r.w, MIN_W), bounds.w);
  const h = Math.min(Math.max(r.h, MIN_H), bounds.h);
  const x = Math.min(Math.max(r.x, 0), Math.max(bounds.w - w, 0));
  const y = Math.min(Math.max(r.y, 0), Math.max(bounds.h - h, 0));
  return { x, y, w, h };
}

export const SCRATCH_LIVE_MS = 30_000;

/** A `Scratch` event is acted on only when it is happening now: after this run started and
 * within `SCRATCH_LIVE_MS` of the clock (a little skew between Macs is fine). */
export function scratchEventIsLive(ts: string, now: number, launchedAt: string): boolean {
  const at = Date.parse(ts);
  if (Number.isNaN(at) || ts < launchedAt) return false;
  return Math.abs(now - at) <= SCRATCH_LIVE_MS;
}

/** Text safe to type at a prompt: no control characters, so never an Enter. */
export function oneLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}
```

In `workspace.ts`, after `sshMasterLine`:

```ts
/** The line a remote tile's scratch shell types (scratch terminal spec §3): a login shell in the
 * tile's folder on that Mac, over the shared master. `dir` is quoted for the remote shell, then
 * the whole remote command for this one; a leading `~` stays unquoted so it expands there. */
export function scratchSshLine(host: string, dir: string | null): string {
  let cd = "";
  if (dir === "~") cd = "cd ~ && ";
  else if (dir?.startsWith("~/")) cd = `cd ~/${shellQuote(dir.slice(2))} && `;
  else if (dir) cd = `cd ${shellQuote(dir)} && `;
  return `${sshLine(host)} ${shellQuote(`${cd}exec "$SHELL" -l`)}`;
}
```

In `agentState.ts`, add to `AgentEvent` after `board`:

```ts
  /** A `Scratch` request's note and suggested command (scratch terminal spec §4). */
  note?: string | null;
  command?: string | null;
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/scratch.test.ts src/lib/workspace.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scratch.ts src/lib/scratch.test.ts src/lib/workspace.ts src/lib/workspace.test.ts src/lib/agentState.ts
git commit -m "feat(ui): scratch shell ids, remote line and window geometry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Store: opening, hiding and ending a scratch shell

**Files:**
- Modify: `src/store.ts`: state type (near `outsideSessions`, ~line 537), initial state (~line 1739), new actions, `markExited` (~1892), `closeTerminal` (~1808), `refreshOutsideSessions` (~2135), `beforeSpawn` (~352)
- Modify: `src/lib/xtermRegistry.ts:628-632` (register `beforeSpawn.dispose`), `applyColor` (~line 586)
- Test: `src/store.test.ts` (new `describe("scratch shell")` block)

**Interfaces:**
- Consumes: everything from Task 4.
- Produces (store state and actions; later tasks and the UI rely on these exact names):
  - `scratch: Record<string, ScratchState>` (keyed by the agent tile id)
  - `openScratch(tileId: string, opts?: { focus?: boolean }): Promise<string | null>` (null on success, else a message such as `"Connect the tile first"`)
  - `hideScratch(tileId: string): void`
  - `endScratch(tileId: string): Promise<void>`
  - `setScratchRect(tileId: string, rect: ScratchRect): void`
  - `typeScratchCommand(tileId: string): void`
  - `dismissScratchRequest(tileId: string): void`
  - `beforeSpawn.dispose: (id: string) => void`

- [ ] **Step 1: Write the failing tests.** Add to `src/store.test.ts` (import `scratchIdFor` from `./lib/scratch` at the top):

```ts
describe("scratch shell", () => {
  const agentTile = async () => {
    const id = await useStore.getState().createTerminal("/tmp/proj");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: true } } } }));
    vi.mocked(ipc.createTerminal).mockClear();
    vi.mocked(ipc.saveWorkspace).mockClear();
    return id;
  };

  it("opens in the tile's folder and stays out of the workspace", async () => {
    const id = await agentTile();
    const before = useStore.getState();
    expect(await useStore.getState().openScratch(id)).toBeNull();
    expect(ipc.createTerminal).toHaveBeenCalledWith(scratchIdFor(id), "/tmp/proj", expect.any(Number), expect.any(Number), `${before.terminals[id].name}-scratch`);
    const s = useStore.getState();
    expect(s.terminals).toBe(before.terminals);
    expect(s.order).toBe(before.order);
    expect(s.settings).toBe(before.settings);
    expect(s.layout).toBe(before.layout);
    expect(s.scratch[id]).toMatchObject({ started: true, open: true, inHome: false, label: "/tmp/proj" });
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 10));
    expect(ipc.saveWorkspace).not.toHaveBeenCalled();
  });

  it("is only for agent tiles", async () => {
    const id = await useStore.getState().createTerminal("/tmp/plain");
    expect(await useStore.getState().openScratch(id)).not.toBeNull();
    expect(useStore.getState().scratch[id]).toBeUndefined();
  });

  it("two quick clicks start one shell", async () => {
    const id = await agentTile();
    await Promise.all([useStore.getState().openScratch(id), useStore.getState().openScratch(id)]);
    expect(ipc.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("hide keeps the shell; ✕, exit and closing the tile end it", async () => {
    const id = await agentTile();
    await useStore.getState().openScratch(id);
    useStore.getState().hideScratch(id);
    expect(useStore.getState().scratch[id]).toMatchObject({ started: true, open: false });
    expect(ipc.closeTerminal).not.toHaveBeenCalled();
    await useStore.getState().openScratch(id);
    expect(ipc.createTerminal).toHaveBeenCalledTimes(1);

    await useStore.getState().endScratch(id);
    expect(ipc.closeTerminal).toHaveBeenCalledWith(scratchIdFor(id));
    expect(useStore.getState().scratch[id]).toBeUndefined();

    await useStore.getState().openScratch(id);
    useStore.getState().markExited(scratchIdFor(id), 0);
    await vi.waitFor(() => expect(useStore.getState().scratch[id]).toBeUndefined());

    await useStore.getState().openScratch(id);
    vi.mocked(ipc.closeTerminal).mockClear();
    await useStore.getState().closeTerminal(id);
    expect(ipc.closeTerminal).toHaveBeenCalledWith(scratchIdFor(id));
    expect(useStore.getState().scratch[id]).toBeUndefined();
  });

  it("a tile closed while its scratch shell starts leaves no holder behind", async () => {
    const id = await agentTile();
    let release!: () => void;
    vi.mocked(ipc.createTerminal).mockImplementationOnce(
      (sid: string, cwd: string) => new Promise((r) => (release = () => r({ id: sid, name: "x", cwd, exited: null, error: null }))),
    );
    const opening = useStore.getState().openScratch(id);
    await useStore.getState().closeTerminal(id);
    release();
    await opening;
    expect(ipc.closeTerminal).toHaveBeenCalledWith(scratchIdFor(id));
    expect(useStore.getState().scratch[id]).toBeUndefined();
  });

  it("a missing folder opens in home and says so", async () => {
    const id = await agentTile();
    vi.mocked(ipc.createTerminal).mockRejectedValueOnce("/tmp/proj is not a directory");
    expect(await useStore.getState().openScratch(id)).toBeNull();
    expect(vi.mocked(ipc.createTerminal).mock.calls[1][1]).toBe("/home/me");
    expect(useStore.getState().scratch[id]).toMatchObject({ inHome: true, label: "~" });
  });

  it("an ssh tile types the remote line, and waits for its connection", async () => {
    const id = await agentTile();
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], ssh: { host: "me@box", cwd: "/srv/app", machine: "box" } } } }));
    expect(await useStore.getState().openScratch(id)).toBe("Connect the tile first");
    expect(ipc.createTerminal).not.toHaveBeenCalled();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    expect(await useStore.getState().openScratch(id)).toBeNull();
    expect(vi.mocked(ipc.createTerminal).mock.calls[0][1]).toBe("/home/me");
    expect(ipc.writeTerminal).toHaveBeenCalledWith(scratchIdFor(id), scratchSshLine("me@box", "/srv/app") + "\r");
    expect(useStore.getState().scratch[id].label).toBe("box:/srv/app");
  });

  it("leftover scratch holders are closed and never listed as outside sessions", async () => {
    vi.mocked(ipc.localSessions).mockResolvedValueOnce([
      { id: "scratch-gone", name: "x-scratch", running: true, pid: 1, startedAt: "2026-01-01T00:00:00Z", exitedAt: null, exitCode: null, known: false },
    ] as never);
    await useStore.getState().refreshOutsideSessions();
    expect(ipc.closeSession).toHaveBeenCalledWith("scratch-gone");
    expect(useStore.getState().outsideSessions).toEqual([]);
  });
});
```

Add `scratchSshLine` to the existing `./lib/workspace` import at the top of the test file. The suite runs on real timers by default (only some tests switch to fake ones), so the save check simply waits out `SAVE_DEBOUNCE_MS`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/store.test.ts -t "scratch shell"`
Expected: FAIL: `openScratch is not a function`.

- [ ] **Step 3: Implement.** In `store.ts`:

Imports at the top:

```ts
import { isScratchId, oneLine, scratchIdFor, scratchParent, type ScratchRect, type ScratchState } from "./lib/scratch";
```

and add `scratchSshLine` to the existing `./lib/workspace` import.

`beforeSpawn` type and default gain:

```ts
  /** Disposes a pane's xterm (the registry's `dispose`), for a scratch shell the store ends. */
  dispose: (id: string) => void;
```
```ts
  dispose: () => {},
```

State interface (next to `outsideSessions`):

```ts
  /** Each agent tile's scratch shell (scratch terminal spec); never saved. */
  scratch: Record<string, ScratchState>;
  openScratch(tileId: string, opts?: { focus?: boolean }): Promise<string | null>;
  hideScratch(tileId: string): void;
  endScratch(tileId: string): Promise<void>;
  setScratchRect(tileId: string, rect: ScratchRect): void;
  typeScratchCommand(tileId: string): void;
  dismissScratchRequest(tileId: string): void;
```

Module scope, near `joinedTiles`:

```ts
/** Scratch shells being started, so a second click does not start another. */
const scratchStarting = new Map<string, Promise<string | null>>();

function patchScratch(s: WorkbenchState, tileId: string, patch: Partial<ScratchState>): Partial<WorkbenchState> {
  const cur = s.scratch[tileId] ?? { started: false, open: false, rect: null, request: null, focusToken: 0, pulse: false, inHome: false, label: "" };
  return { scratch: { ...s.scratch, [tileId]: { ...cur, ...patch } } };
}
```

Initial state: `scratch: {},`.

Actions (after `closeOutsideSessions`):

```ts
  async openScratch(tileId, opts = {}) {
    const focus = opts.focus ?? true;
    const s = useStore.getState();
    const st = s.settings[tileId];
    const t = s.terminals[tileId];
    if (!t || !st?.claude?.enabled) return "Only an agent's tile has a scratch shell";
    const host = st.ssh?.host?.trim() || null;
    if (host && s.sshConnected[tileId] !== true) return "Connect the tile first";
    if (s.scratch[tileId]?.started) {
      set((x) => patchScratch(x, tileId, { open: true, pulse: false, focusToken: (x.scratch[tileId]?.focusToken ?? 0) + (focus ? 1 : 0) }));
      return null;
    }
    const inflight = scratchStarting.get(tileId);
    if (inflight) return inflight;
    const run = (async (): Promise<string | null> => {
      const id = scratchIdFor(tileId);
      await beforeSpawn.hook(id);
      const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
      const home = await homeDir();
      const folder = host ? home : t.cwd;
      const name = `${t.name}-scratch`;
      let inHome = false;
      try {
        await ipc.createTerminal(id, folder, dims.cols, dims.rows, name);
      } catch (e) {
        if (host || !String(e).includes("is not a directory")) {
          beforeSpawn.dispose(id);
          return typeof e === "string" ? e : String(e);
        }
        await ipc.createTerminal(id, home, dims.cols, dims.rows, name);
        inHome = true;
      }
      // The tile may have closed while the holder came up: end the shell rather than keep it.
      if (!useStore.getState().terminals[tileId]) {
        await ipc.closeTerminal(id).catch(() => {});
        beforeSpawn.dispose(id);
        return "The tile closed";
      }
      if (host) void ipc.writeTerminal(id, scratchSshLine(host, st.ssh?.cwd ?? null) + "\r").catch(() => {});
      const where = host ? (st.ssh?.cwd ?? "~") : inHome ? "~" : t.cwd;
      const label = host ? `${st.ssh?.machine ?? host}:${where}` : where;
      set((x) => patchScratch(x, tileId, { started: true, open: true, pulse: false, inHome, label, focusToken: (x.scratch[tileId]?.focusToken ?? 0) + (focus ? 1 : 0) }));
      return null;
    })();
    scratchStarting.set(tileId, run);
    try {
      return await run;
    } finally {
      scratchStarting.delete(tileId);
    }
  },

  hideScratch(tileId) {
    if (!useStore.getState().scratch[tileId]) return;
    set((x) => patchScratch(x, tileId, { open: false }));
  },

  async endScratch(tileId) {
    const id = scratchIdFor(tileId);
    const had = useStore.getState().scratch[tileId]?.started;
    set((x) => {
      if (!x.scratch[tileId]) return {};
      const scratch = { ...x.scratch };
      delete scratch[tileId];
      return { scratch };
    });
    if (had) await ipc.closeTerminal(id).catch(() => {});
    beforeSpawn.dispose(id);
  },

  setScratchRect(tileId, rect) {
    set((x) => patchScratch(x, tileId, { rect }));
  },

  typeScratchCommand(tileId) {
    const c = useStore.getState().scratch[tileId]?.request?.command;
    if (!c) return;
    // Typed, never submitted: the user reads it and presses Enter themselves.
    void ipc.writeTerminal(scratchIdFor(tileId), oneLine(c)).catch(() => {});
    set((x) => patchScratch(x, tileId, { focusToken: (x.scratch[tileId]?.focusToken ?? 0) + 1 }));
  },

  dismissScratchRequest(tileId) {
    if (!useStore.getState().scratch[tileId]) return;
    set((x) => patchScratch(x, tileId, { request: null }));
  },
```

`markExited` first line:

```ts
    const parent = scratchParent(id);
    if (parent) {
      void useStore.getState().endScratch(parent);
      return;
    }
```

`closeTerminal`, right after `stopPolling(id);` (a tile's scratch ends with it, including one still starting, which the check after `createTerminal` in `openScratch` catches):

```ts
    void useStore.getState().endScratch(id);
```

`refreshOutsideSessions`: replace the `ids` computation with:

```ts
    // A scratch holder nobody here owns is a leftover from a crash: end it (scratch terminal
    // spec §2). One this app shows is refused by the core, so the call is safe for every row.
    for (const r of rows) {
      if (r.running && isScratchId(r.id) && !s.scratch[scratchParent(r.id) ?? ""]?.started) void ipc.closeSession(r.id).catch(() => {});
    }
    const ids = rows
      .filter((r) => r.running && !r.known && !isScratchId(r.id) && !s.terminals[r.id] && r.startedAt !== null && Date.parse(r.startedAt) < settled)
      .map((r) => r.id);
```

In `xtermRegistry.ts` add after `beforeSpawn.pollCwd = …`:

```ts
beforeSpawn.dispose = dispose;
```

and in `applyColor` make a scratch pane take its tile's theme:

```ts
  const theme = tileTheme(useStore.getState(), scratchParent(id) ?? id);
```

(import `scratchParent` from `./scratch`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/store.test.ts -t "scratch shell" && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the whole frontend suite**

Run: `npm test`
Expected: PASS. Other test files that build a full `WorkbenchState` by hand may need `scratch: {}` added; mocks of `beforeSpawn` may need `dispose`.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/store.test.ts src/lib/xtermRegistry.ts
git commit -m "feat(ui): scratch shells in the store: open, hide, end, sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Store: agents' `Scratch` requests

**Files:**
- Modify: `src/store.ts` (`applyAgentEvent`, ~line 2715)
- Test: `src/store.test.ts` (inside `describe("scratch shell")`)

**Interfaces:**
- Consumes: `openScratch`, `scratch` state (Task 5); `scratchEventIsLive`, `ScratchRequest` (Task 4); `AgentEvent.note/command` (Task 4); `agentName` from `./lib/workspace`.
- Produces: `scratch[tileId].request` set from a live event; `pulse: true` when the tile is not the focused one.

- [ ] **Step 1: Write the failing tests** (inside the `scratch shell` describe; reuse `agentTile`):

```ts
  const scratchEvent = (terminal: string, ts: string, extra: Record<string, unknown> = {}) => ({
    host: null,
    event: { ts, terminal, event: "Scratch", sessionId: null, notificationType: null, source: null, cwd: null, permissionMode: null, note: "Log in to GitHub", command: "gh auth login --web", ...extra },
  });

  it("a live request opens the window with the banner; replayed history does not", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    useStore.setState({ focusedTerminalId: id, windowFocused: true });
    useStore.getState().applyAgentEvent(scratchEvent(id, new Date(Date.now() - 120_000).toISOString()));
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.createTerminal).not.toHaveBeenCalled();

    useStore.getState().applyAgentEvent(scratchEvent(id, new Date().toISOString()));
    await vi.waitFor(() => expect(useStore.getState().scratch[id]?.open).toBe(true));
    expect(useStore.getState().scratch[id].request).toMatchObject({ note: "Log in to GitHub", command: "gh auth login --web", agent: "Claude" });
    expect(useStore.getState().scratch[id].focusToken).toBeGreaterThan(0);
    expect(useStore.getState().scratch[id].pulse).toBe(false);
  });

  it("never takes the keyboard from another tile", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    useStore.setState({ focusedTerminalId: "someone-else", windowFocused: true });
    useStore.getState().applyAgentEvent(scratchEvent(id, new Date().toISOString()));
    await vi.waitFor(() => expect(useStore.getState().scratch[id]?.open).toBe(true));
    expect(useStore.getState().scratch[id]).toMatchObject({ focusToken: 0, pulse: true });
  });

  it("a burst of the same request opens one shell", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    const ts = new Date().toISOString();
    for (let i = 0; i < 3; i++) useStore.getState().applyAgentEvent(scratchEvent(id, ts));
    await vi.waitFor(() => expect(useStore.getState().scratch[id]?.open).toBe(true));
    expect(ipc.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("Type it types the command without Enter", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    useStore.getState().applyAgentEvent(scratchEvent(id, new Date().toISOString()));
    await vi.waitFor(() => expect(useStore.getState().scratch[id]?.request).not.toBeNull());
    vi.mocked(ipc.writeTerminal).mockClear();
    useStore.getState().typeScratchCommand(id);
    expect(ipc.writeTerminal).toHaveBeenCalledWith(scratchIdFor(id), "gh auth login --web");
    const typed = vi.mocked(ipc.writeTerminal).mock.calls.map((c) => c[1]).join("");
    expect(typed).not.toMatch(/[\r\n]/);
  });

  it("a request for a disconnected remote tile waits for the next open", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], ssh: { host: "me@box", cwd: "/srv/app", machine: "box" } } } }));
    useStore.getState().applyAgentEvent({ ...scratchEvent(id, new Date().toISOString()), host: "me@box" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.createTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().scratch[id]).toMatchObject({ started: false, open: false, pulse: true });
    expect(useStore.getState().scratch[id].request?.command).toBe("gh auth login --web");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().openScratch(id);
    expect(useStore.getState().scratch[id].request?.command).toBe("gh auth login --web");
  });

  it("a request from the wrong Mac is ignored", async () => {
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    const id = await agentTile();
    useStore.getState().applyAgentEvent({ ...scratchEvent(id, new Date().toISOString()), host: "me@elsewhere" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().scratch[id]).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/store.test.ts -t "scratch shell"`
Expected: the new tests FAIL (no window opens).

- [ ] **Step 3: Implement.** Module scope near `scratchStarting`:

```ts
/** `Scratch` events already acted on (host|tile|ts): the remote tail re-sends its backlog after
 * every reconnect, and an agent may retry. */
const seenScratch = new Set<string>();
```

Import `scratchEventIsLive` and `type ScratchRequest` from `./lib/scratch`, and `agentName` from `./lib/workspace` if not imported yet.

At the very top of `applyAgentEvent`, after `agentWatchSurvived(host);`:

```ts
    if (event.event === "Scratch") {
      handleScratchRequest(payload);
      return;
    }
```

Module-level function (below `patchScratch`):

```ts
/** An agent asked for its tile's scratch shell (scratch terminal spec §4). */
function handleScratchRequest({ host, event }: AgentEventPayload): void {
  if (!scratchEventIsLive(event.ts, Date.now(), APP_LAUNCHED_AT)) return;
  const key = `${host ?? ""}|${event.terminal}|${event.ts}`;
  if (seenScratch.has(key)) return;
  seenScratch.add(key);
  const s = useStore.getState();
  const tileId = event.terminal;
  const settings = s.settings[tileId];
  if (!s.terminals[tileId] || !settings?.claude?.enabled) return;
  // Same rule as every hook event: a log only speaks for the Mac it lives on.
  if (host === null ? settings.ssh != null : settings.ssh?.host?.trim() !== host) return;
  const request: ScratchRequest = { note: event.note ?? null, command: event.command ?? null, agent: agentName(settings.claude), at: event.ts };
  const here = s.windowFocused !== false && s.focusedTerminalId === tileId;
  useStore.setState((x) => patchScratch(x, tileId, { request, pulse: !here }));
  void useStore.getState().openScratch(tileId, { focus: here }).then((err) => {
    // Not connected yet: the request waits in the map for the next open.
    if (err && !useStore.getState().scratch[tileId]?.started) useStore.setState((x) => patchScratch(x, tileId, { open: false }));
  });
}
```

`openScratch` must keep an existing `request` (it does: `patchScratch` merges). Make `openScratch` clear `pulse` only when `focus` is true: in both `set` calls in `openScratch` replace `pulse: false` with `...(focus ? { pulse: false } : {})`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/store.test.ts -t "scratch shell" && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): agents can open the scratch shell for the user

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The `>_` button and the floating window

**Files:**
- Create: `src/components/ScratchWindow.tsx`, `src/components/ScratchWindow.test.tsx`
- Modify: `src/components/TerminalPane.tsx` (render `<ScratchWindow tileId={id} />` inside the `relative flex-1` box, after the message-jump buttons)
- Modify: `src/components/TabGroup.tsx:286-327` (button before the zoom button)
- Modify: `src/components/TabGroup.test.tsx` (button tests)

**Interfaces:**
- Consumes: store `scratch`, `openScratch`, `hideScratch`, `endScratch`, `setScratchRect`, `typeScratchCommand`, `dismissScratchRequest` (Tasks 5–6); `defaultRect`, `clampRect`, `scratchIdFor` (Task 4); `attach`, `fitAndFocus` from `../lib/xtermRegistry`.
- Produces: `ScratchWindow({ tileId }: { tileId: string })`; test ids `scratch-window`, `scratch-mount`, `scratch-toggle`.

- [ ] **Step 1: Write the failing component tests.** `src/components/ScratchWindow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ ipc: { writeTerminal: vi.fn(async () => {}), closeTerminal: vi.fn(async () => {}), resizeTerminal: vi.fn(async () => {}) } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../lib/xtermRegistry", () => ({ attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })), fitAndFocus: vi.fn() }));

import { useStore } from "../store";
import { ScratchWindow } from "./ScratchWindow";
import { attach, fitAndFocus } from "../lib/xtermRegistry";

const ID = "t1";
class FakeResizeObserver { observe() {} disconnect() {} }
const base = { started: true, open: true, rect: null, request: null, focusToken: 1, pulse: false, inHome: false, label: "/tmp/proj" };

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  useStore.setState({ scratch: { [ID]: base } });
});
afterEach(() => cleanup());

describe("ScratchWindow", () => {
  it("mounts the scratch xterm and takes the keyboard when asked", () => {
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByTestId("scratch-window").textContent).toContain("scratch · /tmp/proj");
    expect(attach).toHaveBeenCalledWith("scratch-t1", screen.getByTestId("scratch-mount"));
    expect(fitAndFocus).toHaveBeenCalledWith("scratch-t1");
  });

  it("renders nothing while hidden", () => {
    useStore.setState({ scratch: { [ID]: { ...base, open: false } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.queryByTestId("scratch-window")).toBeNull();
  });

  it("– hides, ✕ ends", () => {
    const hide = vi.fn();
    const end = vi.fn(async () => {});
    useStore.setState({ hideScratch: hide, endScratch: end });
    render(<ScratchWindow tileId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide scratch shell" }));
    expect(hide).toHaveBeenCalledWith(ID);
    fireEvent.click(screen.getByRole("button", { name: "End scratch shell" }));
    expect(end).toHaveBeenCalledWith(ID);
  });

  it("shows an agent's request with Type it", () => {
    const type = vi.fn();
    useStore.setState({ typeScratchCommand: type, scratch: { [ID]: { ...base, request: { note: "Log in to GitHub", command: "gh auth login --web", agent: "Claude", at: "t" } } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByText(/Claude asks:/).textContent).toContain("Log in to GitHub");
    expect(screen.getByText("gh auth login --web")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Type it" }));
    expect(type).toHaveBeenCalledWith(ID);
  });

  it("says when it opened in the home folder", () => {
    useStore.setState({ scratch: { [ID]: { ...base, inHome: true, label: "~" } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByTestId("scratch-window").textContent).toContain("folder missing, opened in ~");
  });
});
```

Add to `TabGroup.test.tsx` (inside a new `describe("scratch button")`):

```tsx
describe("scratch button", () => {
  it("shows on agent tiles only, and opens the scratch shell", () => {
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    expect(screen.queryByTestId("scratch-toggle")).toBeNull();
    cleanup();
    const open = vi.fn(async () => null);
    useStore.setState({ openScratch: open, settings: { [ID]: { ssh: null, claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true }, command: null, extra: {} } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    fireEvent.click(screen.getByTestId("scratch-toggle"));
    expect(open).toHaveBeenCalledWith(ID);
  });

  it("is greyed out on a disconnected ssh tile", () => {
    useStore.setState({ sshConnected: {}, settings: { [ID]: { ssh: { host: "me@box", cwd: "/srv" }, claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true }, command: null, extra: {} } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    const b = screen.getByTestId("scratch-toggle") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe("Connect the tile first");
  });

  it("hides an open window, and pulses after an agent asked", () => {
    const hide = vi.fn();
    useStore.setState({
      hideScratch: hide,
      settings: { [ID]: { ssh: null, claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true }, command: null, extra: {} } },
      scratch: { [ID]: { started: true, open: true, rect: null, request: null, focusToken: 0, pulse: true, inHome: false, label: "/home/me" } },
    });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    const b = screen.getByTestId("scratch-toggle");
    expect(b.className).toContain("animate-pulse");
    fireEvent.click(b);
    expect(hide).toHaveBeenCalledWith(ID);
  });
});
```

Also add `scratch: {}` and `sshConnected: {}` to that file's `beforeEach` `setState`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/ScratchWindow.test.tsx src/components/TabGroup.test.tsx`
Expected: FAIL: cannot resolve `./ScratchWindow`; no `scratch-toggle`.

- [ ] **Step 3: Implement `src/components/ScratchWindow.tsx`:**

```tsx
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";
import { clampRect, defaultRect, scratchIdFor, type ScratchRect } from "../lib/scratch";

/** A tile's scratch shell, floating over the agent's output (scratch terminal spec §1). */
export function ScratchWindow({ tileId }: { tileId: string }) {
  const st = useStore((s) => s.scratch[tileId]);
  const hide = useStore((s) => s.hideScratch);
  const end = useStore((s) => s.endScratch);
  const setRect = useStore((s) => s.setScratchRect);
  const typeIt = useStore((s) => s.typeScratchCommand);
  const dismiss = useStore((s) => s.dismissScratchRequest);
  const box = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0 });
  const id = scratchIdFor(tileId);
  const visible = !!st?.started && st.open;

  // The pane this window floats in is its offset parent: watch its size.
  useEffect(() => {
    const pane = box.current?.parentElement;
    if (!pane) return;
    const measure = () => setBounds({ w: pane.clientWidth, h: pane.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => {
    const el = mount.current;
    if (!visible || !el) return;
    const { fit } = attach(id, el);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, id]);

  useEffect(() => {
    if (visible && st && st.focusToken > 0) fitAndFocus(id);
  }, [visible, st?.focusToken, id]);

  if (!visible || !st) return <div ref={box} hidden />;
  const rect: ScratchRect = bounds.w > 0 ? clampRect(st.rect ?? defaultRect(bounds), bounds) : { x: 0, y: 0, w: 0, h: 0 };

  // Drag by the title bar (move) or the corner (resize), kept inside the tile.
  const drag = (mode: "move" | "size") => (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r: rect };
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      const next = mode === "move" ? { ...start.r, x: start.r.x + dx, y: start.r.y + dy } : { ...start.r, w: start.r.w + dx, h: start.r.h + dy };
      setRect(tileId, clampRect(next, bounds));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const iconButton = "rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100";
  return (
    <div ref={box}>
      <div
        data-testid="scratch-window"
        className="absolute z-30 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-neutral-950 shadow-2xl"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300" onPointerDown={drag("move")}>
          <span className="min-w-0 flex-1 truncate font-mono" title={st.label}>{`scratch · ${st.label}`}{st.inHome ? " (folder missing, opened in ~)" : ""}</span>
          <button type="button" className={iconButton} aria-label="Hide scratch shell" title="Hide (keeps the shell)" onPointerDown={(e) => e.stopPropagation()} onClick={() => hide(tileId)}>–</button>
          <button type="button" className={`${iconButton} hover:text-exited`} aria-label="End scratch shell" title="End the shell" onPointerDown={(e) => e.stopPropagation()} onClick={() => void end(tileId)}>✕</button>
        </div>
        {st.request && (
          <div className="flex shrink-0 flex-col gap-1 border-b border-neutral-700 bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-300">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium text-neutral-100">{st.request.agent} asks:</span> {st.request.note ?? ""}
              </span>
              <button type="button" className={iconButton} aria-label="Dismiss request" onClick={() => dismiss(tileId)}>✕</button>
            </div>
            {st.request.command && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-neutral-950 px-1.5 py-0.5 font-mono text-neutral-200" title={st.request.command}>{st.request.command}</code>
                <button type="button" className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => typeIt(tileId)}>Type it</button>
              </div>
            )}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div ref={mount} data-testid="scratch-mount" className="absolute inset-0 overflow-hidden" />
        </div>
        <div className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" onPointerDown={drag("size")} aria-hidden="true" />
      </div>
    </div>
  );
}
```

In `TerminalPane.tsx` import `ScratchWindow` and render it as the last child of the `group/pane relative` box (after the exit bar block):

```tsx
      {settings.claude?.enabled && <ScratchWindow tileId={id} />}
```

Clicking the agent's output gives it the keyboard already (xterm focuses on click), which leaves the scratch window open, as the spec says.

In `TabGroup.tsx`, read the active tile's scratch state with primitive selectors near the other `useStore` calls in `TabGroup`:

```tsx
  const activeId = group.active;
  const isAgent = useStore((s) => !!activeId && s.settings[activeId]?.claude?.enabled === true);
  const remote = useStore((s) => !!activeId && !!s.settings[activeId]?.ssh?.host);
  const connected = useStore((s) => !!activeId && s.sshConnected[activeId] === true);
  const scratchOpen = useStore((s) => !!activeId && s.scratch[activeId]?.open === true && s.scratch[activeId]?.started === true);
  const scratchRunning = useStore((s) => !!activeId && s.scratch[activeId]?.started === true);
  const scratchPulse = useStore((s) => !!activeId && s.scratch[activeId]?.pulse === true);
  const openScratch = useStore((s) => s.openScratch);
  const hideScratch = useStore((s) => s.hideScratch);
```

(If `group.active` can be `null`/empty for an empty slot, keep the `!!activeId` guards.) Then, immediately before the zoom button:

```tsx
          {isAgent && (
            <button
              type="button"
              data-testid="scratch-toggle"
              className={`rounded px-1.5 font-mono text-xs hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40 ${scratchRunning ? "text-link" : "text-neutral-500"} ${scratchPulse ? "animate-pulse" : ""}`}
              disabled={remote && !connected}
              title={remote && !connected ? "Connect the tile first" : scratchOpen ? "Hide the scratch shell" : "Scratch shell: a plain terminal here, outside the agent"}
              aria-label="Scratch shell"
              aria-pressed={scratchOpen}
              onClick={() => (scratchOpen ? hideScratch(activeId) : void openScratch(activeId))}
            >
              &gt;_
            </button>
          )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/ScratchWindow.test.tsx src/components/TabGroup.test.tsx src/components/TerminalPane.test.tsx && npm run typecheck`
Expected: PASS. `TerminalPane.test.tsx` may need `scratch: {}` in its store setup.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && (cd src-tauri && cargo test --workspace)`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components
git commit -m "feat(ui): the scratch button and floating scratch window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Try it in the real app

**Files:** none changed unless a defect turns up (fix it test-first in the owning task's files, then commit as `fix(ui): …`).

- [ ] **Step 1: Launch** with `npm run tauri dev` (never `tauri build`).
- [ ] **Step 2: Local Claude tile.** Click `>_`: the window opens bottom-right in the tile's folder (`pwd`), and the keyboard is in it. Drag it, resize it, hide with –, show again (history kept), ✕ ends it. Type `exit`: the window closes. Switch tabs and back: it follows its tile.
- [ ] **Step 3: Agent request.** From the agent (or a shell in the tile), run `~/.swarmz/bin/swarmz scratch --note "Log in to GitHub" --command "gh auth status"`: the window opens with the banner; Type it puts the command at the prompt with no Enter. With another tile focused, the window opens without taking the keyboard, and `>_` pulses.
- [ ] **Step 4: Hidden from agents.** `~/.swarmz/bin/swarmz output scratch-<tile id>` gives code `scratch`; `swarmz ls` does not list it.
- [ ] **Step 5: ssh tile** to another Mac: `>_` is greyed while disconnected; once connected, the scratch shell lands on that Mac in the tile's folder without a second login.
- [ ] **Step 6: Quit** swarmz with a scratch shell open and relaunch: `ls ~/.swarmz/sessions | grep scratch-` shows nothing running, and nothing is listed as an outside session.
- [ ] **Step 7:** Update `CLAUDE.md` with a short "Scratch shells" paragraph (ids, not in the store, `swarmz scratch`, quit and launch sweep), and commit as `docs: scratch shells in CLAUDE.md`.
