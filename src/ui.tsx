import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, LoaderCircle, Minus, X } from "lucide-react";

/** Matches the 150ms animation speed in index.css; exit animations wait this long before unmounting. */
export const MOTION_MS = 150;

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Copies text: the system clipboard via GTK on Linux, else the web clipboard, else the classic copy command. */
export async function copyText(text: string) {
  try {
    await invoke("copy_text", { text });
  } catch {
    await webCopy(text);
  }
}

async function webCopy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;opacity:0";
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("Copy failed");
  }
}

/** Stays mounted for MOTION_MS after `show` turns false, so things can animate out. */
export function usePresence(show: boolean) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) return setMounted(true);
    const t = setTimeout(() => setMounted(false), MOTION_MS);
    return () => clearTimeout(t);
  }, [show]);
  return { mounted: show || mounted, leaving: !show && mounted };
}

/** Animates its content in and out; while leaving it keeps showing the last content. */
export function Presence({
  show,
  children,
  className,
  enter = "animate-fade",
  exit = "animate-fade-out",
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
  enter?: string;
  exit?: string;
}) {
  const { mounted, leaving } = usePresence(show);
  const last = useRef(children);
  if (show) last.current = children;
  if (!mounted) return null;
  return <div className={cn(className, leaving ? `pointer-events-none ${exit}` : enter)}>{last.current}</div>;
}

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-input bg-transparent hover:bg-accent",
  ghost: "hover:bg-accent",
  destructive: "bg-destructive/15 text-destructive hover:bg-destructive/25",
};

export function Button({
  variant = "default",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; size?: "sm" | "md" | "icon"; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,transform] active:scale-[0.97]",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        size === "md" && "h-9 px-4",
        size === "sm" && "h-8 px-3",
        size === "icon" && "size-8",
        variants[variant],
        className,
      )}
      {...props}
    >
      {loading && <LoaderCircle className="animate-spin" />}
      {children}
    </button>
  );
}

/** shadcn-style checkbox; "mixed" shows a dash (some selected). Swallows mouse events so rows don't react. */
export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean | "mixed";
  onChange: (v: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(checked !== true);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border outline-none transition-[color,background-color,border-color,opacity] focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input hover:border-ring",
        className,
      )}
    >
      {checked === "mixed" ? <Minus className="size-3" strokeWidth={3} /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  );
}

/** GNOME-style on/off switch. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-primary" : "bg-foreground/15",
      )}
    >
      <span className={cn("size-5 rounded-full bg-background shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-colors",
        "placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Native <dialog>: focus trap, Escape and screen-reader semantics for free. */
export function Dialog({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Keeps the last content rendered while the exit animation plays, so it never shows emptied props.
  const [shown, setShown] = useState(open);
  const last = useRef({ title, children });
  if (open) last.current = { title, children };
  useEffect(() => {
    const d = ref.current!;
    if (open) {
      d.removeAttribute("data-closing");
      if (!d.open) d.showModal();
      setShown(true);
    } else if (d.open) {
      d.setAttribute("data-closing", "");
      const t = setTimeout(() => {
        d.close();
        d.removeAttribute("data-closing");
        setShown(false);
      }, MOTION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
      aria-label={last.current.title}
      className={cn("m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-popover p-0 text-foreground shadow-2xl open:animate-pop", className)}
    >
      {(open || shown) && (
        <div className="p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-bold">{last.current.title}</h2>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
          {last.current.children}
        </div>
      )}
    </dialog>
  );
}

/** Single text field dialog (new folder, rename). */
export function PromptDialog({
  open,
  title,
  label,
  initial,
  action,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  action: string;
  validate: (v: string) => string | null;
  onSubmit: (v: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);
  const submit = async () => {
    const err = validate(value);
    if (err) return setError(err);
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={label} hint={error && <span className="text-destructive">{error}</span>}>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              // Select the name without the extension, like file managers do.
              const dot = e.target.value.lastIndexOf(".");
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  action,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  action: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="mb-6 text-sm text-muted-foreground">{body}</div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} autoFocus>
          Cancel
        </Button>
        <Button
          variant="destructive"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              onClose();
            }
          }}
        >
          {action}
        </Button>
      </div>
    </Dialog>
  );
}
