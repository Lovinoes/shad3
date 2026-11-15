import { Suspense, lazy, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, ChevronLeft, ChevronRight, CircleX, Download, FileSpreadsheet, FileText, Image as ImageIcon, LoaderCircle, Video, X } from "lucide-react";
import type { Entry } from "./api";
import { AudioPlayer } from "./AudioPlayer";
import { ImageView } from "./ImageView";
import { Button } from "./ui";

const PdfView = lazy(() => import("./PdfView"));
const SheetView = lazy(() => import("./SheetView"));

export type MediaKind = "image" | "video" | "audio" | "pdf" | "sheet";

// What the webview can show depends on the system's codecs; anything else shows a "can't play" message.
const KINDS: Record<MediaKind, string[]> = {
  image: ["png", "jpg", "jpeg", "jfif", "pjpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "apng", "tif", "tiff", "heic", "heif", "jxl"],
  video: ["mp4", "m4v", "webm", "mkv", "mov", "ogv", "avi", "mpeg", "mpg", "m2ts", "3gp", "wmv", "flv"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "weba", "wma", "aiff", "aif", "alac", "mka"],
  pdf: ["pdf"],
  sheet: ["xlsx", "xlsm", "xls", "xlsb", "ods", "fods", "numbers"],
};
const BY_EXT = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind as MediaKind])));

export function mediaKind(name: string): MediaKind | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null) : null;
}

let base: Promise<string> | undefined;
/** URL on the app's local streaming server (media.rs); the key is hex so no character can be misread. */
async function mediaUrl(id: string, key: string) {
  base ??= invoke<string>("media_base");
  const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${await base}/${encodeURIComponent(id)}/${hex}`;
}

const icons = { image: ImageIcon, video: Video, audio: AudioLines, pdf: FileText, sheet: FileSpreadsheet };
const labels = { image: "image", video: "video", audio: "audio file", pdf: "PDF", sheet: "spreadsheet" };

/** Full-window viewer for images, video and audio; ←/→ step through the folder's media. */
export function MediaViewer({
  id,
  items,
  index,
  onIndex,
  onClose,
  onDownload,
  onFailed,
}: {
  id: string;
  items: Entry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDownload: (e: Entry) => void;
  onFailed: (e: Entry) => void;
}) {
  const item = items[index];
  const kind = mediaKind(item.name)!;
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const Icon = icons[kind];

  useEffect(() => {
    setState("loading");
    setUrl(null);
    let live = true;
    mediaUrl(id, item.key).then((u) => live && setUrl(u), () => live && setState("error"));
    return () => {
      live = false;
    };
  }, [id, item.key]);

  const go = (d: number) => items.length > 1 && onIndex((index + d + items.length) % items.length);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Arrow keys belong to the player or a slider while it has focus (seeking, volume).
      if (e.target instanceof HTMLMediaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const loaded = () => setState("ready");
  const failed = () => {
    setState("error");
    onFailed(item);
  };

  return (
    // Lightbox: the app stays faintly visible behind the media.
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 flex flex-col bg-background/80 backdrop-blur-[4px]">
      <div className="flex items-center gap-2 border-b bg-background/60 px-4 py-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={item.key}>
          {item.name}
        </span>
        {items.length > 1 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {index + 1} / {items.length}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => onDownload(item)} title="Download">
          <Download /> <span className="hidden sm:inline">Download</span>
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close viewer" title="Close (Esc)">
          <X />
        </Button>
      </div>

      {/* Clicking the empty space around the media closes the viewer. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {state === "loading" && kind !== "video" && kind !== "audio" && <LoaderCircle className="absolute size-6 animate-spin text-muted-foreground" />}

        {state === "error" ? (
          <div className="flex animate-rise flex-col items-center gap-4 rounded-lg border bg-card p-8 text-center shadow-2xl">
            <CircleX className="size-8 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              This {labels[kind]} can't be shown here. It may be damaged, too large, or in a format or codec this system doesn't support.
            </p>
            <Button onClick={() => onDownload(item)}>
              <Download /> Download
            </Button>
          </div>
        ) : (
          url &&
          (kind === "image" ? (
            <ImageView key={url} src={url} alt={item.name} onLoad={loaded} onError={failed} onBackground={onClose} />
          ) : kind === "video" ? (
            <video key={url} src={url} controls autoPlay onLoadedData={loaded} onError={failed} className="max-h-full max-w-full animate-fade rounded-md bg-black" />
          ) : kind === "audio" ? (
            <AudioPlayer key={url} src={url} name={item.name} onReady={loaded} onError={failed} />
          ) : (
            <Suspense>
              {kind === "pdf" ? (
                <PdfView key={url} url={url} onReady={loaded} onError={failed} />
              ) : (
                <SheetView key={url} url={url} onReady={loaded} onError={failed} />
              )}
            </Suspense>
          ))
        )}

        {items.length > 1 && (
          <>
            <Button variant="outline" size="icon" className="absolute left-4 size-10 rounded-full bg-background/70" onClick={() => go(-1)} aria-label="Previous" title="Previous (←)">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon" className="absolute right-4 size-10 rounded-full bg-background/70" onClick={() => go(1)} aria-label="Next" title="Next (→)">
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
