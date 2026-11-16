import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Channel } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  File,
  FileX,
  FileCode,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Info,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash,
  Upload,
  X,
} from "lucide-react";
import { api, CANCELLED, errText, formatSize, MAX_EDIT, nameError, opener, type Entry, type FileKind, type Profile, type Settings, type Tick } from "./api";
import { ConflictDialog, type Decisions } from "./ConflictDialog";
import type { Log } from "./history";
import { EditorPanel, type OpenFile } from "./EditorPanel";
import { MediaViewer, mediaKind } from "./MediaViewer";
import { PropertiesDialog } from "./PropertiesDialog";
import { Button, Checkbox, ConfirmDialog, Input, MOTION_MS, Presence, PromptDialog, cn } from "./ui";

/** Runs a transfer with progress in the sidebar; resolves with the files that failed. */
/** `bucketId` marks an upload, so that bucket's file list can show its progress. */
export type RunTransfer = (label: string, fn: (ch: Channel<Tick>, transferId: string) => Promise<string[]>, bucketId?: string) => Promise<string[]>;
type Notify = (msg: string, kind?: "error" | "ok") => void;
type SortKey = "name" | "size" | "modified";

// Never offered for editing: binaries by extension. SVG is both an image and text, so it stays editable.
const BINARY = new Set(
  "zip tar gz tgz bz2 xz zst 7z rar iso img dmg pdf doc docx xls xlsx ppt pptx odt ods odp exe dll so dylib bin dat class jar war apk aab deb rpm msi pkg woff woff2 ttf otf eot psd ai sketch fig xcf blend parquet avro orc sqlite sqlite3 db mdb pyc o a lib wasm".split(" "),
);
const ext = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** Row identity for selection: the key, or the upload id for an unfinished upload (a key can have several). */
const rid = (e: Entry) => (e.uploadId ? `upload:${e.uploadId}` : e.key);

// shortcut: renders at most this many rows; virtualize the list if huge folders must be scrolled instead of filtered.
const MAX_ROWS = 3000;

