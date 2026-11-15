#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(not(target_arch = "x86_64"))]
compile_error!("shad3 is built for x86_64 (x64) only");

mod media;
mod s3;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aws_sdk_s3::Client;
use aws_sdk_s3::primitives::ByteStream;
use s3::{Entry, Profile, Progress, TestResult, TextFile};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

const KEYRING_SERVICE: &str = "de.lovinoes.shad3";

fn keyring_entry(id: &str) -> Res<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| format!("System keyring: {e}"))
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Opener {
    /// "builtin", "system" (the desktop's default app), "custom" (`command`), or "download" (other files).
    mode: String,
    command: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// "system", "light" or "dark"
    theme: String,
    reduce_motion: bool,
    /// How to open each kind of file: "text", "image", "video", "audio", "other".
    openers: HashMap<String, Opener>,
    // Before openers existed; read once to migrate, never written again.
    #[serde(skip_serializing)]
    editor: String,
    #[serde(skip_serializing)]
    editor_command: String,
}

impl Settings {
    fn migrated(mut self) -> Self {
        if self.editor == "external" && !self.openers.contains_key("text") {
            self.openers.insert("text".into(), Opener { mode: "custom".into(), command: self.editor_command.clone() });
        }
        self
    }
}

/// Reads JSON, moving an unreadable file aside instead of overwriting it on the next save.
fn read_json<T: serde::de::DeserializeOwned + Default>(file: &Path) -> T {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            eprintln!("{}: {e}; moved aside", file.display());
            let _ = std::fs::rename(file, file.with_extension("json.broken"));
            T::default()
        }),
        Err(_) => T::default(),
    }
}

/// Writes atomically; on Linux readable only by the user.
fn write_json(file: &Path, value: &impl Serialize) -> Res<()> {
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(file.parent().unwrap())?;
        let tmp = file.with_extension("json.tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(value)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, file)
    };
    write().map_err(|e| format!("Could not save settings: {e}"))
}

/// One line in the activity history.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    /// Milliseconds since 1970.
    time: i64,
    /// "upload", "download", "delete", "rename", "create", "edit", "open" or "bucket"
    action: String,
    bucket: String,
    summary: String,
    #[serde(default)]
    detail: Option<String>,
    ok: bool,
}

/// History keeps the newest entries only.
const HISTORY_MAX: usize = 2000;

struct App {
    window_buttons: WindowButtons,
    history_file: PathBuf,
    history: Mutex<Vec<HistoryEntry>>,
    file: PathBuf,
    settings_file: PathBuf,
    settings: Mutex<Settings>,
    profiles: Mutex<Vec<Profile>>,
    clients: Mutex<HashMap<String, Client>>,
    /// Running transfers by the UI's id, so they can be cancelled.
    transfers: Mutex<HashMap<String, Arc<Progress>>>,
    secrets: Mutex<HashMap<String, String>>,
}

impl App {
    fn load(dir: &Path, window_buttons: WindowButtons) -> App {
        let (file, settings_file) = (dir.join("profiles.json"), dir.join("settings.json"));
        let history_file = dir.join("history.json");
        App {
            window_buttons,
            history: Mutex::new(read_json(&history_file)),
            history_file,
            profiles: Mutex::new(read_json(&file)),
            settings: Mutex::new(read_json::<Settings>(&settings_file).migrated()),
            file,
            settings_file,
            clients: Mutex::default(),
            transfers: Mutex::default(),
            secrets: Mutex::default(),
        }
    }

    fn persist(&self, profiles: &[Profile]) -> Res<()> {
        write_json(&self.file, &profiles)
    }

    /// The secret key from the system keyring (KWallet / GNOME Keyring), cached for the session.
    fn secret(&self, id: &str) -> Res<String> {
        if let Some(s) = self.secrets.lock().unwrap().get(id) {
            return Ok(s.clone());
        }
        let s = keyring_entry(id)?.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => "No secret key stored for this bucket. Edit it and enter the secret key.".to_owned(),
            e => format!("Could not read the secret key from the system keyring: {e}"),
        })?;
        self.secrets.lock().unwrap().insert(id.to_owned(), s.clone());
        Ok(s)
    }

    /// Cleans up the input; a blank secret from the UI means "keep the stored one".
    fn with_secret(&self, p: Profile) -> Res<Profile> {
        let mut p = p.normalized();
        if p.secret_key.is_empty() {
            p.secret_key = self.secret(&p.id)?;
        }
        p.validate()?;
        Ok(p)
    }

    fn conn(&self, id: &str) -> Res<(Client, String)> {
        let p = self.profiles.lock().unwrap().iter().find(|p| p.id == id).cloned().ok_or("Unknown bucket")?;
        if let Some(c) = self.clients.lock().unwrap().get(id) {
            return Ok((c.clone(), p.bucket.trim().to_owned()));
        }
        let p = self.with_secret(p)?;
        let client = p.client();
        self.clients.lock().unwrap().insert(id.to_owned(), client.clone());
        Ok((client, p.bucket.trim().to_owned()))
    }
}

