//! Each agent tile's browser (tile browser spec §3): a WebKit child view named `browse-<tile>` in
//! the swarmz window that shows the tile, placed over the frame the page draws.

pub const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
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

/// What may load in a view, in any frame: the web, plus the in-page schemes sites build frames
/// from. Local schemes (`file:`, swarmz's own) and app links (`mailto:`, `vscode:`) never do.
pub fn may_navigate(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Create,
    Place { reparent: bool },
    Nothing,
}

/// What `browser_show` does, given the window the view is in now (None: no view yet). A hide
/// never creates a view, and never moves one: the window a tile left hides it late, after the
/// window it went to has taken it.
pub fn show_step(view_window: Option<&str>, window: &str, visible: bool) -> Step {
    match view_window {
        None if visible => Step::Create,
        None => Step::Nothing,
        Some(w) if w == window => Step::Place { reparent: false },
        Some(_) if visible => Step::Place { reparent: true },
        Some(_) => Step::Nothing,
    }
}

/// Tiles whose browser was closed: a create still on its way (from another window, whose calls
/// are not ordered with the main window's) must not bring the view back. Opening clears it.
#[derive(Default)]
pub struct Closed {
    set: Mutex<HashSet<String>>,
}

impl Closed {
    pub fn close(&self, tile: &str) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).insert(tile.to_string());
    }
    pub fn reopen(&self, tile: &str) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).remove(tile);
    }
    pub fn may_create(&self, tile: &str) -> bool {
        !self.set.lock().unwrap_or_else(|e| e.into_inner()).contains(tile)
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.set.lock().unwrap_or_else(|e| e.into_inner())
    }
}

static CLOSED: LazyLock<Closed> = LazyLock::new(Closed::default);

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
    let load_tile = tile.to_string();
    let title_tile = tile.to_string();
    let (popup_app, popup_tile) = (app.clone(), tile.to_string());
    WebviewBuilder::new(view_label(tile), WebviewUrl::External(url))
        .user_agent(SAFARI_UA)
        // Called for every frame, not only the page: a refusal says nothing about the address.
        .on_navigation(may_navigate)
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
    let pos = LogicalPosition::new(rect.x, rect.y);
    let size = LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0));
    let view = app.get_webview(&view_label(&tile));
    let at = view.as_ref().map(|v| v.window().label().to_string());
    match show_step(at.as_deref(), &window, visible) {
        Step::Nothing => Ok(()),
        Step::Place { reparent } => {
            let view = view.ok_or("no view")?;
            if reparent {
                let win = app.get_window(&window).ok_or_else(|| format!("no window {window}"))?;
                view.reparent(&win).map_err(|e| e.to_string())?;
            }
            view.set_position(pos).map_err(|e| e.to_string())?;
            view.set_size(size).map_err(|e| e.to_string())?;
            let shown = if visible { view.show() } else { view.hide() };
            shown.map_err(|e| e.to_string())
        }
        Step::Create => {
            let win = app.get_window(&window).ok_or_else(|| format!("no window {window}"))?;
            let start = parse_address(&url)?;
            // Held across the create, so a close cannot slip between the check and the view.
            let closed = CLOSED.lock();
            if closed.contains(&tile) {
                return Ok(());
            }
            win.add_child(builder(&app, &tile, start), pos, size).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
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
    if action == "open" {
        // A browser opened (again) in the store: its view may be created from now on.
        CLOSED.reopen(&tile);
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
    let mut closed = CLOSED.lock();
    closed.insert(tile.clone());
    let view = app.get_webview(&view_label(&tile));
    drop(closed);
    if let Some(view) = view {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

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
    fn frames_may_use_blob_data_and_about_but_never_local_schemes() {
        for ok in ["https://x.com/", "http://localhost:3000/", "about:blank", "about:srcdoc", "blob:https://x.com/1", "data:text/html,hi"] {
            assert!(may_navigate(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in ["file:///etc/passwd", "tauri://localhost/", "ipc://localhost/x", "asset://localhost/x", "mailto:a@b.c", "vscode://file/x"] {
            assert!(!may_navigate(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn a_hide_never_moves_the_view_and_only_a_show_creates_it() {
        assert_eq!(show_step(None, "main", true), Step::Create);
        assert_eq!(show_step(None, "main", false), Step::Nothing);
        assert_eq!(show_step(Some("main"), "main", false), Step::Place { reparent: false });
        assert_eq!(show_step(Some("win-1"), "main", true), Step::Place { reparent: true });
        // The window the tile left hides it late, after the new window took it: leave it there.
        assert_eq!(show_step(Some("main"), "win-1", false), Step::Nothing);
    }

    #[test]
    fn a_close_wins_over_a_create_still_on_its_way() {
        let c = Closed::default();
        assert!(c.may_create("t1"));
        c.close("t1");
        assert!(!c.may_create("t1"));
        assert!(c.may_create("t2"));
        c.reopen("t1");
        assert!(c.may_create("t1"));
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
