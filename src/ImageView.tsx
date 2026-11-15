import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, RotateCcw, RotateCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "./ui";

type View = { s: number; x: number; y: number; r: number; flip: boolean };
const FIT: View = { s: 1, x: 0, y: 0, r: 0, flip: false };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Image with Viewer.js-style controls: wheel zooms toward the cursor, drag pans, double-click
 * toggles zoom, toolbar for zoom / actual size / fit / rotate / flip. Keys: + - 0, R / Shift+R.
 * Scale 1 = fitted to the window; `fit` converts that to a percentage of the real size.
 */
export function ImageView({
  src,
  alt,
  onLoad,
  onError,
  onBackground,
}: {
  src: string;
  alt: string;
  onLoad: () => void;
  onError: () => void;
  onBackground: () => void;
}) {
  const [v, setV] = useState<View>(FIT);
  const [fit, setFit] = useState(1);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const moved = useRef(false);

  // Up to 20x the real pixel size, down to a tenth of the fitted size.
  const maxScale = Math.max(1, 20 / fit);
  const measure = () => img.current?.naturalWidth && setFit(img.current.offsetWidth / img.current.naturalWidth);
  useEffect(() => {
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, []);

  /** Pointer position relative to the box centre, where the image's transform origin sits at scale 1. */
  const at = (e: { clientX: number; clientY: number }) => {
    const b = box.current!.getBoundingClientRect();
    return { x: e.clientX - b.left - b.width / 2, y: e.clientY - b.top - b.height / 2 };
  };
  // Keeps the point under `p` fixed while zooming (works with rotation, which sits inside the translate).
  const zoom = (factor: number, p = { x: 0, y: 0 }) =>
    setV((v) => {
      const s = clamp(v.s * factor, 0.1, maxScale);
      const k = s / v.s;
      return { ...v, s, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
    });
  const actualSize = () => setV((v) => ({ ...v, s: 1 / fit, x: 0, y: 0 }));
  const rotate = (d: number) => setV((v) => ({ ...v, r: v.r + d }));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=") zoom(1.25);
      else if (e.key === "-") zoom(0.8);
      else if (e.key === "0") setV(FIT);
      else if (e.key === "r") rotate(90);
      else if (e.key === "R") rotate(-90);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { mx: e.clientX, my: e.clientY, x: v.x, y: v.y };
    moved.current = false;
    setDragging(true);
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.mx;
      const dy = ev.clientY - start.my;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
      setV((v) => ({ ...v, x: start.x + dx, y: start.y + dy }));
    };
    const up = () => {
      setDragging(false);
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };

  return (
    <div
      ref={box}
      className="absolute inset-0 flex items-center justify-center overflow-hidden p-6"
      onWheel={(e) => zoom(Math.exp(-e.deltaY * 0.0015), at(e))}
      onClick={(e) => {
        // The click that ends a pan must not close the viewer.
        if (e.target === e.currentTarget && !moved.current) onBackground();
        moved.current = false;
      }}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => {
          measure();
          setReady(true);
          onLoad();
        }}
        onError={onError}
        onMouseDown={startPan}
        onDoubleClick={(e) => (v.s > 1.01 ? setV((v) => ({ ...FIT, r: v.r, flip: v.flip })) : zoom(2.5, at(e)))}
        style={{
          transform: `translate(${v.x}px, ${v.y}px) rotate(${v.r}deg) scale(${v.flip ? -v.s : v.s}, ${v.s})`,
          transition: dragging ? "none" : "transform 150ms cubic-bezier(0.2, 0, 0, 1)",
        }}
        className={cn("max-h-full max-w-full object-contain", dragging ? "cursor-grabbing" : "cursor-grab", ready ? "animate-fade" : "opacity-0")}
      />

      {ready && (
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 animate-rise items-center gap-0.5 rounded-lg border bg-popover/90 p-1 shadow-2xl backdrop-blur">
          <Tool label="Zoom out (−)" onClick={() => zoom(0.8)}>
            <ZoomOut />
          </Tool>
          <button className="h-8 w-14 rounded-md text-xs tabular-nums transition-colors hover:bg-accent" onClick={actualSize} title="Actual size (1:1)">
            {Math.round(v.s * fit * 100)}%
          </button>
          <Tool label="Zoom in (+)" onClick={() => zoom(1.25)}>
            <ZoomIn />
          </Tool>
          <div className="mx-1 h-5 w-px bg-border" />
          <Tool label="Fit to window (0)" onClick={() => setV((v) => ({ ...v, s: 1, x: 0, y: 0 }))}>
            <Scan />
          </Tool>
          <Tool label="Rotate left (Shift+R)" onClick={() => rotate(-90)}>
            <RotateCcw />
          </Tool>
          <Tool label="Rotate right (R)" onClick={() => rotate(90)}>
            <RotateCw />
          </Tool>
          <Tool label="Flip horizontally" onClick={() => setV((v) => ({ ...v, flip: !v.flip }))}>
            <ArrowLeftRight />
          </Tool>
        </div>
      )}
    </div>
  );
}

export function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
