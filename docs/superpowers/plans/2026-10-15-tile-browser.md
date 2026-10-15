# Tile Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in browser that floats over a Claude or Codex tile, opened by a 🌐 button or by the agent with `swarmz browse --url … --note …`.

**Architecture:** The page is a native WebKit child webview (`browse-<tile>`) that the Rust core adds to the swarmz window showing the tile (Tauri `unstable` multi-webview) and moves, resizes, shows and hides over an empty box in a React frame (`BrowserWindow`). The store keeps each tile's browser state (open, address, title, request, pulse) like `scratch`; the frame alone talks to the core about placement, because only the window showing the tile knows the box's rectangle. Agent requests travel as `Browse` lines in `events.log`, exactly like `Scratch`.

**Tech Stack:** Tauri 2.11 (`unstable` feature: `Window::add_child`, `Webview::reparent`), Rust, React 19, zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-tile-browser-design.md`

## Global Constraints

- Only `http:` and `https:` load (plus the blank start page `about:blank`); anything else is refused.
- The view has no Tauri capabilities and no IPC; capabilities name webviews `main` and `win-*` only.
- The view presents itself as Safari: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15`.
- `swarmz browse`: address at most 2000 characters, note at most 200; errors `no_tile`, `invalid`, `too_long`, `bad_text`; reply exactly `{"v":1,"asked":true}`.
- A `Browse` event is acted on only when live: `ts` at or after launch and within 30 s of now (`scratchEventIsLive`), deduped by `host|tile|ts`.
- Nothing about the browser is saved, synced, shown to the phone or conductors, or listed by the tool.
- The browser always runs on this Mac, also for tiles that run on another Mac.
- Never build or bundle the desktop app locally; `cargo build`/`cargo test` of the crates is fine.

## Review Focus

1. A tile closed (or its agent turned off) while its view is being created: the view must not survive. Pinned by the per-tile call queue test in Task 4 and the close tests in Task 5.
2. A request arriving while the user reads another page: the page must not change under them. Pinned in Task 5 ("Go there" test).
3. Typed address-bar text: `localhost:1420`, `192.168.1.4:8080/x`, `example.com`, `file:///etc/passwd`, `what is swarmz`. Pinned by `addressFor` tests in Task 4.
4. A menu or panel opened over a showing page: the page must hide so the menu is usable. Pinned by the `useBlocksBrowsers` test in Task 4 and the BrowserWindow test in Task 6.
5. The tool receiving a newline, a `javascript:` address or a 2001-character address: refused, nothing logged. Pinned in Task 1.

## Rulings made while planning (deviations from the spec, for the user)

