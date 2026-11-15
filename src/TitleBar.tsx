import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Settings as Gear, Square, X } from "lucide-react";
import { cn } from "./ui";

const win = getCurrentWindow();
const isWindows = navigator.userAgent.includes("Windows");

type Btn = "minimize" | "maximize" | "close";
type Look = "windows" | "kde" | "gnome";

/** GTK layout "left:right" (e.g. "menu:minimize,close"); only the three window buttons matter here. */
export function parseLayout(layout: string): { left: Btn[]; right: Btn[] } {
  const [left = "", right = ""] = layout.split(":");
  const pick = (side: string) =>
    side
      .split(",")
      .map((b) => b.trim())
      .filter((b): b is Btn => b === "minimize" || b === "maximize" || b === "close");
  return { left: pick(left), right: pick(right) };
}

const styles: Record<Look, { group: string; button: string; close: string; icon: string }> = {
  // Flat, full height; red close.
  windows: {
    group: "h-full",
    button: "flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground",
    close: "hover:bg-destructive hover:text-white",
    icon: "size-4",
  },
  // Breeze: bare icons, a circle on hover, red circle for close.
  kde: {
    group: "gap-1.5 px-2.5",
    button: "flex size-6 items-center justify-center rounded-full text-foreground/80 hover:bg-foreground/15 hover:text-foreground",
    close: "hover:bg-[#da4453] hover:text-white",
    icon: "size-3.5",
  },
  // Adwaita: small round buttons with a soft background.
  gnome: {
    group: "gap-3 px-2.5",
    button: "flex size-6 items-center justify-center rounded-full bg-foreground/10 text-foreground hover:bg-foreground/15 active:bg-foreground/25",
    close: "",
    icon: "size-3.5",
  },
};

/** Replaces the system title bar (decorations are off in tauri.conf.json) but follows the desktop's button layout and look. */
export function TitleBar({ onSettings }: { onSettings: () => void }) {
  const [maximized, setMaximized] = useState(false);
  const [look, setLook] = useState<Look>(isWindows ? "windows" : "gnome");
  const [layout, setLayout] = useState(parseLayout(isWindows ? ":minimize,maximize,close" : ""));

  useEffect(() => {
    if (!isWindows) {
      invoke<{ layout: string; desktop: string }>("get_window_buttons")
        .then(({ layout, desktop }) => {
          setLook(/kde/i.test(desktop) ? "kde" : "gnome");
          setLayout(parseLayout(layout || ":minimize,maximize,close"));
        })
        .catch(() => setLayout(parseLayout(":minimize,maximize,close")));
    }
    const sync = () =>
      win.isMaximized().then(
        (m) => {
          setMaximized(m);
          document.documentElement.toggleAttribute("data-maximized", m); // square corners when maximized
        },
        () => {},
      );
    sync();
    const un = win.onResized(sync);
    return () => {
      un.then((f) => f());
    };
  }, []);

  const s = styles[look];
  const controls = (btns: Btn[]) =>
    btns.length > 0 && (
      <div className={cn("flex items-center", s.group)}>
        {btns.map((b) =>
          b === "minimize" ? (
            <button key={b} className={cn(s.button, "transition-colors")} onClick={() => win.minimize()} aria-label="Minimize" title="Minimize">
              <Minus className={s.icon} />
            </button>
          ) : b === "maximize" ? (
            <button
              key={b}
              className={cn(s.button, "transition-colors")}
              onClick={() => win.toggleMaximize()}
              aria-label={maximized ? "Restore" : "Maximize"}
              title={maximized ? "Restore" : "Maximize"}
            >
              {maximized ? <Copy className={cn(s.icon, "-scale-x-100")} /> : <Square className={cn(s.icon, "scale-90")} />}
            </button>
          ) : (
            <button key={b} className={cn(s.button, s.close, "transition-colors")} onClick={() => win.close()} aria-label="Close" title="Close">
              <X className={s.icon} />
            </button>
          ),
        )}
      </div>
    );

  return (
    // Dragging the bar moves the window and double-clicking maximizes; the text must not catch the mouse.
    <header data-tauri-drag-region className="flex h-9 shrink-0 items-center border-b bg-sidebar">
      {controls(layout.left)}
      <span className={cn("pointer-events-none text-sm font-bold tracking-tight", layout.left.length ? "pl-1" : "pl-4")}>[shad3]</span>
      <div data-tauri-drag-region className="h-full flex-1" />
      <button
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={onSettings}
        aria-label="Settings"
        title="Settings"
      >
        <Gear className="size-4 transition-transform hover:rotate-45" />
      </button>
      {layout.right.length > 0 ? (
        <>
          {look === "windows" && <div className="mx-1 h-4 w-px bg-border" />}
          {controls(layout.right)}
        </>
      ) : (
        <div className="w-1.5" />
      )}
    </header>
  );
}
