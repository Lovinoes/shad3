import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronRight, CircleCheck, CircleX, Database, LoaderCircle, Pencil, Plus, X } from "lucide-react";
import { api, CANCELLED, errText, formatSize, type HistoryEntry, type Profile, type Settings, type Tick } from "./api";
import { historyIcons, timeAgo, type Log } from "./history";
import { SettingsDialog } from "./SettingsDialog";
import { TitleBar } from "./TitleBar";
import { BucketDialog } from "./BucketDialog";
import { Browser, type RunTransfer } from "./Browser";
import { Button, ConfirmDialog, MOTION_MS, Presence, cn } from "./ui";

type Toast = { id: number; msg: string; kind: "error" | "ok"; leaving?: boolean };
type Transfer = {
  id: string;
  label: string;
  tick?: Tick;
  state: "running" | "cancelling" | "cancelled" | "done" | "error";
  errors: string[];
  leaving?: boolean;
};

const LAST = "s3b:last";
const host = (endpoint: string) => endpoint.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");

export default function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: Profile | null } | null>(null);
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [settings, setSettings] = useState<Settings>({ theme: "system", reduceMotion: false, openers: {} });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [settingsOpen, setSettingsOpen] = useState<false | "appearance" | "history">(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const seq = useRef(0);

  const notify = useCallback((msg: string, kind: "error" | "ok" = "error") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), MOTION_MS);
    }, kind === "error" ? 8000 : 3000);
  }, []);

  useEffect(() => {
    api
      .getProfiles()
      .then((list) => {
        setProfiles(list);
        let last: string | null = null;
        try {
          last = localStorage.getItem(LAST);
        } catch {}
        setActive(list.find((p) => p.id === last)?.id ?? list[0]?.id ?? null);
      })
      .catch((e) => {
        setProfiles([]);
        notify(errText(e));
      });
  }, [notify]);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => notify(errText(e)));
    api.getHistory().then(setHistory, () => {});
    // Saves made in an external editor are uploaded by the backend.
    const un = listen<{ bucket: string; key: string; error: string | null }>("external-saved", ({ payload: { bucket, key, error } }) => {
      const name = key.split("/").pop();
      if (error) notify(`${name}: ${error}`);
      else notify(`Uploaded ${name}`, "ok");
      logRef.current({ action: "edit", bucket, summary: `Saved ${name} from an external app`, detail: error, ok: !error });
    });
    return () => {
      un.then((f) => f());
    };
  }, [notify]);

  // "System" theme: the desktop's preference (read from the XDG portal on Linux, the webview elsewhere),
  // checked again whenever the window gets focus, so switching GNOME to light mode shows up.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const check = () =>
      api.systemTheme().then(
        (t) => setSystemDark(t ? t === "dark" : mq.matches),
        () => setSystemDark(mq.matches),
      );
    check();
    mq.addEventListener("change", check);
    const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && check());
    return () => {
      mq.removeEventListener("change", check);
      un.then((f) => f());
    };
  }, []);
  useEffect(() => {
    const t = settings.theme === "light" || settings.theme === "dark" ? settings.theme : systemDark ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.motion = settings.reduceMotion ? "off" : "on";
  }, [settings.theme, settings.reduceMotion, systemDark]);

  useEffect(() => {
    try {
      if (active) localStorage.setItem(LAST, active);
    } catch {}
  }, [active]);

  // Stop the webview's own right-click menu (Reload, Inspect…) and text selection; inputs and the editor keep theirs.
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null; // selectstart may target a text node
      return !!el?.closest("input, textarea, .monaco-editor");
    };
    const block = (e: Event) => !typing(e.target) && e.preventDefault();
    addEventListener("contextmenu", block);
    addEventListener("selectstart", block);
    return () => {
      removeEventListener("contextmenu", block);
      removeEventListener("selectstart", block);
    };
  }, []);

  /** Adds an entry to the activity history (shown bottom left and in Settings → History). */
  const log: Log = useCallback((e) => {
    const entry = { ...e, id: crypto.randomUUID(), time: Date.now() };
    setHistory((h) => [entry, ...h].slice(0, 2000));
    api.addHistory(entry).catch(() => {});
  }, []);
  const logRef = useRef(log);

  const runTransfer: RunTransfer = useCallback(async (label, fn) => {
    const id = `t${++seq.current}`;
    const patch = (p: Partial<Transfer>) => setTransfers((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
    setTransfers((ts) => [...ts, { id, label, state: "running", errors: [] }]);
    const ch = new Channel<Tick>();
    ch.onmessage = (tick) => patch({ tick });
    try {
      const errors = await fn(ch, id);
      patch({ state: errors.length ? "error" : "done", errors });
      return errors;
    } catch (e) {
      const cancelled = errText(e) === CANCELLED;
      patch(cancelled ? { state: "cancelled" } : { state: "error", errors: [errText(e)] });
      return [errText(e)];
    }
  }, []);
  /** × on a transfer: cancels it while running, otherwise removes it from the list. */
  const dismissTransfer = (t: Transfer) => {
    if (t.state === "running") {
      setTransfers((ts) => ts.map((x) => (x.id === t.id ? { ...x, state: "cancelling" } : x)));
      api.cancelTransfer(t.id).catch(() => {});
    } else if (t.state !== "cancelling") {
      setTransfers((ts) => ts.map((x) => (x.id === t.id ? { ...x, leaving: true } : x)));
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== t.id)), MOTION_MS);
    }
  };

  const current = profiles?.find((p) => p.id === active) ?? null;

  return (
    <div className="flex h-full flex-col">
      <TitleBar onSettings={() => setSettingsOpen("appearance")} />
      <div className="flex min-h-0 flex-1">
      {/* sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
        <div className="px-3 pt-3 pb-3">
          <Button variant="outline" className="w-full justify-start" onClick={() => setDialog({ editing: null })}>
            <Plus /> Add bucket
          </Button>
        </div>
        <div className="px-4 pb-1.5 text-xs font-medium text-muted-foreground">Buckets</div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
          {profiles?.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">No buckets yet.</p>}
          {profiles?.map((p) => (
            <div
              key={p.id}
              className={cn(
                "group flex items-center rounded-md transition-colors",
                p.id === active ? "bg-accent" : "hover:bg-accent/50",
                p.id === gone ? "pointer-events-none animate-fade-out" : "animate-rise",
              )}
            >
              <button className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left" onClick={() => setActive(p.id)}>
                <Database className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.bucket}</span>
                  <span className="block truncate text-xs text-muted-foreground">{host(p.endpoint)}</span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => setDialog({ editing: p })}
                aria-label={`Edit ${p.bucket}`}
              >
                <Pencil className="size-3.5!" />
              </Button>
            </div>
          ))}
        </nav>
        <Presence show={transfers.length > 0} enter="animate-rise">
          <Transfers
            items={transfers}
            onDismiss={dismissTransfer}
            onClear={() => {
              setTransfers((ts) => ts.map((t) => (t.state === "running" || t.state === "cancelling" ? t : { ...t, leaving: true })));
              setTimeout(() => setTransfers((ts) => ts.filter((t) => !t.leaving)), MOTION_MS);
            }}
          />
        </Presence>
        <RecentActivity items={history} onViewAll={() => setSettingsOpen("history")} />
      </aside>

      {/* main */}
      {current ? (
        <Browser key={current.id} profile={current} settings={settings} notify={notify} log={log} runTransfer={runTransfer} onEdit={() => setDialog({ editing: current })} />
      ) : (
        <div className="flex flex-1 animate-rise flex-col items-center justify-center gap-4 p-8 text-center">
          {profiles === null ? (
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <h2 className="text-2xl font-bold">Add a Bucket to get started</h2>
              <Button onClick={() => setDialog({ editing: null })}>
                <Plus /> Add bucket
              </Button>
            </>
          )}
        </div>
      )}
      </div>

      <SettingsDialog
        open={!!settingsOpen}
        startPage={settingsOpen || "appearance"}
        history={history}
        onClearHistory={async () => {
          await api.clearHistory();
          setHistory([]);
        }}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onChange={async (s) => {
          await api.saveSettings(s);
          setSettings(s);
        }}
      />
      <BucketDialog
        open={!!dialog}
        editing={dialog?.editing ?? null}
        onClose={() => setDialog(null)}
        onSaved={(p) => {
          const known = profiles?.some((x) => x.id === p.id);
          log({ action: "bucket", bucket: p.bucket, summary: known ? `Edited bucket ${p.bucket}` : `Added bucket ${p.bucket}`, detail: p.endpoint, ok: true });
          setProfiles((ps) => (ps?.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [...(ps ?? []), p]));
          setActive(p.id);
          setDialog(null);
        }}
        onRemove={(p) => {
          setDialog(null);
          setRemoving(p);
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove "${removing?.bucket}"?`}
        body="This only removes the connection from this app. The bucket and its files on the server are not touched."
        action="Remove"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api.deleteProfile(removing.id);
            log({ action: "bucket", bucket: removing.bucket, summary: `Removed bucket ${removing.bucket} from shad3`, detail: removing.endpoint, ok: true });
            setGone(removing.id);
            await new Promise((r) => setTimeout(r, MOTION_MS));
            const rest = profiles?.filter((p) => p.id !== removing.id) ?? [];
            setProfiles(rest);
            if (active === removing.id) setActive(rest[0]?.id ?? null);
          } catch (e) {
            notify(errText(e));
          }
        }}
        onClose={() => setRemoving(null)}
      />

      <div className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-sm shadow-xl",
              t.leaving ? "animate-slide-out" : "animate-slide-in",
            )}
          >
            {t.kind === "ok" ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />}
            <span className="flex-1 break-words">{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Transfers({ items, onClear, onDismiss }: { items: Transfer[]; onClear: () => void; onDismiss: (t: Transfer) => void }) {
  return (
    <div className="max-h-72 overflow-y-auto border-t px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted-foreground">Transfers</span>
        {items.some((t) => t.state !== "running" && t.state !== "cancelling") && (
          <Button variant="ghost" size="icon" className="size-6" onClick={onClear} aria-label="Clear finished transfers" title="Clear finished">
            <X className="size-3.5!" />
          </Button>
        )}
      </div>
      <ul className="space-y-2.5">
        {items.map((t) => {
          const pct = t.tick?.total ? Math.min(100, (t.tick.bytes / t.tick.total) * 100) : t.state === "running" ? 0 : 100;
          return (
            <li key={t.id} className={cn("px-1 text-xs", t.leaving ? "animate-fade-out" : "animate-rise")}>
              <div className="flex items-center gap-1.5">
                {t.state === "running" || t.state === "cancelling" ? (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                ) : t.state === "cancelled" ? (
                  <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
                ) : t.state === "done" ? (
                  <CircleCheck className="size-3.5 shrink-0 text-success" />
                ) : (
                  <CircleX className="size-3.5 shrink-0 text-destructive" />
                )}
                <span className={cn("flex-1 truncate", t.state === "cancelled" && "text-muted-foreground")} title={t.label}>
                  {t.label}
                </span>
                {t.state === "cancelling" ? (
                  <span className="shrink-0 text-muted-foreground">Stopping…</span>
                ) : t.state === "cancelled" ? (
                  <span className="shrink-0 text-muted-foreground">Cancelled</span>
                ) : null}
                <button
                  onClick={() => onDismiss(t)}
                  disabled={t.state === "cancelling"}
                  className="-my-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  aria-label={t.state === "running" ? `Cancel ${t.label}` : `Remove ${t.label} from the list`}
                  title={t.state === "running" ? "Cancel" : "Remove from list"}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-accent">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    t.state === "error" ? "bg-destructive" : t.state === "cancelled" || t.state === "cancelling" ? "bg-muted-foreground" : "bg-primary",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {t.tick && (
                <div className="mt-1 flex justify-between text-muted-foreground tabular-nums">
                  <span>
                    {t.tick.files}/{t.tick.filesTotal} files
                  </span>
                  <span>
                    {formatSize(t.tick.bytes)} / {formatSize(t.tick.total)}
                  </span>
                </div>
              )}
              {t.errors.length > 0 && (
                <details className="mt-1 text-destructive">
                  <summary className="cursor-pointer">
                    {t.errors.length} failed
                  </summary>
                  <ul className="mt-1 space-y-1 break-all">
                    {t.errors.slice(0, 50).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Bottom-left list of the latest actions; collapsible, remembered per device. */
function RecentActivity({ items, onViewAll }: { items: HistoryEntry[]; onViewAll: () => void }) {
  // Re-render once a minute so "now" / "5m" stay true while the app sits idle.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("s3b:recent") !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("s3b:recent", open ? "closed" : "open");
    } catch {}
  };
  return (
    <div className="border-t px-3 py-2">
      <div className="flex items-center justify-between px-1">
        <button onClick={toggle} className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground" aria-expanded={open}>
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Recent activity
        </button>
        <button onClick={onViewAll} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          View all
        </button>
      </div>
      <Presence show={open} enter="animate-rise">
        <ul className="mt-1.5 space-y-0.5 pb-1">
          {items.length === 0 && <li className="px-1 py-1 text-xs text-muted-foreground">Nothing yet.</li>}
          {items.slice(0, 4).map((h) => {
            const Icon = h.ok ? historyIcons[h.action] : CircleX;
            return (
              <li key={h.id} className="flex animate-rise items-center gap-2 rounded-md px-1 py-1 text-xs" title={[h.summary, h.bucket, h.detail].filter(Boolean).join(" · ")}>
                <Icon className={cn("size-3.5 shrink-0", h.ok ? "text-muted-foreground" : "text-destructive")} />
                <span className="min-w-0 flex-1 truncate">{h.summary}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{timeAgo(h.time)}</span>
              </li>
            );
          })}
        </ul>
      </Presence>
    </div>
  );
}