#[tauri::command]
fn get_profiles(app: State<App>) -> Vec<Profile> {
    app.profiles.lock().unwrap().clone()
}

#[tauri::command]
fn save_profile(app: State<App>, profile: Profile) -> Res<Profile> {
    let profile = app.with_secret(profile)?;
    keyring_entry(&profile.id)?
        .set_password(&profile.secret_key)
        .map_err(|e| format!("Could not save the secret key to the system keyring: {e}"))?;
    app.secrets.lock().unwrap().insert(profile.id.clone(), profile.secret_key.clone());
    let mut profiles = app.profiles.lock().unwrap();
    let mut next = profiles.clone();
    match next.iter_mut().find(|p| p.id == profile.id) {
        Some(p) => *p = profile.clone(),
        None => next.push(profile.clone()),
    }
    app.persist(&next)?;
    *profiles = next;
    app.clients.lock().unwrap().remove(&profile.id);
    Ok(profile)
}

#[tauri::command]
fn delete_profile(app: State<App>, id: String) -> Res<()> {
    let mut profiles = app.profiles.lock().unwrap();
    let next: Vec<Profile> = profiles.iter().filter(|p| p.id != id).cloned().collect();
    app.persist(&next)?;
    *profiles = next;
    app.clients.lock().unwrap().remove(&id);
    app.secrets.lock().unwrap().remove(&id);
    match keyring_entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Removed, but the secret key could not be deleted from the system keyring: {e}")),
    }
}

#[tauri::command]
async fn test_connection(app: State<'_, App>, profile: Profile) -> Res<TestResult> {
    // Fill in a stored secret but test the raw input, so the result can say what it fixed.
    let secret = app.with_secret(profile.clone())?.secret_key;
    Ok(s3::test(&Profile { secret_key: secret, ..profile }).await)
}

#[tauri::command]
async fn create_bucket(app: State<'_, App>, profile: Profile) -> Res<()> {
    s3::create_bucket(&app.with_secret(profile)?).await
}

#[tauri::command]
async fn list(app: State<'_, App>, id: String, prefix: String) -> Res<Vec<Entry>> {
    let (c, bucket) = app.conn(&id)?;
    s3::list(&c, &bucket, &prefix).await
}

#[tauri::command]
async fn create_folder(app: State<'_, App>, id: String, key: String) -> Res<()> {
    let (c, bucket) = app.conn(&id)?;
    s3::create_folder(&c, &bucket, &key).await
}

#[tauri::command]
async fn delete(app: State<'_, App>, id: String, keys: Vec<String>) -> Res<usize> {
    let (c, bucket) = app.conn(&id)?;
    s3::delete(&c, &bucket, &keys).await
}

#[tauri::command]
async fn rename(app: State<'_, App>, id: String, from: String, to: String) -> Res<()> {
    let (c, bucket) = app.conn(&id)?;
    s3::rename(&c, &bucket, &from, &to).await
}

/// What the title bar should look like on this desktop.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WindowButtons {
    /// GTK-style "left:right", e.g. "appmenu:minimize,close" on GNOME. Empty on Windows.
    layout: String,
    /// XDG_CURRENT_DESKTOP, e.g. "GNOME", "KDE", "ubuntu:GNOME".
    desktop: String,
}

/// GTK knows the user's layout on every Linux desktop: GNOME's button-layout setting,
/// and KDE Plasma syncs its KWin buttons into it. Must run on the GTK main thread.
fn window_buttons() -> WindowButtons {
    #[cfg(target_os = "linux")]
    let layout = {
        use gtk::prelude::GtkSettingsExt;
        gtk::Settings::default().and_then(|s| s.gtk_decoration_layout()).map(|l| l.to_string()).unwrap_or_default()
    };
    #[cfg(not(target_os = "linux"))]
    let layout = String::new();
    WindowButtons { layout, desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default() }
}

/// Base URL of the local media streaming server (see media.rs).
struct MediaBase(String);

