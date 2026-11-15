// The main projects shad3 is built on. Their license texts come from licenses/third-party.json
// (every bundled component, generated from the installed packages by `npm run credits`); only
// what isn't a package there carries its own text.
import shadcn from "./licenses/shadcn-ui.txt?raw";

/** `pkg`: the package's name in third-party.json; `text` for credits that aren't packages. */
export type Credit = { name: string; what: string; license: string; url: string; pkg?: string; text?: string };

export const credits: Credit[] = [
  { name: "Tauri", what: "App framework", license: "MIT or Apache-2.0", url: "https://tauri.app", pkg: "tauri" },
  { name: "React", what: "User interface", license: "MIT", url: "https://react.dev", pkg: "react" },
  { name: "Monaco Editor", what: "Built-in text editor", license: "MIT", url: "https://microsoft.github.io/monaco-editor", pkg: "monaco-editor" },
  { name: "PDF.js", what: "Built-in PDF viewer, by Mozilla", license: "Apache-2.0", url: "https://mozilla.github.io/pdf.js", pkg: "pdfjs-dist" },
  { name: "SheetJS", what: "Built-in spreadsheet viewer", license: "Apache-2.0", url: "https://sheetjs.com", pkg: "xlsx" },
  { name: "AWS SDK for Rust", what: "S3 connection", license: "Apache-2.0", url: "https://github.com/awslabs/aws-sdk-rust", pkg: "aws-sdk-s3" },
  { name: "Tailwind CSS", what: "Styling", license: "MIT", url: "https://tailwindcss.com", pkg: "tailwindcss" },
  { name: "shadcn/ui", what: "Design tokens and component styles", license: "MIT", url: "https://ui.shadcn.com", text: shadcn },
  { name: "Lucide", what: "Icons and app icon", license: "ISC", url: "https://lucide.dev", pkg: "lucide-react" },
  { name: "Chakra Petch", what: "Font, by Cadson Demak", license: "SIL Open Font License 1.1", url: "https://github.com/m4rc1e/Chakra-Petch", pkg: "@fontsource/chakra-petch" },
  {
    name: "Codicons",
    what: "Icon font in the text editor",
    license: "CC BY 4.0",
    url: "https://github.com/microsoft/vscode-codicons",
    text: "Codicons © Microsoft Corporation.\nIncluded unmodified as part of Monaco Editor.\nLicensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0):\nhttps://creativecommons.org/licenses/by/4.0/",
  },
  { name: "Tokio", what: "Async runtime", license: "MIT", url: "https://tokio.rs", pkg: "tokio" },
  { name: "Serde", what: "Settings files", license: "MIT or Apache-2.0", url: "https://serde.rs", pkg: "serde" },
  { name: "keyring-rs", what: "Secret key storage", license: "MIT or Apache-2.0", url: "https://github.com/hwchen/keyring-rs", pkg: "keyring" },
  { name: "futures-rs", what: "Parallel transfers", license: "MIT or Apache-2.0", url: "https://github.com/rust-lang/futures-rs", pkg: "futures" },
  { name: "mime_guess", what: "File types", license: "MIT", url: "https://github.com/abonander/mime_guess", pkg: "mime_guess" },
  { name: "gtk-rs", what: "Desktop integration (Linux)", license: "MIT", url: "https://gtk-rs.org", pkg: "gtk" },
  { name: "dbus-rs", what: "Desktop theme (Linux)", license: "MIT or Apache-2.0", url: "https://github.com/diwic/dbus-rs", pkg: "dbus" },
];

/** Joins several license files of one package (e.g. MIT and Apache for dual-licensed ones). */
export const SEPARATOR = "\n\n――――――――\n\n";

export type Component = { name: string; version: string; source: "crate" | "npm"; license: string; url: string; texts: number[] };
export type Components = { texts: string[]; components: Component[] };
/** Every bundled component; loaded only when the About page asks for it (it is about 1 MB). */
export const loadAllComponents = () => import("./licenses/third-party.json").then((m) => m.default as Components);

/** A credit's license text, from its own text or its package in the generated list. */
export const creditText = (c: Credit, all: Components) => {
  if (c.text) return c.text;
  const p = all.components.find((x) => x.name === c.pkg);
  return p?.texts.map((t) => all.texts[t]).join(SEPARATOR) ?? `See ${c.url}`;
};
