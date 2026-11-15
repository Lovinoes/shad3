// Loaded lazily: Monaco is big, and most sessions never open the editor.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Bundled workers, so the editor works offline and under the app's CSP.
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// A lone file from a bucket has no project around it, so "cannot find module" errors are noise; keep syntax errors.
for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

// The app's shadcn neutral palette.
monaco.editor.defineTheme("shad3", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0a0a0a",
    "editor.foreground": "#fafafa",
    "editorLineNumber.foreground": "#525252",
    "editorLineNumber.activeForeground": "#d4d4d4",
    "editor.lineHighlightBackground": "#171717",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#404040",
    "editor.inactiveSelectionBackground": "#262626",
    "editorCursor.foreground": "#fafafa",
    "editorIndentGuide.background1": "#1f1f1f",
    "editorIndentGuide.activeBackground1": "#404040",
    "editorWidget.background": "#171717",
    "editorWidget.border": "#ffffff1a",
    "editorSuggestWidget.background": "#171717",
    "editorSuggestWidget.border": "#ffffff1a",
    "editorSuggestWidget.selectedBackground": "#262626",
    "editorHoverWidget.background": "#171717",
    "editorHoverWidget.border": "#ffffff1a",
    "input.background": "#0a0a0a",
    "input.border": "#ffffff26",
    "focusBorder": "#737373",
    "scrollbarSlider.background": "#ffffff1f",
    "scrollbarSlider.hoverBackground": "#ffffff33",
    "scrollbarSlider.activeBackground": "#ffffff40",
    "minimap.background": "#0a0a0a",
    "widget.shadow": "#00000080",
  },
});

monaco.editor.defineTheme("shad3-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#0a0a0a",
    "editorLineNumber.foreground": "#a3a3a3",
    "editorLineNumber.activeForeground": "#404040",
    "editor.lineHighlightBackground": "#f5f5f5",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#d4d4d4",
    "editor.inactiveSelectionBackground": "#e5e5e5",
    "editorCursor.foreground": "#0a0a0a",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e5e5e5",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#e5e5e5",
    "editorSuggestWidget.selectedBackground": "#f5f5f5",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#e5e5e5",
    "focusBorder": "#a3a3a3",
    "scrollbarSlider.background": "#00000020",
    "scrollbarSlider.hoverBackground": "#00000035",
    "minimap.background": "#ffffff",
  },
});

/** Follows the app theme (html[data-theme]), also when it changes while the editor is open. */
const editorTheme = () => (document.documentElement.dataset.theme === "light" ? "shad3-light" : "shad3");
new MutationObserver(() => monaco.editor.setTheme(editorTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

export default function CodeEditor({ path, value, onChange, onSave }: { path: string; value: string; onChange: (v: string) => void; onSave: (v: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    // The file name picks the language (e.g. .ts, .json, .py, .yaml).
    const model = monaco.editor.createModel(value, undefined, monaco.Uri.file(path));
    const ed = monaco.editor.create(el.current!, {
      model,
      theme: editorTheme(),
      automaticLayout: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 12 },
      scrollBeyondLastLine: false,
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cb.current.onSave(ed.getValue()));
    ed.onDidChangeModelContent(() => cb.current.onChange(ed.getValue()));
    ed.focus();
    return () => {
      ed.dispose();
      model.dispose();
    };
    // Recreated only for a different file; `value` is the starting text.
  }, [path]);

  return <div ref={el} className="h-full w-full" />;
}