#[tauri::command]
fn media_base(base: State<MediaBase>) -> String {
    base.0.clone()
}

// shortcut: read once at startup; listen to gtk-decoration-layout changes if live updates are wanted.
#[tauri::command]
fn get_window_buttons(app: State<App>) -> WindowButtons {
    app.window_buttons.clone()
}

/// Newest first.
#[tauri::command]
fn get_history(app: State<App>) -> Vec<HistoryEntry> {
    app.history.lock().unwrap().iter().rev().cloned().collect()
}

#[tauri::command]
fn add_history(app: State<App>, entry: HistoryEntry) -> Res<()> {
    let mut h = app.history.lock().unwrap();
    h.push(entry);
    let extra = h.len().saturating_sub(HISTORY_MAX);
    h.drain(..extra);
    write_json(&app.history_file, &*h)
}

#[tauri::command]
fn clear_history(app: State<App>) -> Res<()> {
    let mut h = app.history.lock().unwrap();
    write_json(&app.history_file, &Vec::<HistoryEntry>::new())?;
    h.clear();
    Ok(())
}

#[tauri::command]
fn get_settings(app: State<App>) -> Settings {
    app.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: State<App>, settings: Settings) -> Res<()> {
    for (kind, o) in &settings.openers {
        match o.mode.as_str() {
            "builtin" | "system" | "download" => {}
            "custom" => {
                let argv = split_command(&o.command);
                let prog = argv.first().ok_or_else(|| format!("Enter the command for {kind} files"))?;
                find_program(prog).ok_or_else(|| format!("Can't find the program \"{prog}\". Use Browse to pick it, or check the name."))?;
            }
            other => return Err(format!("Unknown open mode {other}")),
        }
    }
    write_json(&app.settings_file, &settings)?;
    *app.settings.lock().unwrap() = settings;
    Ok(())
}

/// None when the file is binary or too big for the built-in editor.
#[tauri::command]
async fn read_text(app: State<'_, App>, id: String, key: String) -> Res<Option<TextFile>> {
    let (c, bucket) = app.conn(&id)?;
    s3::read_text(&c, &bucket, &key).await
}

#[tauri::command]
async fn object_info(app: State<'_, App>, id: String, key: String) -> Res<s3::ObjectInfo> {
    let (c, bucket) = app.conn(&id)?;
    s3::info(&c, &bucket, &key).await
}

#[tauri::command]
async fn create_file(app: State<'_, App>, id: String, key: String) -> Res<()> {
    let (c, bucket) = app.conn(&id)?;
    s3::create_file(&c, &bucket, &key).await
}

/// Saves editor content; `etag` None overwrites whatever is on the server.
#[tauri::command]
async fn write_text(app: State<'_, App>, id: String, key: String, text: String, etag: Option<String>) -> Res<Option<String>> {
    let (c, bucket) = app.conn(&id)?;
    s3::put_preserving(&c, &bucket, &key, ByteStream::from(text.into_bytes()), etag.as_deref()).await
}

/// Resolves a program name like a shell: a path is used as is, a bare name is searched in PATH
/// (on Windows also with PATHEXT, so `code` finds `code.cmd`, which Command::new alone would not).
fn find_program(prog: &str) -> Option<PathBuf> {
    let p = Path::new(prog);
    if p.components().count() > 1 || p.is_absolute() {
        return p.is_file().then(|| p.to_owned());
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into()).split(';').map(str::to_owned).collect()
    } else {
        Vec::new()
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        std::iter::once(dir.join(prog))
            .chain(exts.iter().map(|e| dir.join(format!("{prog}{e}"))))
            .find(|c| c.is_file())
    })
}

/// Splits a command line like a shell would for quotes: `"C:\Program Files\x.exe" -n` -> 2 words.
fn split_command(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut quoted) = (Vec::new(), String::new(), None, false);
    for ch in s.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => (quote, quoted) = (Some(ch), true),
            None if ch.is_whitespace() => {
                if quoted || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    quoted = false;
                }
            }
            None => cur.push(ch),
        }
    }
    if quoted || !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExternalSaved {
    bucket: String,
    key: String,
    error: Option<String>,
}

/// The desktop's "open with default app" command for a file path or URL.
fn system_open(target: &str) -> Vec<String> {
    let opener = if cfg!(windows) { "explorer" } else { "xdg-open" };
    vec![opener.into(), target.into()]
}

