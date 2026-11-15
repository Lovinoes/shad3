import { useEffect, useRef, useState } from "react";
import type { ConflictMode } from "./api";
import { Button, Checkbox, Dialog } from "./ui";

export type Decisions = Record<string, ConflictMode>;

/** Asks per clashing file (Replace / Keep both / Skip), with "do this for the rest" like file managers. Closing cancels the upload. */
export function ConflictDialog({ keys, prefix, onDone }: { keys: string[] | null; prefix: string; onDone: (d: Decisions | null) => void }) {
  const [i, setI] = useState(0);
  const [all, setAll] = useState(false);
  const decided = useRef<Decisions>({});
  useEffect(() => {
    setI(0);
    setAll(false);
    decided.current = {};
  }, [keys]);

  const total = keys?.length ?? 0;
  const left = total - i;
  const name = keys?.[i]?.slice(prefix.length) ?? "";

  const choose = (m: ConflictMode) => {
    if (!keys) return;
    for (const k of all ? keys.slice(i) : [keys[i]]) decided.current[k] = m;
    if (all || i + 1 >= total) onDone(decided.current);
    else setI(i + 1);
  };

  return (
    <Dialog open={!!keys} onClose={() => onDone(null)} title={total > 1 ? `File ${i + 1} of ${total} already exists` : "File already exists"}>
      <div key={i} className="mb-5 animate-fade">
        <p className="truncate rounded-md border px-3 py-2 text-sm font-medium" title={name}>
          {name}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Replace it, keep both (the new file gets a number, like <span className="text-foreground">photo (1).jpg</span>), or skip it.
        </p>
      </div>
      {left > 1 && (
        <label className="mb-6 flex items-center gap-2 text-sm">
          <Checkbox checked={all} onChange={setAll} label="Apply to the remaining files" />
          {i === 0 ? `Do this for all ${left} files` : `Do this for the ${left} files left`}
        </label>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => choose("skip")}>
          Skip
        </Button>
        <Button variant="outline" onClick={() => choose("rename")} autoFocus>
          Keep both
        </Button>
        <Button variant="destructive" onClick={() => choose("replace")}>
          Replace
        </Button>
      </div>
    </Dialog>
  );
}
