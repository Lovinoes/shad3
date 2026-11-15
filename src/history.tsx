import { Database, Download, FileCode, FolderOpen, Pencil, Plus, Trash, Upload } from "lucide-react";
import type { HistoryAction, HistoryEntry } from "./api";

export const historyIcons: Record<HistoryAction, typeof Upload> = {
  upload: Upload,
  download: Download,
  delete: Trash,
  rename: Pencil,
  create: Plus,
  edit: FileCode,
  open: FolderOpen,
  bucket: Database,
};

export const historyLabels: Record<HistoryAction, string> = {
  upload: "Uploads",
  download: "Downloads",
  delete: "Deletes",
  rename: "Renames",
  create: "Created",
  edit: "Edits",
  open: "Opened",
  bucket: "Buckets",
};

/** "now", "5m", "3h", "2d", then the date. */
export function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

/** "Today", "Yesterday" or a full date, for grouping. */
export function dayLabel(t: number) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(t))) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export type Log = (e: Omit<HistoryEntry, "id" | "time">) => void;