/// Starts a program without waiting for it (a thread reaps it so no zombie is left).
fn spawn(argv: &[String]) -> Res<()> {
    let prog = find_program(&argv[0]).ok_or_else(|| format!("Can't find the program \"{}\". Check Settings.", argv[0]))?;
    let mut child = std::process::Command::new(prog)
        .args(&argv[1..])
        .spawn()
        .map_err(|e| format!("Could not start \"{}\": {e}", argv[0]))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Puts text on the system clipboard. On Linux via GTK (reliable on Wayland and X11, which the
/// webview's clipboard API is not everywhere); elsewhere the UI uses the web clipboard instead.
#[tauri::command]
fn copy_text(handle: AppHandle, text: String) -> Res<()> {
    #[cfg(target_os = "linux")]
    return handle
        .run_on_main_thread(move || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            clipboard.set_text(&text);
            clipboard.store();
        })
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (handle, text);
        Err("Use the web clipboard".into())
    }
}

/// Opens a link in the browser; only https, so nothing else can be launched this way.
#[tauri::command]
fn open_url(url: String) -> Res<()> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    spawn(&system_open(&url))
}

/// "dark" or "light" as the desktop prefers it (XDG portal: GNOME, KDE and others), "" if unknown.
#[tauri::command]
async fn system_theme() -> String {
    #[cfg(target_os = "linux")]
    {
        use dbus::arg::RefArg;
        // ReadOne gives variant(u32); the older Read gives variant(variant(u32)).
        fn num(a: &dyn RefArg) -> Option<u64> {
            a.as_u64().or_else(|| a.as_iter()?.next().and_then(num))
        }
        let read = || -> Option<u64> {
            let conn = dbus::blocking::Connection::new_session().ok()?;
            let proxy = conn.with_proxy("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", Duration::from_millis(500));
            let args = ("org.freedesktop.appearance", "color-scheme");
            let (v,): (dbus::arg::Variant<Box<dyn RefArg>>,) = proxy
                .method_call("org.freedesktop.portal.Settings", "ReadOne", args)
                .or_else(|_| proxy.method_call("org.freedesktop.portal.Settings", "Read", args))
                .ok()?;
            num(&v)
        };
        return match tokio::task::spawn_blocking(read).await.ok().flatten() {
            Some(1) => "dark".into(),
            Some(2) => "light".into(),
            _ => String::new(),
        };
    }
    #[allow(unreachable_code)]
    String::new()
}

/// Opens a file in the app chosen in Settings for its kind ("system" default app or a "custom"
/// command). Videos and audio stream to custom players (VLC, mpv…) from the local media server;
/// everything else is downloaded to a temp folder and uploaded again whenever the app saves it.
#[tauri::command]
async fn open_external(handle: AppHandle, app: State<'_, App>, media: State<'_, MediaBase>, id: String, key: String, kind: String) -> Res<()> {
    let opener = app.settings.lock().unwrap().openers.get(&kind).cloned().unwrap_or_default();
    let mut argv = match opener.mode.as_str() {
        "custom" => split_command(&opener.command),
        "system" => vec![],
        _ => return Err("This file type opens inside shad3. Change it in Settings → Open with.".into()),
    };
    if opener.mode == "custom" && argv.is_empty() {
        return Err("Set a command for this file type in Settings → Open with".into());
    }
    let (c, bucket) = app.conn(&id)?;
    if opener.mode == "custom" && (kind == "video" || kind == "audio") {
        let url = format!("{}/{id}/{}", media.0, media::hex(&key));
        if !argv.iter().any(|a| a.contains("{file}")) {
            argv.push("{file}".into());
        }
        return spawn(&argv.iter().map(|a| a.replace("{file}", &url)).collect::<Vec<_>>());
    }
    let name = key.rsplit('/').next().filter(|n| !n.is_empty()).ok_or("Not a file")?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    // shortcut: temp copies stay in the cache folder; clean old ones at startup if it grows too much.
    let dir = handle.path().app_cache_dir().map_err(|e| e.to_string())?.join("edit").join(format!("{nanos:x}"));
    let path = s3::safe_join(&dir, name)?;
    let etag = c.head_object().bucket(&bucket).key(&key).send().await.map_err(s3::fmt_err)?.e_tag().map(str::to_owned);
    s3::download_file(&c, &bucket, &key, &path, &Progress::default()).await?;

    let file = path.to_string_lossy().into_owned();
    if argv.is_empty() {
        argv = system_open(&file);
    } else {
        if !argv.iter().any(|a| a.contains("{file}")) {
            argv.push("{file}".into());
        }
        argv = argv.iter().map(|a| a.replace("{file}", &file)).collect();
    }
    spawn(&argv)?;
    tokio::spawn(watch_and_upload(handle, c, bucket, key, path, etag));
    Ok(())
}

