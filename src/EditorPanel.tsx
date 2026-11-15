import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileCode, LoaderCircle, Save, X } from "lucide-react";
import { api, CONFLICT, errText } from "./api";
import { Button, ConfirmDialog } from "./ui";

const CodeEditor = lazy(() => import("./CodeEditor"));

export type OpenFile = { key: string; name: string; etag: string | null; text: string };

/** Full-window editor, so nothing else (switching buckets, closing) can drop unsaved edits unnoticed. */
export function EditorPanel({
  id,
  file,
  notify,
  log,
  onClose,
}: {
  id: string;
  file: OpenFile;
  notify: (msg: string, kind?: "error" | "ok") => void;
  log: (ok: boolean, detail: string) => void;
  onClose: (saved: boolean) => void;
}) {
  const [text, setText] = useState(file.text);
  const [saved, setSaved] = useState(file.text);
  const [etag, setEtag] = useState(file.etag);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<null | "conflict" | "discard" | "quit">(null);
  const savingRef = useRef(false);
  const savedOnce = useRef(false);
  const dirty = text !== saved;

  const save = async (value: string, force = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      setEtag(await api.writeText(id, file.key, value, force ? null : etag));
      setSaved(value);
      savedOnce.current = true;
      notify(`Saved ${file.name}`, "ok");
      log(true, `/${file.key}`);
    } catch (e) {
      if (errText(e) === CONFLICT) setAsk("conflict");
      else {
        notify(errText(e));
        log(false, errText(e));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const close = () => (dirty ? setAsk("discard") : onClose(savedOnce.current));

  // Closing the window with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const un = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      setAsk("quit");
    });
    return () => {
      un.then((f) => f());
    };
  }, [dirty]);

  return (
    // Below the title bar, so the window controls keep working while editing.
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <FileCode className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={file.key}>
          {file.key}
        </span>
        {dirty && <span className="size-2 shrink-0 animate-fade rounded-full bg-primary" title="Unsaved changes" />}
        <div className="flex-1" />
        <span className="hidden text-xs text-muted-foreground sm:inline">Ctrl+S to save</span>
        <Button size="sm" onClick={() => save(text)} disabled={!dirty} loading={saving}>
          {!saving && <Save />} Save
        </Button>
        <Button variant="ghost" size="icon" onClick={close} aria-label="Close editor" title="Close">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <CodeEditor path={file.key} value={file.text} onChange={setText} onSave={(v) => save(v)} />
        </Suspense>
      </div>

      <ConfirmDialog
        open={ask === "conflict"}
        title="File changed on the server"
        body={`Someone changed or deleted "${file.name}" after you opened it. Overwrite it with your version?`}
        action="Overwrite"
        onConfirm={() => save(text, true)}
        onClose={() => setAsk(null)}
      />
      <ConfirmDialog
        open={ask === "discard" || ask === "quit"}
        title="Discard unsaved changes?"
        body={`Your changes to "${file.name}" will be lost.`}
        action="Discard"
        onConfirm={async () => {
          if (ask === "quit") await getCurrentWindow().destroy();
          else onClose(savedOnce.current);
        }}
        onClose={() => setAsk(null)}
      />
    </div>
  );
}