export function Browser({
  profile,
  settings,
  notify,
  runTransfer,
  log,
  uploading,
  onEdit,
}: {
  profile: Profile;
  settings: Settings;
  notify: Notify;
  runTransfer: RunTransfer;
  log: Log;
  /** [key, bytes, total] of items being uploaded into this bucket. */
  uploading: [string, number, number][];
  onEdit: () => void;
}) {
  const id = profile.id;
  const [prefix, setPrefix] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The row shift-click extends from, kept by key so sorting or filtering can't move it.
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; n: number } | null>(null);
  const [dialog, setDialog] = useState<null | "folder" | "file" | "rename" | "delete">(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<OpenFile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [properties, setProperties] = useState<Entry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);

  const busy = useRef(false);
  const lastCount = useRef(0);
  /** `quiet`: the live refresh; no spinner, keeps the list on errors, skips while a check runs. */
  const load = useCallback(async (quiet = false) => {
    // shortcut: huge folders aren't live (each check would be many list calls); F5 still works.
    if (quiet && (busy.current || lastCount.current > MAX_ROWS)) return;
    const seq = ++loadSeq.current;
    busy.current = true;
    if (!quiet) setLoading(true);
    try {
      const list = await api.list(id, prefix);
      if (seq !== loadSeq.current) return; // a newer folder was opened meanwhile
      setEntries(list);
      lastCount.current = list.length;
      setError(null);
      setSelected((sel) => new Set(list.filter((e) => sel.has(rid(e))).map(rid)));
    } catch (e) {
      if (seq === loadSeq.current && !quiet) setError(errText(e));
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        busy.current = false;
      }
    }
  }, [id, prefix]);

  // Live view: quietly re-check the open folder while the window is in use, and on coming back.
  useEffect(() => {
    const check = () => document.hasFocus() && !document.hidden && actRef.current.load(true);
    const t = setInterval(check, 5000);
    addEventListener("focus", check);
    return () => {
      clearInterval(t);
      removeEventListener("focus", check);
    };
  }, []);

  // Uploads into this folder: [bytes, total] by key; shown as rows until they exist.
  const pending = new Map(
    uploading
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length, -1).includes("/"))
      .map(([k, bytes, total]) => [k, [bytes, total]] as const),
  );
  const pendingKeys = [...pending.keys()].join("\n");
  /** Rows of uploads still running: shown, but not selectable (resuming or deleting one would break it). */
  const busyRow = (e: Entry) => e.pending || pending.has(e.key);

  useEffect(() => {
    load();
  }, [load]);

  const go = (p: string) => {
    setPrefix(p);
    setSelected(new Set());
    setAnchor(null);
    setFilter("");
    setEntries([]);
  };

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const dir = sort.asc ? 1 : -1;
    const known = new Set(entries.map((e) => e.key));
    const extra: Entry[] = (pendingKeys ? pendingKeys.split("\n") : [])
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, name: k.slice(prefix.length).replace(/\/$/, ""), isDir: k.endsWith("/"), size: 0, modified: null, pending: true }));
    return [...entries, ...extra]
      .filter((e) => !f || e.name.toLowerCase().includes(f))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        const d =
          sort.key === "size" ? a.size - b.size : sort.key === "modified" ? (a.modified ?? 0) - (b.modified ?? 0) : 0;
        return (d || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })) * dir;
      });
  }, [entries, filter, sort, pendingKeys, prefix]);
  const anchorAt = anchorKey === null ? -1 : rows.findIndex((r) => rid(r) === anchorKey);
  const anchor = anchorAt >= 0 ? anchorAt : null;
  const setAnchor = (i: number | null) => setAnchorKey(i === null || !rows[i] ? null : rid(rows[i]));

  const sel = rows.filter((e) => !busyRow(e) && selected.has(rid(e)));
  // Finished files and folders vs. unfinished uploads, which can only be deleted.
  const real = sel.filter((e) => !e.uploadId);
  const broken = sel.filter((e) => e.uploadId);
  const single = sel.length === 1 ? sel[0] : null;

  // ---- actions ----
  // Name clashes are asked about first, file by file, like a file manager.
  const [clash, setClash] = useState<{ keys: string[]; prefix: string; resolve: (d: Decisions | null) => void } | null>(null);
  const upload = async (paths: string[] | null) => {
    if (!paths?.length) return;
    const target = prefix;
    let decisions: Decisions = {};
    try {
      const clashes = await api.uploadConflicts(id, paths, target);
      if (clashes.length) {
        const d = await new Promise<Decisions | null>((resolve) => setClash({ keys: clashes, prefix: target, resolve }));
        if (!d) return;
        decisions = d;
      }
    } catch (e) {
      log({ action: "upload", bucket: profile.bucket, summary: `Could not upload ${paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} items`}`, detail: `Checking for existing files failed: ${errText(e)}`, ok: false });
      return notify(`Could not check for existing files: ${errText(e)}`);
    }
    const label = paths.length === 1 ? paths[0].split(/[\\/]/).pop()! : `${paths.length} items`;
    const failed = await runTransfer(`Upload ${label}`, (ch, tid) => api.upload(id, paths, target, decisions, tid, ch), id);
    const cancelled = failed[0] === CANCELLED;
    log({
      action: "upload",
      bucket: profile.bucket,
      summary: cancelled ? `Cancelled upload of ${label}` : `Uploaded ${label}`,
      detail: cancelled ? "Files finished before the cancel stay in the bucket" : failed.length ? `${failed.length} failed: ${failed[0]}` : `to /${target}`,
      ok: !failed.length,
    });
    actRef.current.load(); // the folder shown now, which may not be the one uploaded into
  };
  /** Continues an unfinished upload; the server checks the picked file is the same one. */
  const resume = async (e: Entry) => {
    const path = await openDialog({ title: `Pick the local copy of ${e.name}` });
    if (typeof path !== "string") return;
    const failed = await runTransfer(`Resume ${e.name}`, (ch, tid) => api.resumeUpload(id, e.key, e.uploadId!, path, tid, ch), id);
    const cancelled = failed[0] === CANCELLED;
    log({
      action: "upload",
      bucket: profile.bucket,
      summary: cancelled ? `Cancelled resuming ${e.name}` : failed.length ? `Could not resume ${e.name}` : `Resumed upload of ${e.name}`,
      detail: cancelled ? "It stays unfinished and can be resumed again" : failed[0] ?? `to /${e.key}`,
      ok: !failed.length,
    });
    actRef.current.load();
  };
  const pickUpload = async (directory: boolean) => {
    const res = await openDialog({ multiple: true, directory, title: directory ? "Upload folders" : "Upload files" });
    upload(res as string[] | null);
  };
  const download = async (items: Entry[]) => {
    if (!items.length) return;
    const dest = await openDialog({ directory: true, title: "Download to…", defaultPath: await downloadDir().catch(() => undefined) });
    if (typeof dest !== "string") return;
    const label = items.length === 1 ? items[0].name : `${items.length} items`;
    const failed = await runTransfer(`Download ${label}`, (ch, tid) => api.download(id, items.map((e) => e.key), dest, tid, ch));
    const cancelled = failed[0] === CANCELLED;
    log({
      action: "download",
      bucket: profile.bucket,
      summary: cancelled ? `Cancelled download of ${label}` : `Downloaded ${label}`,
      detail: cancelled ? `Files finished before the cancel are in ${dest}` : failed.length ? `${failed.length} failed: ${failed[0]}` : `to ${dest}`,
      ok: !failed.length,
    });
  };
  /** Opens a file in the app Settings chose for its kind (default app or custom command). */
  const external = async (e: Entry, kind: FileKind) => {
    setOpening(e.key);
    try {
      await api.openExternal(id, e.key, kind);
      const o = opener(settings, kind);
      const streamed = (kind === "video" || kind === "audio") && o.mode === "custom";
      notify(streamed ? `Playing ${e.name}` : `Opened ${e.name}. Saving it there uploads it again.`, "ok");
      // The program's file name, also for quoted paths with spaces.
      const prog = o.command.match(/^"([^"]+)"|^\S+/)?.slice(1).find(Boolean) ?? o.command.split(" ")[0];
      const app = o.mode === "system" ? "the default app" : prog.split(/[\\/]/).pop();
      log({ action: "open", bucket: profile.bucket, summary: `Opened ${e.name} in ${app}`, detail: `/${e.key}`, ok: true });
    } catch (err) {
      notify(errText(err));
      log({ action: "open", bucket: profile.bucket, summary: `Could not open ${e.name}`, detail: errText(err), ok: false });
    } finally {
      setOpening(null);
    }
  };
  /** Text files: built-in editor or the external app from Settings; `fallback` downloads non-text files. */
  const editFile = async (e: Entry, fallback = false) => {
    if (opener(settings, "text").mode !== "builtin") return external(e, "text");
    setOpening(e.key);
    try {
      const f = await api.readText(id, e.key);
      if (f) setEditing({ key: e.key, name: e.name, etag: f.etag, text: f.text });
      else if (fallback) download([e]);
      else notify(`"${e.name}" is not a text file or is bigger than 5 MB, so it can't be opened in the editor.`);
    } catch (err) {
      notify(errText(err));
      log({ action: "open", bucket: profile.bucket, summary: `Could not open ${e.name} in the editor`, detail: errText(err), ok: false });
    } finally {
      setOpening(null);
    }
  };
  const media = useMemo(() => rows.filter((r) => !r.isDir && !r.uploadId && mediaKind(r.name)), [rows]);
  const view = (e: Entry) => setViewing(media.findIndex((m) => m.key === e.key));
  const kindOf = (e: Entry): FileKind => mediaKind(e.name) ?? (BINARY.has(ext(e.name)) ? "other" : "text");
  // The built-in editor has a size limit; an external app gets any text file (SVG is text too).
  const canEdit = (e: Entry) =>
    !e.isDir &&
    !e.uploadId && (kindOf(e) === "text" || ext(e.name) === "svg") && (opener(settings, "text").mode !== "builtin" || e.size <= MAX_EDIT);
  const canOpen = (e: Entry) => e.isDir || !e.uploadId && kindOf(e) !== "text" && (kindOf(e) !== "other" || opener(settings, "other").mode !== "download");
  /** Double-click / Enter: folders open, everything else goes where Settings → Open with says. */
  const openEntry = (e: Entry) => {
    if (e.isDir) return go(e.key);
    if (e.uploadId) return resume(e);
    const kind = kindOf(e);
    const { mode } = opener(settings, kind);
    if (mode === "system" || mode === "custom") return external(e, kind);
    if (kind === "text") return canEdit(e) ? editFile(e, true) : download([e]);
    if (kind === "other") return download([e]);
    view(e);
  };

  const closeMenu = useCallback(() => setMenu(null), []);
  const actRef = useRef({ upload, load });
  actRef.current = { upload, load };

  // Files dragged in from the desktop.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const t = ev.payload.type;
      setDragging(t === "enter" || t === "over");
      if (t === "drop") actRef.current.upload(ev.payload.paths);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---- selection ----
  // Rubber band selection: drag anywhere in the list; Ctrl/Shift adds to the selection.
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const suppressClick = useRef(false);
  const startBand = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (e.target === e.currentTarget && !additive) setSelected(new Set());
    const list = listRef.current!;
    const at = (x: number, y: number) => {
      const b = list.getBoundingClientRect();
      return { x: x - b.left + list.scrollLeft, y: y - b.top + list.scrollTop };
    };
    const start = at(e.clientX, e.clientY);
    const base = additive ? new Set(selected) : new Set<string>();
    let pointer = { x: e.clientX, y: e.clientY };
    let active = false;
    const update = () => {
      const p = at(pointer.x, pointer.y);
      if (!active && Math.hypot(p.x - start.x, p.y - start.y) < 5) return; // still a click
      active = true;
      const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      setBand(r);
      const next = new Set(base);
      list.querySelectorAll<HTMLElement>("[data-i]").forEach((el) => {
        if (el.offsetTop < r.y + r.h && el.offsetTop + el.offsetHeight > r.y) {
          const e = rows[+el.dataset.i!];
          if (!busyRow(e)) next.add(rid(e));
        }
      });
      setSelected(next);
    };
    const move = (ev: MouseEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      update();
    };
    // Scrolls while the pointer is held near the top or bottom edge.
    const scroller = setInterval(() => {
      if (!active) return;
      const b = list.getBoundingClientRect();
      const d = pointer.y < b.top + 40 ? -14 : pointer.y > b.bottom - 16 ? 14 : 0;
      if (d) {
        list.scrollTop += d;
        update();
      }
    }, 16);
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      clearInterval(scroller);
      setBand(null);
      if (active) {
        suppressClick.current = true; // the click that ends a drag must not reset the selection
        setTimeout(() => (suppressClick.current = false));
      }
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };

  const toggle = (key: string, i: number) => {
    const next = new Set(selected);
    next.has(key) ? next.delete(key) : next.add(key);
    setSelected(next);
    setAnchor(i);
  };
  const allState = !rows.length || !sel.length ? false : sel.length === rows.length ? true : "mixed";

  const click = (e: React.MouseEvent, entry: Entry, i: number) => {
    if (suppressClick.current) return;
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSelected(new Set(rows.slice(a, b + 1).map(rid)));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(rid(entry)) ? next.delete(rid(entry)) : next.add(rid(entry));
      setSelected(next);
      setAnchor(i);
    } else {
      setSelected(new Set([rid(entry)]));
      setAnchor(i);
    }
  };

  const parent = prefix.replace(/[^/]*\/$/, "");
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "Delete" && sel.length) setDialog("delete");
    else if (k === "F2" && single && !single.uploadId) setDialog("rename");
    else if (k === "Enter" && e.altKey && single && !single.uploadId) setProperties(single);
    else if (k === "Enter" && single) openEntry(single);
    else if ((k === "Backspace" || (e.altKey && k === "ArrowUp")) && prefix) go(parent);
    else if (k === "a" && (e.ctrlKey || e.metaKey)) setSelected(new Set(rows.filter((e) => !busyRow(e)).map(rid)));
    else if (k === "Escape") setSelected(new Set());
    else if (k === "F5") load();
    else if (k === "ArrowDown" || k === "ArrowUp") {
      const cur = anchor ?? -1;
      const i = Math.max(0, Math.min(rows.length - 1, cur + (k === "ArrowDown" ? 1 : -1)));
      if (!rows[i]) return;
      setSelected(new Set([rid(rows[i])]));
      setAnchor(i);
      listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
    } else return;
    e.preventDefault();
  };

  const crumbs = prefix.split("/").filter(Boolean);
  const sortBy = (key: SortKey) => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));
  const SortIcon = ({ k }: { k: SortKey }) => (sort.key === k ? sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null);

  return (
    <div className="@container relative flex min-w-0 flex-1 animate-fade flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Folder path">
          <button className="min-w-0 truncate rounded px-1.5 py-0.5 font-bold hover:bg-accent" onClick={() => go("")} title={profile.bucket}>
            {profile.bucket}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <button
                className="truncate rounded px-1.5 py-0.5 hover:bg-accent"
                onClick={() => go(crumbs.slice(0, i + 1).join("/") + "/")}
                title={c}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative w-32 shrink-0 @4xl:w-48">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-9 pl-8" aria-label="Filter this folder" />
        </div>
        <Button variant="outline" size="icon" className="size-9" onClick={() => load()} aria-label="Refresh" title="Refresh (F5)">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
        <Button variant="outline" className="px-2.5 @3xl:px-4" onClick={() => setDialog("folder")} title="New folder" aria-label="New folder">
          <FolderPlus /> <span className="hidden @3xl:inline">New folder</span>
        </Button>
        <Button variant="outline" className="px-2.5" onClick={() => pickUpload(true)} title="Upload folders" aria-label="Upload folders">
          <FolderUp />
        </Button>
        <Button className="px-2.5 @3xl:px-4" onClick={() => pickUpload(false)} title="Upload files" aria-label="Upload files">
          <Upload /> <span className="hidden @3xl:inline">Upload</span>
        </Button>
      </div>

      {/* Selection actions float over the list, so rows never jump when a selection starts. */}
      <Presence
        show={sel.length > 0}
        enter="animate-rise"
        className="absolute bottom-11 left-1/2 z-30 -translate-x-1/2"
      >
        <div className="flex items-center gap-1 rounded-lg border bg-popover p-1.5 pl-3 text-sm shadow-2xl">
          <span className="mr-1 whitespace-nowrap text-muted-foreground">{sel.length} selected</span>
          {real.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => download(real)} title="Download">
              <Download /> <span className="hidden @2xl:inline">Download</span>
            </Button>
          )}
          {single && canOpen(single) && (
            <Button variant="ghost" size="sm" onClick={() => openEntry(single)} title="Open">
              <FolderOpen /> <span className="hidden @2xl:inline">Open</span>
            </Button>
          )}
          {single && canEdit(single) && (
            <Button variant="ghost" size="sm" onClick={() => editFile(single)} title="Edit">
              <FileCode /> <span className="hidden @2xl:inline">Edit</span>
            </Button>
          )}
          {single && !single.uploadId && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("rename")} title="Rename">
              <Pencil /> <span className="hidden @2xl:inline">Rename</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDialog("delete")} title="Delete">
            <Trash /> <span className="hidden @2xl:inline">Delete</span>
          </Button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button variant="ghost" size="icon" onClick={() => setSelected(new Set())} aria-label="Clear selection" title="Clear selection (Esc)">
            <X />
          </Button>
        </div>
      </Presence>

      {/* list */}
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKey}
        onMouseDown={startBand}
        onContextMenu={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) setSelected(new Set());
          setMenu({ x: e.clientX, y: e.clientY, n: performance.now() });
        }}
        className="relative flex-1 overflow-auto outline-none"
        role="grid"
        aria-label="Files"
      >
        <div className="sticky top-0 z-10 grid grid-cols-[1rem_1fr_6rem] @2xl:grid-cols-[1rem_1fr_7rem_11rem] items-center gap-3 border-b bg-background px-4 py-2 text-xs font-medium text-muted-foreground">
          <Checkbox
            checked={allState}
            onChange={(v) => setSelected(v ? new Set(rows.filter((e) => !busyRow(e)).map(rid)) : new Set())}
            label={allState === true ? "Deselect all" : "Select all"}
            className={cn(!rows.length && "invisible")}
          />
          {(["name", "size", "modified"] as const).map((k) => (
            <button
              key={k}
              className={cn("flex items-center gap-1 capitalize hover:text-foreground", k !== "name" && "justify-end", k === "modified" && "hidden @2xl:flex")}
              onClick={() => sortBy(k)}
            >
              {k} <SortIcon k={k} />
            </button>
          ))}
        </div>

        <div key={prefix} className="animate-fade pb-16">
        {error ? (
          <Empty>
            <p className="max-w-md text-destructive">{error}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => load()}>
                Retry
              </Button>
              <Button variant="outline" onClick={onEdit}>
                Edit connection
              </Button>
            </div>
          </Empty>
        ) : loading && !entries.length ? (
          <Empty>
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </Empty>
        ) : !rows.length ? (
          <Empty>
            <p className="text-muted-foreground">{filter ? "Nothing matches the filter." : "This folder is empty. Drop files here to upload."}</p>
          </Empty>
        ) : (
          <>
            {rows.slice(0, MAX_ROWS).map((e, i) => {
              const up = pending.get(e.key);
              const pct = up && up[1] ? Math.floor((up[0] / up[1]) * 100) : 0;
              return (
              <div
                key={rid(e)}
                data-i={i}
                role="row"
                aria-selected={selected.has(rid(e))}
                onClick={(ev) => click(ev, e, i)}
                onDoubleClick={() => openEntry(e)}
                onContextMenu={() => !selected.has(rid(e)) && (setSelected(new Set([rid(e)])), setAnchor(i))}
                title={
                  up
                    ? `Uploading… ${formatSize(up[0])} of ${formatSize(up[1])} (${pct}%)`
                    : e.uploadId
                      ? "Unfinished upload: it never completed. Resume it from the local file, or delete it to free the space it uses."
                      : undefined
                }
                className={cn(
                  "group grid grid-cols-[1rem_1fr_6rem] @2xl:grid-cols-[1rem_1fr_7rem_11rem] items-center gap-3 px-4 py-1.5 text-sm transition-colors",
                  selected.has(rid(e)) ? "bg-accent" : "hover:bg-accent/50",
                  e.uploadId && !up && "text-destructive",
                  up && "opacity-60",
                  busyRow(e) && "pointer-events-none",
                )}
              >
                {/* Like Explorer: shown on hover, and on every row once anything is selected. */}
                <Checkbox
                  checked={selected.has(rid(e))}
                  onChange={() => toggle(rid(e), i)}
                  label={`Select ${e.name}`}
                  className={cn(!sel.length && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100", busyRow(e) && "invisible")}
                />
                <span className="flex min-w-0 items-center gap-2.5">
                  {opening === e.key || up ? (
                    <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : e.isDir ? (
                    <Folder className="size-4 shrink-0 fill-current/20" />
                  ) : e.uploadId ? (
                    <FileX className="size-4 shrink-0" />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{e.name || "(unnamed)"}</span>
                </span>
                <span className={cn("text-right tabular-nums", !e.uploadId && "text-muted-foreground")}>
                  {up ? `${pct}%` : e.uploadId ? "Unfinished" : e.isDir ? "" : formatSize(e.size)}
                </span>
                <span className={cn("hidden truncate text-right tabular-nums @2xl:block", !e.uploadId && "text-muted-foreground")}>
                  {up ? "Uploading…" : e.modified ? new Date(e.modified).toLocaleString() : ""}
                </span>
              </div>
              );
            })}
            {rows.length > MAX_ROWS && (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Showing {MAX_ROWS} of {rows.length} items. Use the filter to find the rest.
              </p>
            )}
          </>
        )}
        </div>
        {band && (
          <div
            className="pointer-events-none absolute z-20 rounded-sm border border-primary/50 bg-primary/10"
            style={{ left: band.x, top: band.y, width: band.w, height: band.h }}
          />
        )}
      </div>

      <div className="border-t px-4 py-1.5 text-xs text-muted-foreground">
        {entries.filter((e) => e.isDir).length} folders, {entries.filter((e) => !e.isDir && !e.uploadId).length} files,{" "}
        {entries.some((e) => e.uploadId) && `${entries.filter((e) => e.uploadId).length} unfinished, `}
        {formatSize(entries.reduce((n, e) => n + e.size, 0))}
      </div>

      <div
        aria-hidden={!dragging}
        className={cn(
          "pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/80 text-lg font-medium transition-opacity",
          dragging ? "opacity-100" : "opacity-0",
        )}
      >
        Drop to upload to /{prefix}
      </div>

      {menu && (
        <ContextMenu key={menu.n} x={menu.x} y={menu.y} onClose={closeMenu}>
          {sel.length ? (
            <>
              {single && canOpen(single) && <MenuItem icon={<FolderOpen />} label="Open" hint="Enter" onClick={() => openEntry(single)} />}
              {single && canEdit(single) && <MenuItem icon={<FileCode />} label="Edit" hint={canOpen(single) ? undefined : "Enter"} onClick={() => editFile(single)} />}
              {real.length > 0 && <MenuItem icon={<Download />} label="Download" onClick={() => download(real)} />}
              {single?.uploadId && <MenuItem icon={<Upload />} label="Resume upload…" hint="Enter" onClick={() => resume(single)} />}
              {single && !single.uploadId && <MenuItem icon={<Pencil />} label="Rename" hint="F2" onClick={() => setDialog("rename")} />}
              <MenuItem icon={<Trash />} label="Delete" hint="Del" danger onClick={() => setDialog("delete")} />
              {single && !single.uploadId && <MenuItem icon={<Info />} label="Properties" hint="Alt+Enter" onClick={() => setProperties(single)} />}
            </>
          ) : (
            <>
              <MenuItem icon={<FilePlus />} label="New file" onClick={() => setDialog("file")} />
              <MenuItem icon={<FolderPlus />} label="New folder" onClick={() => setDialog("folder")} />
              <MenuItem icon={<Upload />} label="Upload files" onClick={() => pickUpload(false)} />
              <MenuItem icon={<FolderUp />} label="Upload folders" onClick={() => pickUpload(true)} />
              <MenuItem icon={<RefreshCw />} label="Refresh" hint="F5" onClick={() => load()} />
            </>
          )}
        </ContextMenu>
      )}

      <Presence show={viewing !== null && viewing >= 0 && viewing < media.length} className="relative z-40">
        {viewing !== null && media[viewing] && (
          <MediaViewer
            id={id}
            items={media}
            index={viewing}
            onIndex={setViewing}
            onClose={() => {
              setViewing(null);
              listRef.current?.focus();
            }}
            onDownload={(e) => download([e])}
            onFailed={(e) =>
              log({ action: "open", bucket: profile.bucket, summary: `Could not show ${e.name}`, detail: "The built-in viewer can't open it (damaged, unsupported format, missing codec, or unreachable)", ok: false })
            }
          />
        )}
      </Presence>

      {/* Only the panel fades; the editor inside has no animations. */}
      <Presence show={!!editing} className="relative z-40">
        {editing && (
          <EditorPanel
            log={(ok, detail) => log({ action: "edit", bucket: profile.bucket, summary: ok ? `Saved ${editing.name}` : `Could not save ${editing.name}`, detail, ok })}
            id={id}
            file={editing}
            notify={notify}
            onClose={(saved) => {
              setEditing(null);
              if (saved) load();
              listRef.current?.focus();
            }}
          />
        )}
      </Presence>

      <PropertiesDialog id={id} bucket={profile.bucket} entry={properties} onClose={() => setProperties(null)} />

      <ConflictDialog
        keys={clash?.keys ?? null}
        prefix={clash?.prefix ?? ""}
        onDone={(d) => {
          clash?.resolve(d);
          setClash(null);
        }}
      />

      <PromptDialog
        open={dialog === "file"}
        title="New file"
        label="File name"
        initial=""
        action="Create"
        validate={(v) => nameError(v) ?? (entries.some((e) => e.name === v.trim()) ? "Something with that name already exists" : null)}
        onSubmit={async (name) => {
          const key = `${prefix}${name}`;
          await api.createFile(id, key).catch((e) => {
            log({ action: "create", bucket: profile.bucket, summary: `Could not create file ${name}`, detail: errText(e), ok: false });
            throw e;
          });
          log({ action: "create", bucket: profile.bucket, summary: `Created file ${name}`, detail: `/${key}`, ok: true });
          load();
          editFile({ key, name, isDir: false, size: 0, modified: null });
        }}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "folder"}
        title="New folder"
        label="Folder name"
        initial=""
        action="Create"
        validate={(v) => nameError(v) ?? (entries.some((e) => e.isDir && e.name === v.trim()) ? "A folder with that name already exists" : null)}
        onSubmit={async (name) => {
          await api.createFolder(id, `${prefix}${name}/`).catch((e) => {
            log({ action: "create", bucket: profile.bucket, summary: `Could not create folder ${name}`, detail: errText(e), ok: false });
            throw e;
          });
          log({ action: "create", bucket: profile.bucket, summary: `Created folder ${name}`, detail: `/${prefix}${name}/`, ok: true });
          load();
        }}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "rename" && !!single}
        title="Rename"
        label="New name"
        initial={single?.name ?? ""}
        action="Rename"
        validate={(v) => nameError(v) ?? (v.trim() === single?.name ? "That is the current name" : null)}
        onSubmit={async (name) => {
          if (!single) return;
          await api.rename(id, single.key, `${prefix}${name}${single.isDir ? "/" : ""}`).catch((e) => {
            log({ action: "rename", bucket: profile.bucket, summary: `Could not rename ${single.name}`, detail: errText(e), ok: false });
            throw e;
          });
          log({ action: "rename", bucket: profile.bucket, summary: `Renamed ${single.name} to ${name}`, detail: `in /${prefix}`, ok: true });
          setSelected(new Set([`${prefix}${name}${single.isDir ? "/" : ""}`]));
          load();
        }}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete ${sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} items`}?`}
        body={
          <>
            {sel.some((e) => e.isDir) && "Folders are deleted with everything inside them. "}
            {broken.length > 0 && "Unfinished uploads are removed and can't be resumed. "}
            This cannot be undone.
          </>
        }
        action="Delete"
        onConfirm={async () => {
          const what = sel.length === 1 ? sel[0].name : `${sel.length} items`;
          try {
            const n = real.length ? await api.delete(id, real.map((e) => e.key)) : 0;
            const m = broken.length ? await api.abortUploads(id, broken.map((e) => [e.key, e.uploadId!])) : 0;
            const done = [n && `${n} object${n === 1 ? "" : "s"}`, m && `${m} unfinished upload${m === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
            notify(`Deleted ${done}`, "ok");
            log({ action: "delete", bucket: profile.bucket, summary: `Deleted ${what}`, detail: `${done} in /${prefix}`, ok: true });
          } catch (e) {
            notify(errText(e));
            log({ action: "delete", bucket: profile.bucket, summary: `Could not delete ${what}`, detail: errText(e), ok: false });
          }
          load();
        }}
        onClose={() => {
          setDialog(null);
          listRef.current?.focus();
        }}
      />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center text-sm">{children}</div>;
}

function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Plays the exit animation, then unmounts. A new right-click mounts a fresh menu (new key) and cancels this.
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(0);
  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = window.setTimeout(onClose, MOTION_MS);
  }, [onClose]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(x, innerWidth - r.width - 4), y: Math.min(y, innerHeight - r.height - 4) });
    ref.current!.querySelector("button")?.focus();
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("mousedown", outside);
    addEventListener("keydown", key);
    addEventListener("blur", close);
    return () => {
      removeEventListener("mousedown", outside);
      removeEventListener("keydown", key);
      removeEventListener("blur", close);
    };
  }, [x, y, close]);
  return (
    <div
      ref={ref}
      role="menu"
      onClick={close}
      style={{ left: pos.x, top: pos.y }}
      className={cn(
        "fixed z-50 min-w-44 origin-top-left rounded-md border bg-popover p-1 shadow-xl",
        leaving ? "pointer-events-none animate-pop-out" : "animate-pop",
      )}
    >
      {children}
    </div>
  );
}

function MenuItem({ icon, label, hint, danger, onClick }: { icon: ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent [&_svg]:size-4",
        danger && "text-destructive",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </button>
  );
}