async fn watch_and_upload(handle: AppHandle, c: Client, bucket: String, key: String, path: PathBuf, mut etag: Option<String>) {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut last = mtime(&path);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let now = mtime(&path);
        if now.is_none() || now == last {
            continue;
        }
        // Let the editor finish writing before uploading.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if mtime(&path) != now {
            continue;
        }
        last = now;
        let res = match ByteStream::from_path(&path).await {
            Ok(body) => s3::put_preserving(&c, &bucket, &key, body, etag.as_deref()).await,
            Err(e) => Err(e.to_string()),
        };
        let error = match res {
            Ok(new) => {
                etag = new;
                None
            }
            Err(e) if e == s3::CONFLICT => Some(format!(
                "changed on the server since you opened it, so your edit was not uploaded. Your copy is at {}",
                path.display()
            )),
            Err(e) => Some(e),
        };
        let _ = handle.emit("external-saved", ExternalSaved { bucket: bucket.clone(), key: key.clone(), error });
    }
}

/// Keeps a transfer cancellable while it runs; unregisters itself when the command ends.
struct Registered<'a>(&'a App, String);

impl<'a> Registered<'a> {
    fn new(app: &'a App, id: String, prog: Arc<Progress>) -> Self {
        app.transfers.lock().unwrap().insert(id.clone(), prog);
        Registered(app, id)
    }
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.0.transfers.lock().unwrap().remove(&self.1);
    }
}