- **Load failures.** wry reports no navigation failure, so the error strip appears when a load has started and not finished after 25 s ("This page hasn't finished loading"), with Retry and Open in Safari. A view the core cannot create shows its error the same way.
- **Sign-in popups** open as a small separate swarmz window (Tauri's `NewWindowResponse::Create` needs a window, not a child view), not as a sheet inside the frame.
- **Moving a tile to another window** keeps the page (`Webview::reparent`), better than the spec's reload.
- **Quitting** needs no code: child views die with the app.

---

### Task 1: `swarmz browse` in the tool

**Files:**
- Create: `src-tauri/tool/src/browse.rs`
- Modify: `src-tauri/tool/src/lib.rs` (add `pub mod browse;`)
- Modify: `src-tauri/tool/src/commands.rs` (new `browse` beside `scratch`)
- Modify: `src-tauri/tool/src/main.rs` (VALUED gains `"--url"`, a `Some("browse")` arm, usage string)
- Modify: `src-tauri/tool/src/briefing.rs` (version 7, one paragraph)
- Test: `src-tauri/tool/tests/cli.rs`

**Interfaces:**
- Produces: `browse::URL_MAX: usize = 2000`, `browse::NOTE_MAX: usize = 200`, `browse::check_url(&str) -> Result<String, &'static str>`, `commands::browse(env, url: Option<&str>, note: Option<&str>) -> Result<Value, CliError>`; log line `{ts}\t{tile}\tBrowse\t{"url":…,"note":…}`.

- [ ] **Step 1: Write the failing unit test** in `src-tauri/tool/src/browse.rs`:

```rust
//! `swarmz browse` (tile browser spec §4): an agent asks the app to open its tile's browser on an
//! address, with an optional note. It never sees the page.

pub const URL_MAX: usize = 2000;
pub const NOTE_MAX: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_pass() {
        assert_eq!(check_url(" https://appstoreconnect.apple.com/apps "), Ok("https://appstoreconnect.apple.com/apps".into()));
        assert_eq!(check_url("http://localhost:1420/"), Ok("http://localhost:1420/".into()));
        assert_eq!(check_url("HTTPS://Example.com"), Ok("HTTPS://Example.com".into()));
        for bad in ["", "example.com", "javascript:alert(1)", "file:///etc/passwd", "https://", "https:///x", "https://a b", "https://a\nb", "ftp://x"] {
            assert_eq!(check_url(bad), Err("invalid"), "{bad:?}");
        }
        let long = format!("https://x.com/{}", "a".repeat(URL_MAX));
        assert_eq!(check_url(&long), Err("too_long"));
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test -p swarmz-tool browse::`
Expected: compile error, `check_url` not found (also add `pub mod browse;` to `tool/src/lib.rs` first so the module is compiled).

- [ ] **Step 3: Implement `check_url`** above the tests:

```rust
/// The trimmed address when it is an `http`/`https` URL with a host, no spaces or control
/// characters, within `URL_MAX`; Err(`invalid` | `too_long`) otherwise.
pub fn check_url(s: &str) -> Result<String, &'static str> {
    let t = s.trim();
    if t.chars().count() > URL_MAX {
        return Err("too_long");
    }
    if t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid");
    }
    let lower = t.to_ascii_lowercase();
    let rest = ["https://", "http://"].iter().find_map(|p| lower.strip_prefix(p)).ok_or("invalid")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("invalid");
    }
    Ok(t.to_string())
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd src-tauri && cargo test -p swarmz-tool browse::`
Expected: PASS (1 test).

- [ ] **Step 5: Write the failing CLI test** at the end of `src-tauri/tool/tests/cli.rs`:

```rust
#[test]
fn browse_asks_the_app_and_says_nothing_else() {
    let h = home("browse");
    let env = |id: &'static str| -> Vec<(&'static str, &'static str)> { vec![("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", id)] };
    let (code, v) = tool_env(&h.path, &["browse", "--url", "https://example.com"], &env(""));
    assert_eq!((code, v["code"].as_str()), (1, Some("no_tile")), "{v}");
    let (code, v) = tool_env(&h.path, &["browse", "--url", "https://example.com"], &env("scratch-c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("no_tile")), "{v}");
    let (code, v) = tool_env(&h.path, &["browse"], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("invalid")), "{v}");
    let (code, v) = tool_env(&h.path, &["browse", "--url", "javascript:alert(1)"], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("invalid")), "{v}");
    let long = format!("https://x.com/{}", "a".repeat(2000));
    let (code, v) = tool_env(&h.path, &["browse", "--url", &long], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("too_long")), "{v}");
    let (code, v) = tool_env(&h.path, &["browse", "--url", "https://example.com", "--note", "a\nb"], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("bad_text")), "{v}");
    let note = "x".repeat(201);
    let (code, v) = tool_env(&h.path, &["browse", "--url", "https://example.com", "--note", &note], &env("c1"));
    assert_eq!((code, v["code"].as_str()), (1, Some("too_long")), "{v}");
    assert!(!h.path.join(".swarmz/agents/events.log").exists(), "refusals log nothing");

    let (code, v) = tool_env(&h.path, &["browse", "--url", "https://appstoreconnect.apple.com/apps", "--note", "Create the app: Apps → + → New App"], &env("c1"));
    assert_eq!(code, 0, "{v}");
    assert_eq!(v, serde_json::json!({"v": 1, "asked": true}));
    let log = std::fs::read_to_string(h.path.join(".swarmz/agents/events.log")).unwrap();
    let parts: Vec<&str> = log.lines().last().unwrap().splitn(4, '\t').collect();
    assert_eq!((parts[1], parts[2]), ("c1", "Browse"));
    let payload: serde_json::Value = serde_json::from_str(parts[3]).unwrap();
    assert_eq!(payload, serde_json::json!({"url": "https://appstoreconnect.apple.com/apps", "note": "Create the app: Apps → + → New App"}));
}
```

- [ ] **Step 6: Run it to see it fail**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli browse_asks`
Expected: FAIL, the reply's code is `usage` (unknown subcommand).

- [ ] **Step 7: Implement the command.** In `tool/src/commands.rs`, after `scratch`:

```rust
/// `browse --url URL [--note TEXT]` (tile browser spec §4): asks the app to open this tile's
/// browser on an address for the user. Says nothing about the page, ever.
pub fn browse(env: &Env, url: Option<&str>, note: Option<&str>) -> Result<Value, CliError> {
    let tile = match std::env::var("SWARMZ_TERMINAL_ID") {
        Ok(t) if !t.trim().is_empty() && !crate::paths::is_scratch_id(t.trim()) => t.trim().to_string(),
        _ => return Err(CliError::new("no_tile", "swarmz browse runs from an agent's tile: SWARMZ_TERMINAL_ID is not set")),
    };
    if !valid_tile_id(&tile) {
        return Err(CliError::new("invalid", format!("invalid tile id {tile:?}")));
    }
    let url = crate::browse::check_url(url.unwrap_or("")).map_err(|c| match c {
        "too_long" => CliError::new(c, format!("--url is longer than {} characters", crate::browse::URL_MAX)),
        _ => CliError::new(c, "--url must be an http or https address with no spaces"),
    })?;
    let note = crate::scratch::check_text(note, crate::browse::NOTE_MAX).map_err(|c| match c {
        "too_long" => CliError::new(c, format!("--note is longer than {} characters", crate::browse::NOTE_MAX)),
        _ => CliError::new(c, "--note must be one line with no control characters"),
    })?;
    let dir = env.home.join(".swarmz").join("agents");
    std::fs::create_dir_all(&dir).map_err(failed)?;
    let line = format!("{}\t{tile}\tBrowse\t{}\n", now_iso_ms(), json!({"url": url, "note": note}));
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.log")).map_err(failed)?;
    std::io::Write::write_all(&mut f, line.as_bytes()).map_err(failed)?;
    Ok(json!({"v": 1, "asked": true}))
}
```

In `tool/src/main.rs`: append `"--url"` to `VALUED`; add beside the `scratch` arm:

```rust
        Some("browse") => {
            a.expect_positional(1, "browse --url URL [--note TEXT]")?;
            Ok(Some(cmd::browse(&cmd::Env::from_process()?, a.opt("--url"), a.opt("--note"))?))
        }
```

and add `browse` after `scratch` in the usage string (`…|card|scratch|browse|upload|…`).

- [ ] **Step 8: Run it to see it pass**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli browse_asks`
Expected: PASS.

- [ ] **Step 9: Brief the agents.** In `tool/src/briefing.rs` set `BRIEFING_VERSION` to 7 and the first line to `<!-- SWARMZ_BRIEFING_VERSION=7 -->`, and add after the scratch paragraph:

```text
When the user needs to do something on a web page (sign in, create something in a dashboard, approve an app), open it beside your tile with `~/.swarmz/bin/swarmz browse --url "https://…" --note "…"`: the address and a one-line note (at most 200 characters) saying what to do there. You never see the page; ask the user how it went.
```

Run: `cd src-tauri && cargo test -p swarmz-tool`
Expected: PASS (any test asserting the version 6 string is updated to 7 in the same step).

- [ ] **Step 10: Commit**

```bash
git add src-tauri/tool
git commit -m "feat(tool): swarmz browse asks the app to open a tile's browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `Browse` events and permissions in the core

**Files:**
- Modify: `src-tauri/src/agents.rs` (`AgentEvent.url`, `parse_line`, `AGENT_PERMISSIONS`, `CODEX_RULES`, tests)

**Interfaces:**
- Consumes: the `Browse` line from Task 1.
- Produces: `agent:event` payloads whose `event` has `url` and `note` when `event == "Browse"`.

- [ ] **Step 1: Write the failing test** in `agents.rs` tests, beside `parses_a_scratch_request`:

```rust
    #[test]
    fn parses_a_browse_request() {
        let e = parse_line("2026-10-15T10:00:00.000Z\tc1\tBrowse\t{\"url\":\"https://example.com\",\"note\":\"Sign in\"}").unwrap();
        assert_eq!((e.event.as_str(), e.url.as_deref(), e.note.as_deref()), ("Browse", Some("https://example.com"), Some("Sign in")));
        assert_eq!(e.command, None);
        let other = parse_line("2026-10-15T10:00:00.000Z\tc1\tStop\t{\"url\":\"https://x\"}").unwrap();
        assert_eq!(other.url, None);
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test -p swarmz parses_a_browse`
Expected: compile error, no field `url`.

- [ ] **Step 3: Implement.** In `AgentEvent`, after `command`:

```rust
    /// A `Browse` request's address (tile browser spec §4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
```

In `parse_line`: `note: if event == "Scratch" || event == "Browse" { s("note") } else { None },` and `url: if event == "Browse" { s("url") } else { None },`.

Permissions: `AGENT_PERMISSIONS` becomes `[&str; 8]` with `"Bash(~/.swarmz/bin/swarmz browse:*)", "Bash(swarmz browse:*)"` appended; `CODEX_RULES` gains, before its final line's closing quote:

```text
prefix_rule(pattern=[\"~/.swarmz/bin/swarmz\", \"browse\"], decision=\"allow\")\n\
prefix_rule(pattern=[\"swarmz\", \"browse\"], decision=\"allow\")\n
```

(keep the string's existing `\n\` line continuation style; the last rule ends with `\n";`).

- [ ] **Step 4: Run the module's tests**

Run: `cd src-tauri && cargo test -p swarmz agents::`
Expected: PASS (the install tests compare against `AGENT_PERMISSIONS` and `CODEX_RULES`, so they follow).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents.rs
git commit -m "feat(core): Browse requests reach the desktop; agents may run swarmz browse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The native browser view in the core

**Files:**
- Modify: `src-tauri/Cargo.toml` (`tauri = { version = "2", features = ["unstable"] }`)
- Modify: `src-tauri/capabilities/default.json`, `src-tauri/capabilities/windows.json` (`"windows"` → `"webviews"`)
- Create: `src-tauri/src/browser.rs`
- Modify: `src-tauri/src/lib.rs` (`mod browser;`, register four commands)

**Interfaces:**
- Produces Tauri commands:
  - `browser_show(tile: String, window: String, url: String, rect: Rect, visible: bool) -> Result<(), String>`: creates the view if missing and `visible` (never creates a hidden one), reparents it into `window` if it lives elsewhere, places it, shows or hides it.
  - `browser_go(tile: String, action: String, url: Option<String>) -> Result<(), String>`: `action` is `load` (needs `url`), `back`, `forward`, `reload`, `focus`, `safari` (opens the view's current address, or `url`, in Safari). A missing view is `Ok` for everything but `safari` with no `url`.
  - `browser_close(tile: String) -> Result<(), String>`: closes the view if present.
- Produces event `browser:page` with payload `{tile: string, url: string, title?: string, loading?: boolean}`.
- `Rect` is `{x, y, w, h}` in CSS pixels relative to the window's content.

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/browser.rs`:

```rust
//! Each agent tile's browser (tile browser spec §3): a WebKit child view named `browse-<tile>` in
//! the swarmz window that shows the tile, placed over the frame the page draws.

pub const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_labels_and_addresses() {
        assert_eq!(view_label("c1"), "browse-c1");
        assert!(parse_address("https://example.com/a?b").is_ok());
        assert!(parse_address("http://localhost:1420").is_ok());
        assert!(parse_address("about:blank").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "about:config", "nonsense", ""] {
            assert!(parse_address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn sign_in_hosts() {
        for h in ["appleid.apple.com", "idmsa.apple.com", "accounts.google.com", "login.microsoftonline.com", "github.com"] {
            assert!(is_signin_host(h), "{h}");
        }
        for h in ["apple.com.evil.example", "evilgithub.com", "example.com"] {
            assert!(!is_signin_host(h), "{h}");
        }
    }

    #[test]
    fn no_capability_reaches_a_browser_view() {
        for file in ["capabilities/default.json", "capabilities/windows.json"] {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            assert!(v.get("windows").is_none(), "{file}: by window label a capability would cover child views");
            assert!(v.get("remote").is_none(), "{file}: no remote origin may use IPC");
            let names: Vec<&str> = v["webviews"].as_array().unwrap().iter().filter_map(|x| x.as_str()).collect();
            assert!(names.iter().all(|n| !n.starts_with("browse")), "{file}: {names:?}");
        }
    }
}
```

and add `mod browser;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test -p swarmz browser::`
Expected: compile errors for `view_label`, `parse_address`, `is_signin_host`.

- [ ] **Step 3: Implement the pure parts** in `browser.rs` above the tests:

```rust
use tauri::Url;

pub fn view_label(tile: &str) -> String {
    format!("browse-{tile}")
}

/// An address the view may load: `http`, `https`, or the blank start page.
pub fn parse_address(s: &str) -> Result<Url, String> {
    let url = Url::parse(s.trim()).map_err(|_| format!("not a web address: {s}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        "about" if url.as_str() == "about:blank" => Ok(url),
        other => Err(format!("swarmz's browser only opens http and https addresses, not {other}:")),
    }
}

const SIGNIN_HOSTS: [&str; 6] = ["appleid.apple.com", "idmsa.apple.com", "accounts.google.com", "login.microsoftonline.com", "login.live.com", "github.com"];

/// Sign-in popups (the page waits on them) open as a small swarmz window; other new windows go to Safari.
pub fn is_signin_host(host: &str) -> bool {
    SIGNIN_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}
```

Change both capability files: `"windows": ["main"]` → `"webviews": ["main"]`, `"windows": ["win-*"]` → `"webviews": ["win-*"]` (a `WebviewWindow`'s own webview has its window's label, so nothing they cover changes).

- [ ] **Step 4: Run them to see them pass**

Run: `cd src-tauri && cargo test -p swarmz browser::`
Expected: PASS (3 tests).

- [ ] **Step 5: Enable `unstable` and write the commands** (no unit test can host a webview; they are compile-checked here and checked by hand after release). `Cargo.toml`: `tauri = { version = "2", features = ["unstable"] }`. Append to `browser.rs` above the tests:

```rust
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

#[derive(Deserialize, Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Clone)]
struct Page {
    tile: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
}

static POPUPS: AtomicU64 = AtomicU64::new(0);

fn safe_tile(tile: &str) -> Result<(), String> {
    if !tile.is_empty() && tile.len() <= 64 && tile.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("invalid tile id {tile:?}"))
    }
}

/// Opens an address in Safari (new windows, downloads, the Open in Safari button).
fn open_in_safari(url: &str) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = std::process::Command::new("/usr/bin/open").args(["-a", "Safari", "--", url]).spawn();
    }
}

fn builder(app: &AppHandle, tile: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    let (nav_app, nav_tile) = (app.clone(), tile.to_string());
    let load_tile = tile.to_string();
    let title_tile = tile.to_string();
    let (popup_app, popup_tile) = (app.clone(), tile.to_string());
    WebviewBuilder::new(view_label(tile), WebviewUrl::External(url))
        .user_agent(SAFARI_UA)
        .on_navigation(move |u| {
            let ok = matches!(u.scheme(), "http" | "https") || u.as_str() == "about:blank";
            if !ok {
                let _ = nav_app.emit("browser:page", Page { tile: nav_tile.clone(), url: u.to_string(), title: None, loading: Some(false) });
            }
            ok
        })
        .on_page_load(move |view, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            let _ = view.app_handle().emit("browser:page", Page { tile: load_tile.clone(), url: p.url().to_string(), title: None, loading: Some(loading) });
        })
        .on_document_title_changed(move |view, title| {
            let url = view.url().map(|u| u.to_string()).unwrap_or_default();
            let _ = view.app_handle().emit("browser:page", Page { tile: title_tile.clone(), url, title: Some(title), loading: None });
        })
        .on_new_window(move |u, features| {
            if !u.host_str().is_some_and(is_signin_host) {
                open_in_safari(u.as_str());
                return NewWindowResponse::Deny;
            }
            let n = POPUPS.fetch_add(1, Ordering::SeqCst);
            let b = tauri::WebviewWindowBuilder::new(&popup_app, format!("browse-popup-{n}"), WebviewUrl::External("about:blank".parse().unwrap()))
                .window_features(features)
                .user_agent(SAFARI_UA)
                .title("Sign in")
                .inner_size(500.0, 680.0);
            // Parented to the window showing the tile, so it stays above it.
            let parent = popup_app.get_webview(&view_label(&popup_tile)).and_then(|v| popup_app.get_webview_window(v.window().label()));
            let b = match parent {
                Some(p) => match b.parent(&p) {
                    Ok(b) => b,
                    Err(_) => return NewWindowResponse::Deny,
                },
                None => b,
            };
            match b.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .on_download(|_, ev| {
            if let DownloadEvent::Requested { url, .. } = ev {
                open_in_safari(url.as_str());
            }
            false
        })
}

#[tauri::command]
pub async fn browser_show(app: AppHandle, tile: String, window: String, url: String, rect: Rect, visible: bool) -> Result<(), String> {
    safe_tile(&tile)?;
    let win = app.get_window(&window).ok_or_else(|| format!("no window {window}"))?;
    let pos = LogicalPosition::new(rect.x, rect.y);
    let size = LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0));
    if let Some(view) = app.get_webview(&view_label(&tile)) {
        if view.window().label() != window {
            view.reparent(&win).map_err(|e| e.to_string())?;
        }
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        let shown = if visible { view.show() } else { view.hide() };
        return shown.map_err(|e| e.to_string());
    }
    if !visible {
        return Ok(());
    }
    let start = parse_address(&url)?;
    win.add_child(builder(&app, &tile, start), pos, size).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, tile: String, action: String, url: Option<String>) -> Result<(), String> {
    safe_tile(&tile)?;
    let view = app.get_webview(&view_label(&tile));
    if action == "safari" {
        let target = url.or_else(|| view.as_ref().and_then(|v| v.url().ok()).map(|u| u.to_string())).ok_or("no page to open")?;
        open_in_safari(&target);
        return Ok(());
    }
    let Some(view) = view else { return Ok(()) };
    let r = match action.as_str() {
        "load" => view.navigate(parse_address(url.as_deref().unwrap_or(""))?),
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.eval("location.reload()"),
        "focus" => view.set_focus(),
        other => return Err(format!("unknown browser action {other}")),
    };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, tile: String) -> Result<(), String> {
    safe_tile(&tile)?;
    if let Some(view) = app.get_webview(&view_label(&tile)) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

Register in `lib.rs`'s `generate_handler!`: `browser::browser_show, browser::browser_go, browser::browser_close,`.

Ruling allowed here: if a Tauri 2.11 signature differs from the above, adapt the call to the real signature, keep the behaviour, and ledger it.

- [ ] **Step 6: Build and run the core tests**

Run: `cd src-tauri && cargo test --workspace > /tmp/szb-cargo.txt 2>&1; tail -20 /tmp/szb-cargo.txt`
Expected: compiles; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities src-tauri/src/browser.rs src-tauri/src/lib.rs
git commit -m "feat(core): a WebKit browser view per agent tile, placed by the frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend pieces: types, address bar, ipc, call queue, blockers

**Files:**
- Create: `src/lib/browser.ts`, `src/lib/browser.test.ts`
- Create: `src/lib/browserBlock.ts`, `src/lib/browserBlock.test.ts`
- Modify: `src/lib/agentState.ts` (`AgentEvent.url?: string | null`)
- Modify: `src/lib/ipc.ts` (four wrappers)

**Interfaces:**
- Consumes: Task 3's commands and `browser:page` event.
- Produces (`src/lib/browser.ts`):
  - `BLANK = "about:blank"`, `LOAD_STALL_MS = 25_000`
  - `interface BrowserRequest { url: string; note: string | null; agent: string; at: string }`
  - `interface BrowserState { open: boolean; url: string; title: string; loading: boolean; loadingSince: number | null; rect: ScratchRect | null; request: BrowserRequest | null; focusToken: number; pulse: boolean; error: string | null }`
  - `emptyBrowser(): BrowserState`
  - `defaultBrowserRect(bounds: {w: number; h: number}): ScratchRect` (two thirds wide, 60% tall, top-right, 12 px margin, clamped with `clampRect`)
  - `addressFor(text: string): { url: string } | { error: string } | null`
  - `queued(tile: string, call: () => Promise<unknown>): Promise<void>` (runs a tile's core calls one after another; a failure does not stop the next)
- Produces (`src/lib/browserBlock.ts`): `useBrowserBlock` (zustand, `{count: number}`, per window) and `useBlocksBrowsers(active: boolean): void`.
- Produces (`ipc`): `browserShow(tile, window, url, rect, visible)`, `browserGo(tile, action, url?)`, `browserClose(tile)`, `onBrowserPage(cb)`; `BrowserPage = {tile: string; url: string; title?: string; loading?: boolean}`.

- [ ] **Step 1: Write the failing tests** `src/lib/browser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addressFor, defaultBrowserRect, queued } from "./browser";

describe("addressFor", () => {
  it("keeps web addresses and adds a scheme to hosts", () => {
    expect(addressFor("https://appstoreconnect.apple.com")).toEqual({ url: "https://appstoreconnect.apple.com" });
    expect(addressFor("  example.com/a?b=1 ")).toEqual({ url: "https://example.com/a?b=1" });
    expect(addressFor("localhost:1420")).toEqual({ url: "http://localhost:1420" });
    expect(addressFor("192.168.1.4:8080/x")).toEqual({ url: "http://192.168.1.4:8080/x" });
  });
  it("searches anything else and refuses other schemes", () => {
    expect(addressFor("what is swarmz")).toEqual({ url: "https://duckduckgo.com/?q=what%20is%20swarmz" });
    expect(addressFor("swarmz")).toEqual({ url: "https://duckduckgo.com/?q=swarmz" });
    expect(addressFor("file:///etc/passwd")).toHaveProperty("error");
    expect(addressFor("javascript:alert(1)")).toHaveProperty("error");
    expect(addressFor("   ")).toBeNull();
  });
});

describe("defaultBrowserRect", () => {
  it("sits top-right, two thirds wide and 60% tall", () => {
    expect(defaultBrowserRect({ w: 900, h: 600 })).toEqual({ x: 288, y: 12, w: 600, h: 360 });
  });
});

describe("queued", () => {
  it("runs a tile's calls in order, past a failure", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const first = queued("t1", () => new Promise<void>((r) => (release = () => { seen.push("show"); r(); })));
    const second = queued("t1", async () => { seen.push("close"); });
    const failing = queued("t2", async () => { throw new Error("x"); });
    const after = queued("t2", async () => { seen.push("t2 next"); });
    await Promise.all([failing, after]);
    expect(seen).toEqual(["t2 next"]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(["t2 next", "show", "close"]);
  });
});
```

`src/lib/browserBlock.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useBlocksBrowsers, useBrowserBlock } from "./browserBlock";

function Blocker({ on }: { on: boolean }) {
  useBlocksBrowsers(on);
  return null;
}

describe("useBlocksBrowsers", () => {
  it("counts open blockers and lets go on close and unmount", () => {
    const a = render(<Blocker on />);
    const b = render(<Blocker on={false} />);
    expect(useBrowserBlock.getState().count).toBe(1);
    b.rerender(<Blocker on />);
    expect(useBrowserBlock.getState().count).toBe(2);
    b.rerender(<Blocker on={false} />);
    a.unmount();
    expect(useBrowserBlock.getState().count).toBe(0);
  });
});
```

(name the second file `browserBlock.test.tsx` since it holds JSX.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/browser.test.ts src/lib/browserBlock.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** `src/lib/browser.ts`:

```ts
/** A tile's built-in browser (tile browser spec): state the store keeps, and the address bar. */
import { clampRect, type ScratchRect } from "./scratch";

export const BLANK = "about:blank";
/** A load that has not finished after this long shows the error strip (spec §5, as ruled). */
export const LOAD_STALL_MS = 25_000;

export interface BrowserRequest {
  url: string;
  note: string | null;
  /** "Claude" or "Codex", for the banner. */
  agent: string;
  at: string;
}

export interface BrowserState {
  /** The frame shows (a hidden browser keeps its page). */
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  loadingSince: number | null;
  rect: ScratchRect | null;
  request: BrowserRequest | null;
  /** Bumped when the page should take the keyboard. */
  focusToken: number;
  /** An agent opened it while the user was elsewhere. */
  pulse: boolean;
  error: string | null;
}

export function emptyBrowser(): BrowserState {
  return { open: false, url: BLANK, title: "", loading: false, loadingSince: null, rect: null, request: null, focusToken: 0, pulse: false, error: null };
}

const MARGIN = 12;

export function defaultBrowserRect(bounds: { w: number; h: number }): ScratchRect {
  const w = Math.round((bounds.w * 2) / 3);
  const h = Math.round(bounds.h * 0.6);
  return clampRect({ x: bounds.w - w - MARGIN, y: MARGIN, w, h }, bounds);
}

const HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[^\s/:.]+(?:\.[^\s/:.]+)+)(:\d+)?([/?#]\S*)?$/i;

/** What the address bar loads for typed text: a web address, a search, or a refusal. */
export function addressFor(text: string): { url: string } | { error: string } | null {
  const t = text.trim();
  if (!t) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
  const m = HOST.exec(t);
  if (m) return { url: `${/^(localhost|\d)/i.test(m[1]) ? "http" : "https"}://${t}` };
  if (scheme === "http" || scheme === "https") return /\s/.test(t) ? { error: "An address cannot contain spaces" } : { url: t };
  if (scheme && !/\s/.test(t)) return { error: `swarmz's browser only opens http and https addresses, not ${scheme}:` };
  return { url: `https://duckduckgo.com/?q=${encodeURIComponent(t)}` };
}

const chains = new Map<string, Promise<void>>();

/** Runs a tile's core calls one after another, so a close never overtakes the show before it. */
export function queued(tile: string, call: () => Promise<unknown>): Promise<void> {
  const next = (chains.get(tile) ?? Promise.resolve()).then(() => call()).then(
    () => {},
    () => {},
  );
  chains.set(tile, next);
  return next;
}
```

Note the order in `addressFor`: `localhost:1420` matches `HOST` before being read as a `localhost:` scheme.

`src/lib/browserBlock.ts`:

```ts
/** Overlays that can cover a pane hide every browser view in their window while open (tile
 * browser spec §3): a native page is drawn above everything the window's own page draws. */
import { useEffect } from "react";
import { create } from "zustand";

export const useBrowserBlock = create<{ count: number }>(() => ({ count: 0 }));

export function useBlocksBrowsers(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    useBrowserBlock.setState((s) => ({ count: s.count + 1 }));
    return () => useBrowserBlock.setState((s) => ({ count: s.count - 1 }));
  }, [active]);
}
```

`agentState.ts`, in `AgentEvent` after `command?`: `/** A \`Browse\` request's address (tile browser spec §4). */ url?: string | null;`

`ipc.ts`: export `export interface BrowserPage { tile: string; url: string; title?: string; loading?: boolean }` and add to the `ipc` object beside `openUrl`:

```ts
  /** Creates (when visible), moves, shows or hides a tile's browser view in `window` (tile browser spec §3). */
  browserShow: (tile: string, window: string, url: string, rect: { x: number; y: number; w: number; h: number }, visible: boolean) =>
    invoke<void>("browser_show", { tile, window, url, rect, visible }),
  browserGo: (tile: string, action: "load" | "back" | "forward" | "reload" | "focus" | "safari", url?: string) =>
    invoke<void>("browser_go", { tile, action, url: url ?? null }),
  browserClose: (tile: string) => invoke<void>("browser_close", { tile }),
  onBrowserPage: (cb: (p: BrowserPage) => void): Promise<UnlistenFn> => listen<BrowserPage>("browser:page", (e) => cb(e.payload)),
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/lib/browser.test.ts src/lib/browserBlock.test.tsx && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/browser.ts src/lib/browser.test.ts src/lib/browserBlock.ts src/lib/browserBlock.test.tsx src/lib/agentState.ts src/lib/ipc.ts
git commit -m "feat(ui): browser state, address bar rules, ipc and overlay blockers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The store: browsers per tile and agent requests

**Files:**
- Modify: `src/store.ts`
- Modify: `src/lib/windowMirror.ts` (`MIRRORED_KEYS` gains `"browser"`; `PROXIED_ACTIONS` gains `openBrowser`, `hideBrowser`, `closeBrowser`, `setBrowserRect`, `navigateBrowser`, `browserGo`, `dismissBrowserRequest`, `setBrowserError`)
- Modify: `src/App.tsx` (main window listens to `browser:page`)
- Test: `src/store.test.ts` (ipc mock gains `browserShow`, `browserGo`, `browserClose`, `onBrowserPage`; reset gains `browser: {}`)

**Interfaces:**
- Consumes: Task 4's `BrowserState`, `emptyBrowser`, `addressFor` (not here), `queued`, `BLANK`, ipc wrappers.
- Produces store fields and actions:
  - `browser: Record<string, BrowserState>`
  - `openBrowser(tileId: string, opts?: { url?: string; focus?: boolean }): void`: agent tiles only; creates state (`emptyBrowser()`) or reuses it; sets `open: true`, `url` when given (and clears `error`), bumps `focusToken` and clears `pulse` when `focus`.
  - `hideBrowser(tileId)`: `open: false`.
  - `closeBrowser(tileId)`: deletes the state and calls `queued(tile, () => ipc.browserClose(tile))`.
  - `setBrowserRect(tileId, rect)`.
  - `navigateBrowser(tileId, url)`: sets `url`, clears `error`, and `queued(tile, () => ipc.browserGo(tile, "load", url))`.
  - `browserGo(tileId, action: "back" | "forward" | "reload" | "safari")`: `queued(…, () => ipc.browserGo(tile, action))`.
  - `browserPage(page: BrowserPage)`: main window only, from the event: updates `url`, `title`, `loading`, `loadingSince`, clears `error` when a load finishes.
  - `dismissBrowserRequest(tileId)`, `setBrowserError(tileId, error: string | null)`.
- `closeTerminal(id)` calls `closeBrowser(id)`; a subscription closes the browser of any tile that is gone or no longer an agent tile.

- [ ] **Step 1: Add the ipc mock entries and reset**, then **write the failing tests** at the end of `src/store.test.ts`:

In the `vi.mock("./lib/ipc", …)` object add `browserShow: vi.fn(async () => {}), browserGo: vi.fn(async () => {}), browserClose: vi.fn(async () => {}), onBrowserPage: vi.fn(async () => () => {}),`, and add `browser: {},` after `scratch: {},` in the reset.

```ts
describe("tile browser", () => {
  const agentTile = async () => {
    const id = await useStore.getState().createTerminal("/tmp/proj");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: true } } } }));
    __setLaunchedAt(new Date(Date.now() - 60_000).toISOString());
    vi.mocked(ipc.browserGo).mockClear();
    vi.mocked(ipc.browserClose).mockClear();
    return id;
  };
  const browseEvent = (terminal: string, ts: string, extra: Record<string, unknown> = {}) => ({
    host: null as string | null,
    event: { ts, terminal, event: "Browse", sessionId: null, notificationType: null, source: null, cwd: null, permissionMode: null, url: "https://appstoreconnect.apple.com/apps", note: "Create the app", ...extra },
  });

  it("opens, hides and closes; only agent tiles have one", async () => {
    const id = await agentTile();
    const shell = await useStore.getState().createTerminal("/tmp/other");
    useStore.getState().openBrowser(shell);
    expect(useStore.getState().browser[shell]).toBeUndefined();
    useStore.getState().openBrowser(id);
    expect(useStore.getState().browser[id]).toMatchObject({ open: true, url: "about:blank" });
    useStore.getState().hideBrowser(id);
    expect(useStore.getState().browser[id].open).toBe(false);
    useStore.getState().closeBrowser(id);
    expect(useStore.getState().browser[id]).toBeUndefined();
    await vi.waitFor(() => expect(ipc.browserClose).toHaveBeenCalledWith(id));
  });

  it("closing the tile, or turning its agent off, closes its browser", async () => {
    const a = await agentTile();
    const b = await agentTile();
    useStore.getState().openBrowser(a);
    useStore.getState().openBrowser(b);
    await useStore.getState().closeTerminal(a);
    expect(useStore.getState().browser[a]).toBeUndefined();
    useStore.setState((s) => ({ settings: { ...s.settings, [b]: { ...s.settings[b], claude: { ...s.settings[b].claude!, enabled: false } } } }));
    await vi.waitFor(() => expect(useStore.getState().browser[b]).toBeUndefined());
    expect(ipc.browserClose).toHaveBeenCalledWith(a);
    expect(ipc.browserClose).toHaveBeenCalledWith(b);
  });

  it("a live request opens the page with its note; history and repeats do nothing", async () => {
    const id = await agentTile();
    useStore.setState({ focusedTerminalId: id, windowFocused: true });
    useStore.getState().applyAgentEvent(browseEvent(id, new Date(Date.now() - 120_000).toISOString()));
    expect(useStore.getState().browser[id]).toBeUndefined();
    const ts = new Date().toISOString();
    useStore.getState().applyAgentEvent(browseEvent(id, ts));
    useStore.getState().applyAgentEvent(browseEvent(id, ts, { url: "https://example.com" }));
    expect(useStore.getState().browser[id]).toMatchObject({ open: true, url: "https://appstoreconnect.apple.com/apps", pulse: false });
    expect(useStore.getState().browser[id].request).toMatchObject({ note: "Create the app", agent: "Claude", url: "https://appstoreconnect.apple.com/apps" });
    expect(useStore.getState().browser[id].focusToken).toBe(1);
  });

  it("never takes the keyboard from another tile, and pulses", async () => {
    const id = await agentTile();
    useStore.setState({ focusedTerminalId: "someone-else", windowFocused: true });
    useStore.getState().applyAgentEvent(browseEvent(id, new Date().toISOString()));
    expect(useStore.getState().browser[id]).toMatchObject({ open: true, focusToken: 0, pulse: true });
  });

  it("does not change the page the user is reading: Go there does", async () => {
    const id = await agentTile();
    useStore.getState().openBrowser(id, { url: "https://news.example.com" });
    useStore.getState().applyAgentEvent(browseEvent(id, new Date().toISOString()));
    expect(useStore.getState().browser[id].url).toBe("https://news.example.com");
    expect(useStore.getState().browser[id].request?.url).toBe("https://appstoreconnect.apple.com/apps");
    expect(ipc.browserGo).not.toHaveBeenCalled();
    useStore.getState().navigateBrowser(id, useStore.getState().browser[id].request!.url);
    await vi.waitFor(() => expect(ipc.browserGo).toHaveBeenCalledWith(id, "load", "https://appstoreconnect.apple.com/apps"));
    expect(useStore.getState().browser[id].url).toBe("https://appstoreconnect.apple.com/apps");
  });

  it("a request for a remote tile's log only counts for that tile's Mac", async () => {
    const id = await agentTile();
    useStore.getState().applyAgentEvent({ ...browseEvent(id, new Date().toISOString()), host: "studio" });
    expect(useStore.getState().browser[id]).toBeUndefined();
  });

  it("page reports update the address and title, and a finished load clears the error", async () => {
    const id = await agentTile();
    useStore.getState().openBrowser(id);
    useStore.getState().setBrowserError(id, "This page hasn't finished loading");
    useStore.getState().browserPage({ tile: id, url: "https://example.com/", loading: true });
    expect(useStore.getState().browser[id]).toMatchObject({ url: "https://example.com/", loading: true });
    expect(useStore.getState().browser[id].loadingSince).not.toBeNull();
    useStore.getState().browserPage({ tile: id, url: "https://example.com/", title: "Example" });
    useStore.getState().browserPage({ tile: id, url: "https://example.com/", loading: false });
    expect(useStore.getState().browser[id]).toMatchObject({ title: "Example", loading: false, loadingSince: null, error: null });
    useStore.getState().browserPage({ tile: "gone", url: "https://x/" });
    expect(useStore.getState().browser.gone).toBeUndefined();
  });

  it("is never saved", async () => {
    const id = await agentTile();
    useStore.getState().openBrowser(id, { url: "https://example.com" });
    expect(JSON.stringify(toWorkspace(useStore.getState()))).not.toContain("example.com");
  });
});
```

(`toWorkspace` and `__setLaunchedAt` are already imported by the file's scratch tests; import `toWorkspace` from `./lib/workspace` or wherever the existing "no save" scratch test gets it, matching that test.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/store.test.ts -t "tile browser"`
Expected: FAIL, `openBrowser` is not a function.

- [ ] **Step 3: Implement in `src/store.ts`.**

Imports: `import { BLANK, emptyBrowser, queued, type BrowserState, type BrowserRequest } from "./lib/browser";` and `type BrowserPage` from `./lib/ipc`.

Module helpers beside the scratch ones:

```ts
function patchBrowser(s: WorkbenchState, tileId: string, patch: Partial<BrowserState>): Partial<WorkbenchState> {
  const cur = s.browser[tileId] ?? emptyBrowser();
  return { browser: { ...s.browser, [tileId]: { ...cur, ...patch } } };
}

/** `Browse` events already acted on (host|tile|ts). */
const seenBrowse = new Set<string>();

/** An agent asked to open a page in its tile's browser (tile browser spec §4). */
function handleBrowseRequest({ host, event }: AgentEventPayload): void {
  if (!event.url || !scratchEventIsLive(event.ts, Date.now(), APP_LAUNCHED_AT)) return;
  const key = `${host ?? ""}|${event.terminal}|${event.ts}`;
  if (seenBrowse.has(key)) return;
  seenBrowse.add(key);
  const s = useStore.getState();
  const tileId = event.terminal;
  const settings = s.settings[tileId];
  if (!s.terminals[tileId] || !settings?.claude?.enabled) return;
  if (host === null ? settings.ssh != null : settings.ssh?.host?.trim() !== host) return;
  const request: BrowserRequest = { url: event.url, note: event.note ?? null, agent: agentName(settings.claude), at: event.ts };
  const here = s.windowFocused !== false && s.focusedTerminalId === tileId;
  const cur = s.browser[tileId];
  const reading = !!cur?.open && cur.url !== BLANK && cur.url !== event.url;
  useStore.setState((x) => patchBrowser(x, tileId, { request, pulse: !here }));
  if (reading) return;
  useStore.getState().openBrowser(tileId, { url: event.url, focus: here });
  if (!here) useStore.setState((x) => patchBrowser(x, tileId, { pulse: true }));
}
```

State type additions (beside `scratch`):

```ts
  /** Each agent tile's built-in browser (tile browser spec); never saved. */
  browser: Record<string, BrowserState>;
  openBrowser(tileId: string, opts?: { url?: string; focus?: boolean }): void;
  hideBrowser(tileId: string): void;
  closeBrowser(tileId: string): void;
  setBrowserRect(tileId: string, rect: ScratchRect): void;
  navigateBrowser(tileId: string, url: string): void;
  browserGo(tileId: string, action: "back" | "forward" | "reload" | "safari"): void;
  browserPage(page: BrowserPage): void;
  dismissBrowserRequest(tileId: string): void;
  setBrowserError(tileId: string, error: string | null): void;
```

Initial state `browser: {},` and the actions (after `dismissScratchRequest`):

```ts
  openBrowser(tileId, opts = {}) {
    const s = useStore.getState();
    if (!s.terminals[tileId] || !s.settings[tileId]?.claude?.enabled) return;
    const focus = opts.focus !== false;
    set((x) =>
      patchBrowser(x, tileId, {
        open: true,
        ...(opts.url ? { url: opts.url, error: null } : {}),
        ...(focus ? { pulse: false, focusToken: (x.browser[tileId]?.focusToken ?? 0) + 1 } : {}),
      }),
    );
    // A view that already exists goes to the new address; a new one starts on it (BrowserWindow).
    if (opts.url && s.browser[tileId]) void queued(tileId, () => ipc.browserGo(tileId, "load", opts.url));
  },

  hideBrowser(tileId) {
    if (!useStore.getState().browser[tileId]) return;
    set((x) => patchBrowser(x, tileId, { open: false }));
  },

  closeBrowser(tileId) {
    if (!useStore.getState().browser[tileId]) return;
    set((x) => {
      const browser = { ...x.browser };
      delete browser[tileId];
      return { browser };
    });
    void queued(tileId, () => ipc.browserClose(tileId));
  },

  setBrowserRect(tileId, rect) {
    set((x) => patchBrowser(x, tileId, { rect }));
  },

  navigateBrowser(tileId, url) {
    if (!useStore.getState().browser[tileId]) return;
    set((x) => patchBrowser(x, tileId, { url, error: null }));
    void queued(tileId, () => ipc.browserGo(tileId, "load", url));
  },

  browserGo(tileId, action) {
    if (!useStore.getState().browser[tileId]) return;
    void queued(tileId, () => ipc.browserGo(tileId, action));
  },

  browserPage({ tile, url, title, loading }) {
    if (!useStore.getState().browser[tile]) return;
    set((x) =>
      patchBrowser(x, tile, {
        url,
        ...(title !== undefined ? { title } : {}),
        ...(loading === true ? { loading: true, loadingSince: Date.now() } : {}),
        ...(loading === false ? { loading: false, loadingSince: null, error: null } : {}),
      }),
    );
  },

  dismissBrowserRequest(tileId) {
    if (!useStore.getState().browser[tileId]) return;
    set((x) => patchBrowser(x, tileId, { request: null }));
  },

  setBrowserError(tileId, error) {
    if (!useStore.getState().browser[tileId]) return;
    set((x) => patchBrowser(x, tileId, { error }));
  },
```

In `applyAgentEvent`, after the `Scratch` branch:

```ts
    if (event.event === "Browse") {
      handleBrowseRequest(payload);
      return;
    }
```

In `closeTerminal`, next to `void useStore.getState().endScratch(id);`: `useStore.getState().closeBrowser(id);`.

After the store is created (beside the other module-level subscriptions), close browsers whose tile is gone or no longer an agent:

```ts
useStore.subscribe((s) => {
  if (s.windowLabel !== MAIN) return;
  for (const tile of Object.keys(s.browser)) {
    if (!s.terminals[tile] || !s.settings[tile]?.claude?.enabled) queueMicrotask(() => useStore.getState().closeBrowser(tile));
  }
});
```

`windowMirror.ts`: add `"browser"` to `MIRRORED_KEYS`, and the eight action names to `PROXIED_ACTIONS` (not `browserPage`, which the main window applies itself).

`App.tsx`, next to `ipc.onAgentEvent(...)` in the main window's effect: `void ipc.onBrowserPage((p) => useStore.getState().browserPage(p)).then((fn) => unlisten.push(fn));`

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/store.test.ts -t "tile browser"`
Expected: PASS (8 tests). If "a live request" sees `focusToken` 2 because `openBrowser` and the handler both bump it, the handler is wrong, not the test: only `openBrowser` bumps.

- [ ] **Step 5: Full frontend suite and typecheck**

Run: `npm test > /tmp/szb-npm.txt 2>&1; tail -8 /tmp/szb-npm.txt; npm run typecheck`
Expected: all pass (the windowMirror tests that list keys and actions are updated if they enumerate them).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/store.test.ts src/lib/windowMirror.ts src/App.tsx
git commit -m "feat(ui): tile browsers in the store; agents open pages with a note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The browser frame, the 🌐 button and the blockers

**Files:**
- Create: `src/components/BrowserWindow.tsx`, `src/components/BrowserWindow.test.tsx`
- Modify: `src/components/TerminalPane.tsx` (render `<BrowserWindow tileId={id} blocked={overlay !== null} />` beside `ScratchWindow`)
- Modify: `src/components/TabGroup.tsx` (🌐 button; `useBlocksBrowsers(true)` in `TabMenu`)
- Modify: `src/components/LayoutGallery.tsx` (`useBlocksBrowsers(open)` in `GalleryButton`)
- Modify: `src/components/ConductorsPanel.tsx`, `src/components/PhonesPanel.tsx` (`useBlocksBrowsers(true)`)
- Modify: `src/components/FileViewer.tsx` (`useBlocksBrowsers(<fileView is set>)`)
- Modify: `src/components/ClosedNoticeBar.tsx` (`useBlocksBrowsers(notice !== null)`)
- Test: `src/components/TabGroup.test.tsx`

**Interfaces:**
- Consumes: store `browser`, the Task 5 actions, `windowLabel`, `draggingTerminalId`; `useBrowserBlock`; `defaultBrowserRect`, `clampRect`, `addressFor`, `queued`, `LOAD_STALL_MS`, `BLANK`; `ipc.browserShow`, `ipc.browserGo`.
- Produces: `BrowserWindow({ tileId, blocked }: { tileId: string; blocked: boolean })`, test ids `browser-window`, `browser-page`, `browser-toggle`.

- [ ] **Step 1: Write the failing component tests** `src/components/BrowserWindow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  ipc: { browserShow: vi.fn(async () => {}), browserGo: vi.fn(async () => {}), browserClose: vi.fn(async () => {}) },
}));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { useBrowserBlock } from "../lib/browserBlock";
import { emptyBrowser } from "../lib/browser";
import { BrowserWindow } from "./BrowserWindow";

class RO {
  observe() {}
  disconnect() {}
}

const lastShow = () => vi.mocked(ipc.browserShow).mock.calls.at(-1);

describe("BrowserWindow", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", RO);
    vi.mocked(ipc.browserShow).mockClear();
    useBrowserBlock.setState({ count: 0 });
    useStore.setState({ windowLabel: "main", draggingTerminalId: null, browser: { t1: { ...emptyBrowser(), open: true, url: "https://example.com/", title: "Example" } } });
  });
  afterEach(cleanup);

  it("shows the page in this window, and hides it for a drag, an overlay, a blocked pane and on unmount", async () => {
    const view = render(<div style={{ width: 900, height: 600 }}><BrowserWindow tileId="t1" blocked={false} /></div>);
    await vi.waitFor(() => expect(lastShow()).toEqual(["t1", "main", "https://example.com/", expect.any(Object), true]));
    act(() => useStore.setState({ draggingTerminalId: "t2" }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    act(() => useStore.setState({ draggingTerminalId: null }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(true));
    act(() => useBrowserBlock.setState({ count: 1 }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    act(() => useBrowserBlock.setState({ count: 0 }));
    view.rerender(<div><BrowserWindow tileId="t1" blocked /></div>);
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    view.rerender(<div><BrowserWindow tileId="t1" blocked={false} /></div>);
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(true));
    view.unmount();
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
  });

  it("the address bar loads typed text and refuses other schemes", () => {
    const navigate = vi.spyOn(useStore.getState(), "navigateBrowser");
    render(<BrowserWindow tileId="t1" blocked={false} />);
    const bar = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(bar, { target: { value: "localhost:1420" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("t1", "http://localhost:1420");
    fireEvent.change(bar, { target: { value: "file:///etc/passwd" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByText(/only opens http and https/)).toBeTruthy();
  });

  it("shows the agent's note with Go there, and the stalled-load strip", () => {
    useStore.setState({ browser: { t1: { ...emptyBrowser(), open: true, url: "https://news.example.com/", request: { url: "https://appstoreconnect.apple.com/apps", note: "Create the app", agent: "Claude", at: "x" }, loading: true, loadingSince: Date.now() - 30_000 } } });
    const navigate = vi.spyOn(useStore.getState(), "navigateBrowser");
    render(<BrowserWindow tileId="t1" blocked={false} />);
    expect(screen.getByText("Claude asks:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go there" }));
    expect(navigate).toHaveBeenCalledWith("t1", "https://appstoreconnect.apple.com/apps");
    expect(screen.getByText("This page hasn't finished loading")).toBeTruthy();
  });

  it("renders nothing visible when the browser is hidden", () => {
    useStore.setState({ browser: { t1: { ...emptyBrowser(), open: false } } });
    render(<BrowserWindow tileId="t1" blocked={false} />);
    expect(screen.queryByTestId("browser-window")).toBeNull();
  });
});
```

Add to `src/components/TabGroup.test.tsx`, after the `describe("scratch button", …)` block (it reuses that file's `ID` and `agent`), and add `browser: {},` beside `scratch: {},` in the file's reset:

```tsx
describe("browser button", () => {
  it("shows on agent tiles only, opens, hides, and pulses after an agent asked", () => {
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    expect(screen.queryByTestId("browser-toggle")).toBeNull();
    cleanup();
    const open = vi.fn();
    const hide = vi.fn();
    useStore.setState({ openBrowser: open, hideBrowser: hide, settings: { [ID]: { ssh: null, claude: agent, command: null, extra: {} } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    fireEvent.click(screen.getByTestId("browser-toggle"));
    expect(open).toHaveBeenCalledWith(ID);
    cleanup();
    useStore.setState({ browser: { [ID]: { ...emptyBrowser(), open: true, pulse: true } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    const b = screen.getByTestId("browser-toggle");
    expect(b.className).toContain("animate-pulse");
    fireEvent.click(b);
    expect(hide).toHaveBeenCalledWith(ID);
  });
});
```

(import `emptyBrowser` from `../lib/browser`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/BrowserWindow.test.tsx src/components/TabGroup.test.tsx`
Expected: FAIL, `./BrowserWindow` not found; no `browser-toggle`.

- [ ] **Step 3: Implement** `src/components/BrowserWindow.tsx`:

```tsx
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { ipc } from "../lib/ipc";
import { useBrowserBlock } from "../lib/browserBlock";
import { addressFor, defaultBrowserRect, LOAD_STALL_MS, queued } from "../lib/browser";
import { clampRect, type ScratchRect } from "../lib/scratch";

/** The native page sits this far inside the frame's page box, so the frame stays clickable. */
const INSET = 2;

/** A tile's built-in browser, floating over the agent's output (tile browser spec §1). */
export function BrowserWindow({ tileId, blocked }: { tileId: string; blocked: boolean }) {
  const st = useStore((s) => s.browser[tileId]);
  const windowLabel = useStore((s) => s.windowLabel);
  const dragging = useStore((s) => s.draggingTerminalId !== null);
  const overlays = useBrowserBlock((s) => s.count);
  const hide = useStore((s) => s.hideBrowser);
  const close = useStore((s) => s.closeBrowser);
  const setRect = useStore((s) => s.setBrowserRect);
  const navigate = useStore((s) => s.navigateBrowser);
  const go = useStore((s) => s.browserGo);
  const dismiss = useStore((s) => s.dismissBrowserRequest);
  const setError = useStore((s) => s.setBrowserError);
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0 });
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [, tick] = useState(0);
  const open = !!st?.open;
  const showing = open && !blocked && !dragging && overlays === 0;

  useEffect(() => {
    const pane = box.current?.parentElement;
    if (!pane) return;
    const measure = () => setBounds({ w: pane.clientWidth, h: pane.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [open]);

  // Place the native page over the page box whenever anything about it changes; hide it otherwise.
  const rect: ScratchRect | null = st && bounds.w > 0 ? clampRect(st.rect ?? defaultBrowserRect(bounds), bounds) : null;
  const url = st?.url ?? "";
  useEffect(() => {
    if (!st) return;
    const place = () => {
      const r = page.current?.getBoundingClientRect();
      const at = r ? { x: r.left + INSET, y: r.top + INSET, w: Math.max(r.width - 2 * INSET, 1), h: Math.max(r.height - 2 * INSET, 1) } : { x: 0, y: 0, w: 1, h: 1 };
      void queued(tileId, () =>
        ipc.browserShow(tileId, windowLabel, url, at, showing && !!r).catch((e) => {
          if (showing) setError(tileId, typeof e === "string" ? e : String(e));
          throw e;
        }),
      );
    };
    place();
    const el = page.current;
    const ro = el ? new ResizeObserver(place) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
    // `url` is only the address a not-yet-created view starts on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileId, windowLabel, showing, rect?.x, rect?.y, rect?.w, rect?.h, !!st]);

  // Leaving the pane (tab switch, zoom, another window) hides the page; it keeps running.
  useEffect(() => () => void queued(tileId, () => ipc.browserShow(tileId, windowLabel, "about:blank", { x: 0, y: 0, w: 1, h: 1 }, false)), [tileId, windowLabel]);

  // Take the keyboard only when asked (the token went up), like the scratch window.
  const handledToken = useRef(st?.focusToken ?? 0);
  useEffect(() => {
    const token = st?.focusToken ?? 0;
    if (!showing || token <= handledToken.current) return;
    handledToken.current = token;
    if (url === "about:blank") address.current?.focus();
    else void queued(tileId, () => ipc.browserGo(tileId, "focus"));
  }, [showing, st?.focusToken, tileId, url]);

  // A load that never finishes shows the strip (as ruled: wry reports no failures).
  useEffect(() => {
    if (!st?.loading || st.loadingSince === null) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(LOAD_STALL_MS - (Date.now() - st.loadingSince), 0) + 50);
    return () => clearTimeout(t);
  }, [st?.loading, st?.loadingSince]);

  if (!open || !st) return <div ref={box} hidden />;
  const r = rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const stalled = st.loading && st.loadingSince !== null && Date.now() - st.loadingSince >= LOAD_STALL_MS;
  const problem = refused ?? st.error ?? (stalled ? "This page hasn't finished loading" : null);

  const drag = (mode: "move" | "size") => (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r };
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      const next = mode === "move" ? { ...start.r, x: start.r.x + dx, y: start.r.y + dy } : { ...start.r, w: start.r.w + dx, h: start.r.h + dy };
      setRect(tileId, clampRect(next, bounds));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const submit = () => {
    const a = addressFor(typed ?? st.url);
    if (!a) return;
    if ("error" in a) {
      setRefused(a.error);
      return;
    }
    setRefused(null);
    setTyped(null);
    navigate(tileId, a.url);
  };

  const iconButton = "rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100";
  return (
    <div ref={box}>
      <div
        data-testid="browser-window"
        className="absolute z-30 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-neutral-950 shadow-2xl"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        onKeyDown={(e) => {
          if (e.metaKey && e.key.toLowerCase() === "l") {
            e.preventDefault();
            address.current?.select();
          }
        }}
      >
        <div className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300" onPointerDown={drag("move")}>
          <span className="min-w-0 flex-1 truncate" title={st.title || st.url}>{st.title || "Browser"}</span>
          <button type="button" className={iconButton} aria-label="Hide browser" title="Hide (keeps the page)" onPointerDown={(e) => e.stopPropagation()} onClick={() => hide(tileId)}>–</button>
          <button type="button" className={`${iconButton} hover:text-exited`} aria-label="Close browser" title="Close the browser" onPointerDown={(e) => e.stopPropagation()} onClick={() => close(tileId)}>✕</button>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs">
          <button type="button" className={iconButton} aria-label="Back" onClick={() => go(tileId, "back")}>‹</button>
          <button type="button" className={iconButton} aria-label="Forward" onClick={() => go(tileId, "forward")}>›</button>
          <button type="button" className={iconButton} aria-label="Reload" onClick={() => go(tileId, "reload")}>↻</button>
          <input
            ref={address}
            aria-label="Address"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
            value={typed ?? (st.url === "about:blank" ? "" : st.url)}
            placeholder="Search or enter an address"
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTyped(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setTyped(null);
            }}
          />
          <button type="button" className={iconButton} aria-label="Open in Safari" title="Open in Safari" onClick={() => go(tileId, "safari")}>⤴</button>
        </div>
        {st.request && (
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-700 bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-300">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-neutral-100">{st.request.agent} asks:</span> {st.request.note ?? ""}
              {st.request.url !== st.url && <span className="ml-1 font-mono text-neutral-500">{st.request.url}</span>}
            </span>
            {st.request.url !== st.url && (
              <button type="button" className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => navigate(tileId, st.request!.url)}>Go there</button>
            )}
            <button type="button" className={iconButton} aria-label="Dismiss request" onClick={() => dismiss(tileId)}>✕</button>
          </div>
        )}
        {problem && (
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-needs">
            <span className="min-w-0 flex-1">{problem}</span>
            <button type="button" className={iconButton} onClick={() => { setRefused(null); setError(tileId, null); go(tileId, "reload"); }}>Retry</button>
            <button type="button" className={iconButton} onClick={() => go(tileId, "safari")}>Open in Safari</button>
          </div>
        )}
        <div ref={page} data-testid="browser-page" className="relative min-h-0 flex-1 bg-white" />
        <div className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" onPointerDown={drag("size")} aria-hidden="true" />
      </div>
    </div>
  );
}
```

Note: the `Retry` button reloads (wry has no "retry the failed load"; reload re-requests the current address). For a view creation error, `setError(null)` lets the next placement try again.

`TerminalPane.tsx`: import `BrowserWindow`, and after the `ScratchWindow` line: `{settings.claude?.enabled && <BrowserWindow tileId={id} blocked={overlay !== null} />}`.

`TabGroup.tsx`: beside the scratch selectors:

```tsx
  const browserOpen = useStore((s) => !!activeId && s.browser[activeId]?.open === true);
  const browserAround = useStore((s) => !!activeId && !!s.browser[activeId]);
  const browserPulse = useStore((s) => !!activeId && s.browser[activeId]?.pulse === true);
  const openBrowser = useStore((s) => s.openBrowser);
  const hideBrowser = useStore((s) => s.hideBrowser);
```

and inside the `{isAgent && (…)}` block, after the `>_` button (wrap both in a fragment):

```tsx
            <button
              type="button"
              data-testid="browser-toggle"
              className={`rounded px-1.5 text-xs hover:bg-neutral-800 hover:text-neutral-200 ${browserAround ? "text-link" : "text-neutral-500"} ${browserPulse ? "animate-pulse" : ""}`}
              title={browserOpen ? "Hide the browser" : "Browser: a web page over this tile"}
              aria-label="Browser"
              aria-pressed={browserOpen}
              onClick={() => (browserOpen ? hideBrowser(activeId) : openBrowser(activeId))}
            >
              🌐
            </button>
```

Add `useBlocksBrowsers(true);` as the first line of `TabMenu`; `useBlocksBrowsers(open);` in `GalleryButton`; `useBlocksBrowsers(true);` at the top of `ConductorsPanel` and `PhonesPanel`; `useBlocksBrowsers(fileView !== null)` in `FileViewer` (using its existing `fileView` selector, adding `const fileView = useStore((s) => s.fileView);` if it reads it differently); `useBlocksBrowsers(notice !== null);` in `ClosedNoticeBar` after `notice`. Each hook call goes before any early `return`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/components/BrowserWindow.test.tsx src/components/TabGroup.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm test > /tmp/szb-npm.txt 2>&1; tail -8 /tmp/szb-npm.txt; npm run typecheck`
Expected: all pass, typecheck clean. Components that now call `useBlocksBrowsers` keep their tests green (the hook needs no mocking).

- [ ] **Step 6: Commit**

```bash
git add src/components
git commit -m "feat(ui): the browser frame and button; overlays hide the page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs and the whole-branch check

**Files:**
- Modify: `CLAUDE.md` (a "Tile browser" section after the scratch shell material, or after "Jump to your messages" if there is no scratch section)

- [ ] **Step 1: Write the CLAUDE.md section**

```markdown
### Tile browser

Agent tiles (Claude, Codex) have a built-in browser (tile browser spec): 🌐 in the tab group's header toggles `BrowserWindow`, a frame floating over the pane (title, back/forward/reload, address bar with `addressFor`: hosts get `https://`, `localhost` and IPs `http://`, other text searches DuckDuckGo, other schemes are refused; Open in Safari; the agent's note with **Go there**; a strip when a load has not finished after `LOAD_STALL_MS`). The page is a native WebKit child view `browse-<tile>` (`src-tauri/src/browser.rs`, Tauri `unstable`: `add_child`, `reparent`) that only the frame places, through `browser_show(tile, window, url, rect, visible)` (creates it only when visible, moves it between windows), with `browser_go` and `browser_close`; a tile's calls run in order through `queued`. It hides for drags, a pane overlay (`blocked`), tab switches and any overlay that calls `useBlocksBrowsers` (`src/lib/browserBlock.ts`; add it to any new popover drawn over panes). It has no capabilities (capabilities name `webviews`, never windows), presents itself as Safari, sends new windows and downloads to Safari except sign-in popups (`is_signin_host`: a small swarmz window), and reports `browser:page`. The store's `browser` map (mirrored; never saved) holds open/url/title/request/pulse; closing a tile or turning its agent off closes it. `swarmz browse --url … [--note …]` writes a `Browse` line to `events.log` (the briefing, v7, tells agents; allowed like `scratch`), acted on only when live like `Scratch`: it opens the page, or only shows the note with **Go there** when the user is reading another page.
```

- [ ] **Step 2: Run every suite**

Run: `npm test > /tmp/szb-npm.txt 2>&1; tail -5 /tmp/szb-npm.txt; npm run typecheck; (cd src-tauri && cargo test --workspace > /tmp/szb-cargo.txt 2>&1; tail -5 /tmp/szb-cargo.txt)`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the tile browser in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand checks after the next release** (recorded for the user; not run here):
  - 🌐 on an agent tile opens a blank page with the address bar focused; typing `example.com` loads it.
  - The page follows the frame while dragging and resizing it, while resizing the sidebar, and after moving the tile to another window; it hides while dragging a tab and while a tab's context menu or the preset gallery is open.
  - Signing in to App Store Connect and to a Google account works; a "Sign in with Apple" popup opens and finishes.
  - `swarmz browse --url https://example.com --note "test"` from an agent tile opens it with the note; from another tile the 🌐 button pulses.
  - The main window's own page still fills the window after a child view is added (auto-resize).
