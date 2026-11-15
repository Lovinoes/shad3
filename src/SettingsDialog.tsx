import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, CircleX, Database, ExternalLink, FolderOpen, History as HistoryIcon, Info, LoaderCircle, MousePointerClick, Palette, Search, Trash } from "lucide-react";
import { api, errText, opener, type FileKind, type HistoryAction, type HistoryEntry, type OpenMode, type Settings } from "./api";
import { dayLabel, historyIcons, historyLabels } from "./history";
import { credits, loadAllComponents, type Component } from "./credits";
import { Button, ConfirmDialog, Dialog, Input, Presence, Switch, cn } from "./ui";

export type Page = "appearance" | "open" | "history" | "about";
const pages: { id: Page; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "open", label: "Open with", icon: MousePointerClick },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "about", label: "About", icon: Info },
];

const kinds: { kind: FileKind; title: string; examples: string; builtin?: string; hint: string }[] = [
  { kind: "text", title: "Text files", examples: "Code, notes, config files", builtin: "Built-in editor", hint: "e.g. code, kate, gnome-text-editor" },
  { kind: "image", title: "Pictures", examples: "JPG, PNG, WebP, GIF, SVG…", builtin: "Built-in viewer", hint: "e.g. loupe, eog, gimp" },
  { kind: "video", title: "Videos", examples: "MP4, MKV, WebM, MOV…", builtin: "Built-in player", hint: "Streams directly, e.g. vlc, mpv, celluloid" },
  { kind: "audio", title: "Audio", examples: "MP3, FLAC, WAV, OGG…", builtin: "Built-in player", hint: "Streams directly, e.g. vlc, mpv, rhythmbox" },
  { kind: "pdf", title: "PDF documents", examples: "PDF", builtin: "Built-in viewer", hint: "e.g. evince, papers, okular" },
  { kind: "sheet", title: "Spreadsheets", examples: "XLSX, XLS, ODS, Numbers", builtin: "Built-in viewer", hint: "e.g. libreoffice --calc, gnumeric" },
  { kind: "other", title: "Other files", examples: "Archives, documents, programs…", hint: "e.g. evince, file-roller, libreoffice" },
];

/** GNOME-style preferences: pages on the left, boxed lists on the right, changes apply instantly. */
export function SettingsDialog({
  open,
  startPage,
  settings,
  history,
  onClose,
  onChange,
  onClearHistory,
}: {
  open: boolean;
  startPage: Page;
  settings: Settings;
  history: HistoryEntry[];
  onClose: () => void;
  onChange: (s: Settings) => Promise<void>;
  onClearHistory: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>(startPage);
  useEffect(() => {
    if (open) setPage(startPage);
  }, [open, startPage]);
  return (
    <Dialog open={open} onClose={onClose} title="Settings" className="w-[min(56rem,calc(100vw-2rem))]">
      <div className="-mx-6 -mb-6 grid h-[min(34rem,calc(100vh-10rem))] grid-cols-[12rem_1fr] border-t">
        <nav className="space-y-0.5 border-r bg-sidebar p-2">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                page === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
        <div key={page} className="animate-fade overflow-y-auto p-6">
          {page === "appearance" && <Appearance settings={settings} onChange={onChange} />}
          {page === "open" && <OpenWith open={open} settings={settings} onChange={onChange} />}
          {page === "history" && <HistoryPage history={history} onClear={onClearHistory} />}
          {page === "about" && <About />}
        </div>
      </div>
    </Dialog>
  );
}

function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <h3 className="text-sm font-bold">{title}</h3>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-3 divide-y rounded-lg border bg-card">{children}</div>
    </section>
  );
}

function Row({ title, subtitle, children, onClick }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn("flex min-h-14 items-center gap-4 px-4 py-2.5", onClick && "cursor-pointer transition-colors hover:bg-accent/50")}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function Appearance({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => Promise<void> }) {
  const theme = settings.theme || "system";
  const save = (s: Settings) => onChange(s).catch(() => {});
  return (
    <>
      <Group title="Style" description="System follows your desktop's light or dark setting.">
        <div className="grid grid-cols-3 gap-4 p-4">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} onClick={() => save({ ...settings, theme: t })} className="group flex flex-col items-center gap-2 text-sm" aria-pressed={theme === t}>
              <ThemePreview theme={t} selected={theme === t} />
              <span className={cn("capitalize", theme === t ? "font-medium" : "text-muted-foreground group-hover:text-foreground")}>{t}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="Motion">
        <Row title="Animations" subtitle="Fade and slide things in and out">
          <Switch checked={!settings.reduceMotion} onChange={(on) => save({ ...settings, reduceMotion: !on })} label="Animations" />
        </Row>
      </Group>
    </>
  );
}

