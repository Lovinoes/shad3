import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Eye, EyeOff } from "lucide-react";
import { api, errText, PROVIDERS, type Profile, type TestResult } from "./api";
import { Button, Checkbox, Dialog, Field, Input, Presence, cn } from "./ui";

const empty = (): Profile => ({
  id: crypto.randomUUID(),
  provider: "other",
  bucket: "",
  endpoint: "",
  region: "",
  accessKey: "",
  secretKey: "",
  pathStyle: true,
});

const fill = (template: string, region: string) => template.replace("{region}", region || "REGION");

export function BucketDialog({
  open,
  editing,
  onClose,
  onSaved,
  onRemove,
}: {
  open: boolean;
  editing: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
  onRemove: (p: Profile) => void;
}) {
  const [p, setP] = useState<Profile>(empty);
  const [showSecret, setShowSecret] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "save" | "create">("");

  useEffect(() => {
    if (open) {
      setP(editing ?? empty());
      setTest(null);
      setShowSecret(false);
    }
  }, [open, editing]);

  const preset = PROVIDERS[p.provider] ?? PROVIDERS.other;
  const set = (patch: Partial<Profile>) => {
    setTest(null);
    setP((cur) => ({ ...cur, ...patch }));
  };
  const setProvider = (provider: string) => {
    const pr = PROVIDERS[provider];
    set({ provider, region: pr.region, endpoint: fill(pr.endpoint, pr.region), pathStyle: pr.pathStyle });
  };
  const setRegion = (region: string) =>
    set(preset.endpoint.includes("{region}") ? { region, endpoint: fill(preset.endpoint, region) } : { region });

  // Stored secrets never reach the UI; blank while editing means "keep the stored one".
  const missing = !p.bucket.trim() || !p.endpoint.trim() || !p.accessKey.trim() || (!editing && !p.secretKey);

  const run = async (kind: "test" | "save" | "create", fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      setTest({ ok: false, message: errText(e), bucketMissing: false });
    } finally {
      setBusy("");
    }
  };
  // Apply what the backend found to work (e.g. bucket removed from the endpoint, path-style toggled).
  const applyTest = (r: TestResult) => {
    const f = r.fixed;
    if (f) setP((cur) => ({ ...cur, bucket: f.bucket, endpoint: f.endpoint, region: f.region, pathStyle: f.pathStyle }));
    setTest(r);
  };
  const doTest = () => run("test", async () => applyTest(await api.test(p)));
  const doCreate = () =>
    run("create", async () => {
      await api.createBucket(p);
      applyTest(await api.test(p));
    });
  const doSave = () =>
    run("save", async () => {
      onSaved({ ...(await api.saveProfile(p)), secretKey: "" });
    });

  return (
    <Dialog open={open} onClose={onClose} title={editing ? "Edit bucket" : "Add bucket"}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing) doSave();
        }}
      >
        <Field label="Provider">
          <select
            value={p.provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-9 cursor-pointer rounded-md border border-input bg-popover px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {Object.entries(PROVIDERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bucket name">
          <Input autoFocus value={p.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="my-bucket" />
        </Field>
        <div className="grid grid-cols-[1fr_9rem] gap-3">
          <Field label="Endpoint" hint={preset.hint}>
            <Input value={p.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.example.com" />
          </Field>
          <Field label="Region (optional)">
            <Input value={p.region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
          </Field>
        </div>
        <Field label="Access key">
          <Input value={p.accessKey} onChange={(e) => set({ accessKey: e.target.value })} />
        </Field>
        <Field label="Secret key" hint="Stored encrypted in your system keyring (KWallet, GNOME Keyring or Windows Credential Manager).">
          <div className="relative">
            <Input
              type={showSecret ? "text" : "password"}
              value={p.secretKey}
              onChange={(e) => set({ secretKey: e.target.value })}
              placeholder={editing ? "Unchanged" : ""}
              className="pr-10"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-0.5 right-0.5"
              onClick={() => setShowSecret(!showSecret)}
              aria-label={showSecret ? "Hide secret key" : "Show secret key"}
            >
              {showSecret ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={p.pathStyle} onChange={(v) => set({ pathStyle: v })} label="Path-style URLs" />
          Path-style URLs
          <span className="text-xs text-muted-foreground">(needed for MinIO and most self-hosted servers)</span>
        </label>

        <Presence show={!!test} enter="animate-rise">
        {test && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
              test.ok ? "border-success/30 text-success" : "border-destructive/30 text-destructive",
            )}
          >
            {test.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleX className="mt-0.5 size-4 shrink-0" />}
            <span className="flex-1 break-words">{test.message}</span>
            {test.bucketMissing && (
              <Button size="sm" variant="outline" className="-my-1 text-foreground" loading={busy === "create"} onClick={doCreate}>
                Create it
              </Button>
            )}
          </div>
        )}
        </Presence>

        <div className="mt-2 flex items-center gap-2">
          {editing && (
            <Button variant="ghost" className="text-destructive" onClick={() => onRemove(editing)}>
              Remove
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" disabled={missing} loading={busy === "test"} onClick={doTest}>
            Test connection
          </Button>
          <Button type="submit" disabled={missing} loading={busy === "save"}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
