// Loaded lazily: pdf.js is large and only needed when a PDF is opened.
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { ChevronDown, ChevronUp, MoveHorizontal, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { Tool } from "./ImageView";

// The viewer module reads pdf.js from this global when it loads, so set it before importing it.
(globalThis as unknown as { pdfjsLib: typeof pdfjs }).pdfjsLib = pdfjs;
const { EventBus, PDFLinkService, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// shortcut: no CMaps / wasm decoders bundled, so PDFs with non-embedded CJK fonts or JPEG 2000
// images may render imperfectly; ship pdfjs-dist/cmaps and /wasm if that matters.
export default function PdfView({ url, onReady, onError }: { url: string; onReady: () => void; onError: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const viewer = useRef<InstanceType<typeof PDFViewer>>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let live = true; // a closed view must not report its cancelled load as an error
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    linkService.externalLinkEnabled = false; // a link must not navigate the app away
    const v = new PDFViewer({ container: box.current!, eventBus, linkService, removePageBorders: false });
    linkService.setViewer(v);
    viewer.current = v;
    eventBus.on("pagesinit", () => {
      if (!live) return;
      v.currentScaleValue = "page-width";
      setPages(v.pagesCount);
      onReady();
    });
    eventBus.on("pagechanging", (e: { pageNumber: number }) => setPage(e.pageNumber));
    eventBus.on("scalechanging", (e: { scale: number }) => setScale(e.scale));

    // Range requests to the local media server: big PDFs show their first pages right away.
    const task = pdfjs.getDocument({ url });
    task.promise.then(
      (doc) => {
        if (!live) return;
        v.setDocument(doc);
        linkService.setDocument(doc);
      },
      () => live && onError(),
    );
    return () => {
      live = false;
      task.destroy();
      v.setDocument(null as never);
    };
  }, [url]);

  const v = viewer.current;
  const zoom = (f: number) => v && (v.currentScale = Math.min(8, Math.max(0.25, v.currentScale * f)));
  const go = (n: number) => v && pages && (v.currentPageNumber = Math.min(pages, Math.max(1, n)));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=") zoom(1.2);
      else if (e.key === "-") zoom(1 / 1.2);
      else if (e.key === "PageDown" || e.key === "j") go(page + 1);
      else if (e.key === "PageUp" || e.key === "k") go(page - 1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  return (
    <div className="absolute inset-0">
      {/* pdf.js needs an absolutely positioned scroll container. */}
      <div ref={box} className="pdf-view absolute inset-0 overflow-auto">
        <div className="pdfViewer" />
      </div>
      {pages > 0 && (
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 animate-rise items-center gap-0.5 rounded-lg border bg-popover/90 p-1 shadow-2xl backdrop-blur">
          <Tool label="Previous page (Page Up)" onClick={() => go(page - 1)}>
            <ChevronUp />
          </Tool>
          <span className="px-2 text-xs whitespace-nowrap tabular-nums">
            {page} / {pages}
          </span>
          <Tool label="Next page (Page Down)" onClick={() => go(page + 1)}>
            <ChevronDown />
          </Tool>
          <div className="mx-1 h-5 w-px bg-border" />
          <Tool label="Zoom out (−)" onClick={() => zoom(1 / 1.2)}>
            <ZoomOut />
          </Tool>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <Tool label="Zoom in (+)" onClick={() => zoom(1.2)}>
            <ZoomIn />
          </Tool>
          <div className="mx-1 h-5 w-px bg-border" />
          <Tool label="Fit width" onClick={() => v && (v.currentScaleValue = "page-width")}>
            <MoveHorizontal />
          </Tool>
          <Tool label="Fit page" onClick={() => v && (v.currentScaleValue = "page-fit")}>
            <Scan />
          </Tool>
        </div>
      )}
    </div>
  );
}
