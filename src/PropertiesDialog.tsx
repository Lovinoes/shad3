import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, File, Folder, LoaderCircle } from "lucide-react";
import { api, errText, formatSize, type Entry } from "./api";
import { Dialog, copyText } from "./ui";

export type ObjectInfo = {
  key: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  files: number;
  folders: number;
  contentType: string | null;
  etag: string | null;
  storageClass: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  versionId: string | null;
  encryption: string | null;
  metadata: Record<string, string>;
};

/** Right-click → Properties: everything S3 knows about a file, or what a folder contains. */
export function PropertiesDialog({ id, bucket, entry, onClose }: { id: string; bucket: string; entry: Entry | null; onClose: () => void }) {
  const [info, setInfo] = useState<ObjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!entry) return;
    let live = true;
    setInfo(null);
    setError(null);
    api.objectInfo(id, entry.key).then(
      (i) => live && setInfo(i),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [id, entry]);

  const parent = entry ? entry.key.slice(0, entry.key.replace(/\/$/, "").lastIndexOf("/") + 1) : "";
  const bytes = (n: number) => `${formatSize(n)}${n >= 1024 ? ` (${n.toLocaleString()} bytes)` : ""}`;

  return (
    <Dialog open={!!entry} onClose={onClose} title="Properties" className="w-[min(36rem,calc(100vw-2rem))]">
      {entry && (
        <div className="max-h-[min(30rem,calc(100vh-12rem))] overflow-y-auto">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent">
              {entry.isDir ? <Folder className="size-5" /> : <File className="size-5" />}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium" title={entry.name}>
                {entry.name}
              </div>
              <div className="text-xs text-muted-foreground">{entry.isDir ? "Folder" : (info?.contentType ?? "File")}</div>
            </div>
          </div>

          {error ? (
            <p className="animate-rise text-sm text-destructive">{error}</p>
          ) : !info ? (
            <div className="flex justify-center py-8">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="animate-fade space-y-5">
              <Group title="General">
                <Row label="Location" value={`s3://${bucket}/${parent}`} />
                <Row label="Key" value={info.key} />
                {info.isDir ? (
                  <Row label="Contains" value={`${info.files.toLocaleString()} files, ${info.folders.toLocaleString()} folders`} />
                ) : (
                  <Row label="Type" value={info.contentType} />
                )}
                <Row label={info.isDir ? "Total size" : "Size"} value={bytes(info.size)} />
                <Row label="Modified" value={info.modified ? new Date(info.modified).toLocaleString() : null} />
              </Group>
              {!info.isDir && (
                <>
                  <Group title="Storage">
                    <Row label="ETag" value={info.etag?.replace(/"/g, "")} />
                    <Row label="Storage class" value={info.storageClass ?? "STANDARD"} />
                    <Row label="Version" value={info.versionId} />
                    <Row label="Encryption" value={info.encryption} />
                  </Group>
                  {(info.cacheControl || info.contentDisposition || info.contentEncoding || info.contentLanguage) && (
                    <Group title="Headers">
                      <Row label="Cache-Control" value={info.cacheControl} />
                      <Row label="Content-Disposition" value={info.contentDisposition} />
                      <Row label="Content-Encoding" value={info.contentEncoding} />
                      <Row label="Content-Language" value={info.contentLanguage} />
                    </Group>
                  )}
                  <Group title="Custom metadata">
                    {Object.keys(info.metadata).length === 0 ? (
                      <p className="px-4 py-3 text-sm text-muted-foreground">None</p>
                    ) : (
                      Object.entries(info.metadata).map(([k, v]) => <Row key={k} label={k} value={v} />)
                    )}
                  </Group>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      <div className="divide-y rounded-lg border bg-card">{children}</div>
    </section>
  );
}

/** Label and value; empty values are left out. Text can't be selected in the app, so values have a copy button. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () =>
    copyText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => {});
  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate" title={value}>
        {value}
      </span>
      <button
        onClick={copy}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