/// Stops a running upload or download after the file, part or chunk in progress.
#[tauri::command]
fn cancel_transfer(app: State<App>, transfer_id: String) {
    if let Some(p) = app.transfers.lock().unwrap().get(&transfer_id) {
        p.cancelled.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick {
    bytes: u64,
    total: u64,
    files: u64,
    files_total: u64,
}

/// Runs `work` while sending the progress counters to the UI four times a second.
async fn with_progress<T>(prog: &Progress, ch: &Channel<Tick>, work: impl Future<Output = T>) -> T {
    let send = || {
        let _ = ch.send(Tick {
            bytes: prog.bytes.load(Ordering::Relaxed),
            total: prog.total.load(Ordering::Relaxed),
            files: prog.files.load(Ordering::Relaxed),
            files_total: prog.files_total.load(Ordering::Relaxed),
        });
    };
    let ticker = async {
        loop {
            send();
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let out = tokio::select! { out = work => out, _ = ticker => unreachable!() };
    send();
    out
}

/// Upload targets that already exist (relative keys), so the UI can ask what to do.
#[tauri::command]
async fn upload_conflicts(app: State<'_, App>, id: String, paths: Vec<PathBuf>, prefix: String) -> Res<Vec<String>> {
    let (c, bucket) = app.conn(&id)?;
    // An existing empty-folder marker is identical to the new one, so it is no conflict.
    let mut keys: Vec<String> = s3::existing(&c, &bucket, &paths, &prefix).await?.into_iter().filter(|k| !k.ends_with('/')).collect();
    keys.sort();
    Ok(keys)
}

/// `decisions` says per clashing key what to do: "replace", "skip", or "rename" (uploads as
/// "name (1).ext"). Clashes without a decision (they appeared after the user was asked) are
/// renamed, so nothing is overwritten unasked. Returns the files that failed; the rest are uploaded.
#[tauri::command]
async fn upload(
    app: State<'_, App>,
    id: String,
    paths: Vec<PathBuf>,
    prefix: String,
    decisions: HashMap<String, String>,
    transfer_id: String,
    on_progress: Channel<Tick>,
) -> Res<Vec<String>> {
    let (c, bucket) = app.conn(&id)?;
    let (p, pre) = (paths.clone(), prefix.clone());
    let planned = tokio::task::spawn_blocking(move || s3::collect_uploads(&p, &pre)).await.map_err(|e| e.to_string())??;
    let existing = s3::existing(&c, &bucket, &paths, &prefix).await?;
    let mut taken: std::collections::HashSet<String> = planned.iter().map(|f| f.1.clone()).collect();
    taken.extend(existing.iter().cloned());
    let mut files = Vec::with_capacity(planned.len());
    for mut f in planned {
        if !existing.contains(&f.1) {
            files.push(f);
            continue;
        }
        if f.1.ends_with('/') {
            continue; // that empty folder is already there
        }
        match decisions.get(&f.1).map_or("rename", String::as_str) {
            "replace" => files.push(f),
            "skip" => {}
            "rename" => {
                let mut n = 1;
                f.1 = loop {
                    let candidate = s3::numbered(&f.1, n);
                    if !taken.contains(&candidate) && !s3::exists(&c, &bucket, &candidate).await? {
                        break candidate;
                    }
                    n += 1;
                };
                taken.insert(f.1.clone());
                files.push(f);
            }
            other => return Err(format!("Unknown conflict decision {other}")),
        }
    }
    let prog = Arc::new(Progress::default());
    let _registered = Registered::new(&app, transfer_id, prog.clone());
    prog.total.store(files.iter().map(|f| f.2).sum(), Ordering::Relaxed);
    prog.files_total.store(files.len() as u64, Ordering::Relaxed);
    let work = s3::run_parallel(files, prog.clone(), |(path, key, size)| {
        let (c, bucket, prog) = (&c, &bucket, &*prog);
        async move { s3::upload_entry(c, bucket, &path, &key, size, prog).await.map_err(|e| format!("{key}: {e}")) }
    });
    let failed = with_progress(&prog, &on_progress, work).await;
    if prog.cancelled.load(Ordering::Relaxed) {
        return Err(s3::CANCELLED.into());
    }
    Ok(failed)
}

/// Downloads into `dest`; returns the files that failed.
#[tauri::command]
async fn download(
    app: State<'_, App>,
    id: String,
    keys: Vec<String>,
    dest: PathBuf,
    transfer_id: String,
    on_progress: Channel<Tick>,
) -> Res<Vec<String>> {
    let (c, bucket) = app.conn(&id)?;
    let plan = s3::plan_download(&c, &bucket, &keys, &dest).await?;
    let prog = Arc::new(Progress::default());
    let _registered = Registered::new(&app, transfer_id, prog.clone());
    prog.total.store(plan.iter().map(|f| f.2).sum(), Ordering::Relaxed);
    prog.files_total.store(plan.len() as u64, Ordering::Relaxed);
    let work = s3::run_parallel(plan, prog.clone(), |(key, path, _)| {
        let (c, bucket, prog) = (&c, &bucket, &*prog);
        async move { s3::download_entry(c, bucket, &key, &path, prog).await.map_err(|e| format!("{key}: {e}")) }
    });
    let failed = with_progress(&prog, &on_progress, work).await;
    if prog.cancelled.load(Ordering::Relaxed) {
        return Err(s3::CANCELLED.into());
    }
    Ok(failed)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // setup runs on the main thread, where GTK may be queried.
            app.manage(App::load(&app.path().app_config_dir()?, window_buttons()));
            let base = media::start(app.handle().clone())?;
            #[cfg(debug_assertions)]
            eprintln!("media server: {base}");
            app.manage(MediaBase(base));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profiles,
            save_profile,
            delete_profile,
            test_connection,
            create_bucket,
            list,
            create_folder,
            delete,
            rename,
            upload,
            upload_conflicts,
            cancel_transfer,
            download,
            get_settings,
            save_settings,
            get_window_buttons,
            media_base,
            system_theme,
            open_url,
            copy_text,
            get_history,
            add_history,
            clear_history,
            read_text,
            write_text,
            create_file,
            object_info,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("failed to start shad3");
}

#[cfg(test)]
mod tests {
    #[test]
    fn split_command() {
        assert_eq!(super::split_command("code --wait"), ["code", "--wait"]);
        assert_eq!(super::split_command(r#""C:\Program Files\Ed\ed.exe"  -n "{file}" ''"#), [r"C:\Program Files\Ed\ed.exe", "-n", "{file}", ""]);
        assert!(super::split_command("   ").is_empty());
    }

    /// Whatever the desktop says, the answer is one of these (prints it with --nocapture).
    #[tokio::test]
    async fn system_theme() {
        let t = super::system_theme().await;
        println!("system theme: {t:?}");
        assert!(["dark", "light", ""].contains(&t.as_str()));
    }

    #[test]
    fn find_program() {
        let sh = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(super::find_program(sh).is_some());
        assert!(super::find_program("definitely-not-a-program-shad3").is_none());
        let full = super::find_program(sh).unwrap();
        assert_eq!(super::find_program(full.to_str().unwrap()), Some(full));
    }
}
