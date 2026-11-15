import { Channel, invoke } from "@tauri-apps/api/core";

export type Profile = {
  id: string;
  provider: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
};

export type Entry = { key: string; name: string; isDir: boolean; size: number; modified: number | null };
export type TestResult = { ok: boolean; message: string; bucketMissing: boolean; fixed?: Profile | null };
export type ConflictMode = "replace" | "rename" | "skip";
export type Tick = { bytes: number; total: number; files: number; filesTotal: number };

export type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "sheet" | "other";
export type OpenMode = "builtin" | "system" | "custom" | "download";
export type Opener = { mode: OpenMode; command: string };
export type Settings = { theme: "system" | "light" | "dark" | ""; reduceMotion: boolean; openers: Partial<Record<FileKind, Opener>> };
/** What a kind of file opens with; built-in by default, other files download. */
export const opener = (s: Settings, kind: FileKind): Opener => s.openers[kind] ?? { mode: kind === "other" ? "download" : "builtin", command: "" };
export type TextFile = { text: string; etag: string | null };
/** Backend error for a transfer stopped with its cancel button. */
export const CANCELLED = "Cancelled";
/** Backend error when a file changed on the server since it was opened. */
export const CONFLICT = "CONFLICT";
export const MAX_EDIT = 5 * 1024 * 1024;

export type HistoryAction = "upload" | "download" | "delete" | "rename" | "create" | "edit" | "open" | "bucket";
export type HistoryEntry = { id: string; time: number; action: HistoryAction; bucket: string; summary: string; detail?: string | null; ok: boolean };

export const api = {
  getHistory: () => invoke<HistoryEntry[]>("get_history"),
  addHistory: (entry: HistoryEntry) => invoke<void>("add_history", { entry }),
  clearHistory: () => invoke<void>("clear_history"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  readText: (id: string, key: string) => invoke<TextFile | null>("read_text", { id, key }),
  writeText: (id: string, key: string, text: string, etag: string | null) =>
    invoke<string | null>("write_text", { id, key, text, etag }),
  openExternal: (id: string, key: string, kind: FileKind) => invoke<void>("open_external", { id, key, kind }),
  systemTheme: () => invoke<string>("system_theme"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  createFile: (id: string, key: string) => invoke<void>("create_file", { id, key }),
  objectInfo: (id: string, key: string) => invoke<import("./PropertiesDialog").ObjectInfo>("object_info", { id, key }),
  getProfiles: () => invoke<Profile[]>("get_profiles"),
  saveProfile: (profile: Profile) => invoke<Profile>("save_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  test: (profile: Profile) => invoke<TestResult>("test_connection", { profile }),
  createBucket: (profile: Profile) => invoke<void>("create_bucket", { profile }),
  list: (id: string, prefix: string) => invoke<Entry[]>("list", { id, prefix }),
  createFolder: (id: string, key: string) => invoke<void>("create_folder", { id, key }),
  delete: (id: string, keys: string[]) => invoke<number>("delete", { id, keys }),
  rename: (id: string, from: string, to: string) => invoke<void>("rename", { id, from, to }),
  uploadConflicts: (id: string, paths: string[], prefix: string) => invoke<string[]>("upload_conflicts", { id, paths, prefix }),
  /** `decisions`: what to do per already-existing key. */
  upload: (id: string, paths: string[], prefix: string, decisions: Record<string, ConflictMode>, transferId: string, onProgress: Channel<Tick>) =>
    invoke<string[]>("upload", { id, paths, prefix, decisions, transferId, onProgress }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),
  download: (id: string, keys: string[], dest: string, transferId: string, onProgress: Channel<Tick>) =>
    invoke<string[]>("download", { id, keys, dest, transferId, onProgress }),
};

/** Endpoint presets; `{region}` is filled in from the region field. */
export const PROVIDERS: Record<string, { label: string; endpoint: string; region: string; pathStyle: boolean; hint?: string }> = {
  other: { label: "Other (S3 compatible)", endpoint: "", region: "", pathStyle: true },
  aws: { label: "Amazon S3", endpoint: "https://s3.{region}.amazonaws.com", region: "us-east-1", pathStyle: false },
  r2: {
    label: "Cloudflare R2",
    endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
    region: "auto",
    pathStyle: true,
    hint: "Replace ACCOUNT_ID with your Cloudflare account ID.",
  },
  b2: { label: "Backblaze B2", endpoint: "https://s3.{region}.backblazeb2.com", region: "us-west-004", pathStyle: true },
  wasabi: { label: "Wasabi", endpoint: "https://s3.{region}.wasabisys.com", region: "us-east-1", pathStyle: true },
  spaces: { label: "DigitalOcean Spaces", endpoint: "https://{region}.digitaloceanspaces.com", region: "nyc3", pathStyle: false },
  hetzner: { label: "Hetzner Object Storage", endpoint: "https://{region}.your-objectstorage.com", region: "fsn1", pathStyle: false },
  minio: { label: "MinIO", endpoint: "http://localhost:9000", region: "us-east-1", pathStyle: true },
};

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Folder/file names may not contain "/" (it is the folder separator in S3). */
export const nameError = (name: string) =>
  !name.trim() ? "Name is required" : name.includes("/") ? "Name cannot contain \"/\"" : name === "." || name === ".." ? "Invalid name" : null;
