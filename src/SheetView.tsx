// Loaded lazily: SheetJS is large and only needed when a spreadsheet is opened.
import { useEffect, useMemo, useState } from "react";
import { read, utils, type WorkBook } from "xlsx";
import { cn } from "./ui";

const MAX_BYTES = 50 * 1024 * 1024;
// shortcut: shows the first rows/columns only; virtualize the grid if huge sheets must be browsed here.
const MAX_ROWS = 5000;
const MAX_COLS = 200;

/** A, B, …, Z, AA, AB, … */
const column = (i: number): string => (i >= 26 ? column(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** Read-only grid for xlsx / xls / ods / numbers with a tab per sheet. Cells are plain text, never HTML. */
export default function SheetView({ url, onReady, onError }: { url: string; onReady: () => void; onError: () => void }) {
  const [book, setBook] = useState<WorkBook | null>(null);
  const [sheet, setSheet] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => {
        if (!r.ok || Number(r.headers.get("content-length")) > MAX_BYTES) throw new Error();
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!live) return;
        setBook(read(buf, { dense: true, cellDates: true }));
        onReady();
      })
      .catch(() => live && onError());
    return () => {
      live = false;
    };
  }, [url]);

  const { rows, cols, clipped } = useMemo(() => {
    if (!book) return { rows: [] as string[][], cols: 0, clipped: false };
    const ws = book.Sheets[book.SheetNames[sheet]];
    // Formatted text as the spreadsheet shows it (dates, currency, percentages).
    const all = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: true, defval: "" });
    const width = Math.min(MAX_COLS, Math.max(0, ...all.slice(0, MAX_ROWS).map((r) => r.length)));
    return {
      rows: all.slice(0, MAX_ROWS).map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? ""))),
      cols: width,
      clipped: all.length > MAX_ROWS || all.some((r) => r.length > MAX_COLS),
    };
  }, [book, sheet]);

  if (!book) return null;
  return (
    <div className="absolute inset-x-16 inset-y-6 flex animate-fade flex-col overflow-hidden rounded-lg border bg-card shadow-2xl">
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">This sheet is empty.</p>
        ) : (
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 border-r border-b bg-accent" />
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i} className="sticky top-0 z-10 min-w-16 border-r border-b bg-accent px-2 py-1 font-medium text-muted-foreground">
                    {column(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y}>
                  <th className="sticky left-0 z-10 border-r border-b bg-accent px-2 py-1 text-right font-medium text-muted-foreground tabular-nums">{y + 1}</th>
                  {r.map((v, x) => (
                    <td key={x} title={v.length > 40 ? v : undefined} className="max-w-96 truncate border-r border-b px-2 py-1 whitespace-nowrap">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-t bg-background/60 p-1">
        {book.SheetNames.map((name, i) => (
          <button
            key={name}
            onClick={() => setSheet(i)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1 text-xs transition-colors",
              i === sheet ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {name}
          </button>
        ))}
        {clipped && (
          <span className="ml-auto shrink-0 px-2 text-xs text-muted-foreground">
            Showing the first {MAX_ROWS.toLocaleString()} rows and {MAX_COLS} columns
          </span>
        )}
      </div>
    </div>
  );
}