/** A tiny window drawn in the theme's colours; "system" is half light, half dark. */
function ThemePreview({ theme, selected }: { theme: "system" | "light" | "dark"; selected: boolean }) {
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full flex-1", dark ? "bg-[#0a0a0a]" : "bg-white")}>
      <div className={cn("w-1/3 space-y-1 border-r p-1.5", dark ? "border-white/10 bg-[#141414]" : "border-black/10 bg-[#f7f7f7]")}>
        <div className={cn("h-1.5 rounded-full", dark ? "bg-white/25" : "bg-black/20")} />
        <div className={cn("h-1.5 w-2/3 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
      </div>
      <div className="flex-1 space-y-1.5 p-2">
        {[1, 0.7, 0.85].map((w, i) => (
          <div key={i} className={cn("h-1.5 rounded-full", dark ? "bg-white/20" : "bg-black/15")} style={{ width: `${w * 100}%` }} />
        ))}
      </div>
    </div>
  );
  return (
    <div
      className={cn(
        "flex h-20 w-full overflow-hidden rounded-lg border-2 transition-colors",
        selected ? "border-primary" : "border-transparent ring-1 ring-border group-hover:ring-ring",
      )}
    >
      {theme === "system" ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(theme === "dark")
      )}
    </div>
  );
}

const selectClass =
  "h-9 cursor-pointer appearance-none rounded-md border border-input bg-popover py-0 pr-8 pl-3 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40";

/** Every logged action, grouped by day, filterable by text, kind of action, bucket and errors. */
function HistoryPage({ history, onClear }: { history: HistoryEntry[]; onClear: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [action, setAction] = useState<HistoryAction | "all">("all");
  const [bucket, setBucket] = useState("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [limit, setLimit] = useState(200);
  const [confirm, setConfirm] = useState(false);

  const buckets = [...new Set(history.map((h) => h.bucket).filter(Boolean))].sort();
  const text = q.trim().toLowerCase();
  const matches = history.filter(
    (h) =>
      (action === "all" || h.action === action) &&
      (bucket === "all" || h.bucket === bucket) &&
      (!errorsOnly || !h.ok) &&
      (!text || [h.summary, h.detail, h.bucket].some((v) => v?.toLowerCase().includes(text))),
  );
  const days: [string, HistoryEntry[]][] = [];
  for (const h of matches.slice(0, limit)) {
    const d = dayLabel(h.time);
    if (days.at(-1)?.[0] === d) days.at(-1)![1].push(h);
    else days.push([d, [h]]);
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter history" className="pl-8" aria-label="Filter history" />
        </div>
        <div className="relative">
          <select value={action} onChange={(e) => setAction(e.target.value as HistoryAction | "all")} className={selectClass} aria-label="Type of action">
            <option value="all">All actions</option>
            {(Object.keys(historyLabels) as HistoryAction[]).map((a) => (
              <option key={a} value={a}>
                {historyLabels[a]}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-muted-foreground" />
        </div>
        <div className="relative">
          <select value={bucket} onChange={(e) => setBucket(e.target.value)} className={cn(selectClass, "max-w-44")} aria-label="Bucket">
            <option value="all">All buckets</option>
            {buckets.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-muted-foreground" />
        </div>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <Switch checked={errorsOnly} onChange={setErrorsOnly} label="Errors only" />
          Errors only
        </label>
      </div>

      {history.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nothing yet. Uploads, downloads, edits and other changes show up here.</p>
      ) : matches.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nothing matches these filters.</p>
      ) : (
        days.map(([day, items]) => (
          <section key={day} className="mb-6 last:mb-0">
            <h3 className="mb-2 text-sm font-bold">{day}</h3>
            <div className="divide-y rounded-lg border bg-card">
              {items.map((h) => {
                const Icon = h.ok ? historyIcons[h.action] : CircleX;
                return (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Icon className={cn("size-4 shrink-0", h.ok ? "text-muted-foreground" : "text-destructive")} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm" title={h.summary}>
                        {h.summary}
                      </div>
                      <div className={cn("truncate text-xs", h.ok ? "text-muted-foreground" : "text-destructive")} title={h.detail ?? undefined}>
                        {[h.bucket, h.detail].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {new Date(h.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      <div className="mt-5 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {matches.length === history.length ? `${history.length} entries` : `${matches.length} of ${history.length} entries`} · the newest 2,000 are kept
        </span>
        <div className="flex gap-2">
          {matches.length > limit && (
            <Button variant="outline" size="sm" onClick={() => setLimit(limit + 200)}>
              Show more
            </Button>
          )}
          {history.length > 0 && (
            <Button variant="destructive" size="sm" onClick={() => setConfirm(true)}>
              <Trash /> Clear history
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Clear the whole history?"
        body="This only removes the activity list in shad3. Your files are not touched."
        action="Clear history"
        onConfirm={onClear}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}

function OpenWith({ open, settings, onChange }: { open: boolean; settings: Settings; onChange: (s: Settings) => Promise<void> }) {
  // Custom commands are drafts until applied (Enter, Browse, or leaving the field), because a
  // command is only saved once the program is found.
  const [draft, setDraft] = useState<Partial<Record<FileKind, { mode: OpenMode; command: string }>>>({});
  const [errors, setErrors] = useState<Partial<Record<FileKind, string>>>({});
  useEffect(() => {
    if (open) {
      setDraft({});
      setErrors({});
    }
  }, [open]);

  const current = (k: FileKind) => draft[k] ?? opener(settings, k);
  const commit = async (k: FileKind, o: { mode: OpenMode; command: string }) => {
    setDraft((d) => ({ ...d, [k]: o }));
    try {
      await onChange({ ...settings, openers: { ...settings.openers, [k]: o } });
      setErrors((e) => ({ ...e, [k]: undefined }));
      setDraft((d) => ({ ...d, [k]: undefined }));
    } catch (e) {
      setErrors((x) => ({ ...x, [k]: errText(e) }));
    }
  };
  const choose = (k: FileKind, mode: OpenMode) => {
    const o = { mode, command: current(k).command };
    if (mode === "custom" && !o.command.trim()) {
      setDraft((d) => ({ ...d, [k]: o })); // wait for a command
      setErrors((e) => ({ ...e, [k]: undefined }));
    } else commit(k, o);
  };
  const browse = async (k: FileKind) => {
    const windows = navigator.userAgent.includes("Windows");
    const picked = await openDialog({ title: "Choose a program", defaultPath: windows ? "C:\\Program Files" : "/usr/bin" });
    if (typeof picked === "string") commit(k, { mode: "custom", command: /\s/.test(picked) ? `"${picked}"` : picked });
  };

  return (
    <Group title="Open files with" description="What a double-click does, per type of file. Default app uses your desktop's choice for that file type.">
      {kinds.map(({ kind, title, examples, builtin, hint }) => {
        const o = current(kind);
        return (
          <div key={kind}>
            <Row title={title} subtitle={examples}>
              <div className="relative">
                <select
                  value={o.mode}
                  onChange={(e) => choose(kind, e.target.value as OpenMode)}
                  className="h-8 cursor-pointer appearance-none rounded-md border border-input bg-popover py-0 pr-8 pl-3 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label={`${title}: open with`}
                >
                  {builtin ? <option value="builtin">{builtin}</option> : <option value="download">Download</option>}
                  <option value="system">Default app</option>
                  <option value="custom">Custom app…</option>
                </select>
                <ChevronDown className="pointer-events-none absolute top-2 right-2.5 size-4 text-muted-foreground" />
              </div>
            </Row>
            <Presence show={o.mode === "custom"} enter="animate-rise">
              <div className="space-y-1.5 px-4 pb-3">
                <div className="flex gap-2">
                  <Input
                    defaultValue={o.command}
                    key={`${kind}:${o.command}`}
                    placeholder={hint.replace(/^.*e\.g\. /, "").split(",")[0]}
                    className="h-8"
                    aria-label={`${title}: command`}
                    onKeyDown={(e) => e.key === "Enter" && commit(kind, { mode: "custom", command: e.currentTarget.value.trim() })}
                    onBlur={(e) => e.target.value.trim() !== settings.openers[kind]?.command && commit(kind, { mode: "custom", command: e.target.value.trim() })}
                  />
                  <Button variant="outline" size="sm" onClick={() => browse(kind)}>
                    <FolderOpen /> Browse…
                  </Button>
                </div>
                {errors[kind] ? (
                  <p className="animate-rise text-xs text-destructive">{errors[kind]}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {hint}. Press Enter to apply. Put <code>{"{file}"}</code> where the file should go, otherwise it is added at the end.
                  </p>
                )}
              </div>
            </Presence>
          </div>
        );
      })}
    </Group>
  );
}

function About() {
  const [version, setVersion] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  const link = (url: string) => api.openUrl(url).catch(() => {});
  return (
    <>
      <div className="mb-7 flex flex-col items-center gap-2 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl border bg-background">
          <Database className="size-8" strokeWidth={1.75} />
        </div>
        <h3 className="text-xl font-bold">shad3</h3>
        <p className="text-sm text-muted-foreground">A simple, fast S3 browser{version && ` · version ${version}`}</p>
        <Button variant="outline" size="sm" onClick={() => link("https://lovinoes.de/")}>
          Made by Lovinoes <ExternalLink />
        </Button>
      </div>
      <Group title="Credits" description="shad3 is built on these open-source projects. Select one to read its license.">
        {credits.map((c) => (
          <div key={c.name}>
            <Row
              title={
                <>
                  {c.name} <span className="text-muted-foreground">· {c.what}</span>
                </>
              }
              subtitle={c.license}
              onClick={() => setShown(shown === c.name ? null : c.name)}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  link(c.url);
                }}
                aria-label={`${c.name} website`}
                title={c.url}
              >
                <ExternalLink />
              </Button>
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", shown === c.name && "rotate-180")} />
            </Row>
            <Presence show={shown === c.name} enter="animate-rise">
              <pre className="mx-4 mb-3 max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {c.text}
              </pre>
            </Presence>
          </div>
        ))}
      </Group>
      <AllComponents onLink={link} />
    </>
  );
}

/** Every bundled crate and npm package with its license texts (generated by `npm run credits`). */
function AllComponents({ onLink }: { onLink: (url: string) => void }) {
  const [data, setData] = useState<{ texts: string[]; components: Component[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    loadAllComponents().then(setData, () => {});
  }, []);
  const f = filter.trim().toLowerCase();
  const list = data?.components.filter((c) => !f || c.name.toLowerCase().includes(f) || c.license.toLowerCase().includes(f)) ?? [];

  return (
    <section className="mt-7">
      <h3 className="text-sm font-bold">All open-source components{data && ` (${data.components.length})`}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">Everything bundled in shad3: the Rust crates and JavaScript packages above and all they depend on.</p>
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or license" className="pl-8" aria-label="Filter components" />
      </div>
      {!data ? (
        <div className="flex justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="mt-3 divide-y rounded-lg border bg-card">
          {list.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Nothing matches.</p>}
          {list.map((c) => {
            const id = `${c.source}:${c.name}@${c.version}`;
            return (
              <div key={id}>
                <Row
                  title={
                    <>
                      {c.name} <span className="text-muted-foreground tabular-nums">{c.version}</span>
                    </>
                  }
                  subtitle={`${c.license} · ${c.source === "crate" ? "Rust crate" : "npm package"}`}
                  onClick={() => setShown(shown === id ? null : id)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLink(c.url);
                    }}
                    aria-label={`${c.name} website`}
                    title={c.url}
                  >
                    <ExternalLink />
                  </Button>
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", shown === id && "rotate-180")} />
                </Row>
                <Presence show={shown === id} enter="animate-rise">
                  <pre className="mx-4 mb-3 max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                    {c.texts.length
                      ? c.texts.map((t) => data.texts[t]).join("\n\n――――――――\n\n")
                      : `This package ships no license file. Its declared license is ${c.license}; see ${c.url}.`}
                  </pre>
                </Presence>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
