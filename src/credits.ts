// License texts are copied verbatim from the installed packages (node_modules and the Cargo
// registry); shadcn/ui's from its repository. The complete list of every bundled component is
// generated into licenses/third-party.json by `npm run credits`.
import awsSdk from "./licenses/aws-sdk-rust.txt?raw";
import chakraPetch from "./licenses/chakra-petch.txt?raw";
import dbus from "./licenses/dbus-rs.txt?raw";
import futures from "./licenses/futures.txt?raw";
import gtk from "./licenses/gtk-rs.txt?raw";
import keyring from "./licenses/keyring.txt?raw";
import lucide from "./licenses/lucide.txt?raw";
import mimeGuess from "./licenses/mime_guess.txt?raw";
import pdfjs from "./licenses/pdfjs.txt?raw";
import sheetjs from "./licenses/sheetjs.txt?raw";
import monaco from "./licenses/monaco-editor.txt?raw";
import react from "./licenses/react.txt?raw";
import serde from "./licenses/serde.txt?raw";
import shadcn from "./licenses/shadcn-ui.txt?raw";
import tailwind from "./licenses/tailwindcss.txt?raw";
import tauri from "./licenses/tauri.txt?raw";
import tokio from "./licenses/tokio.txt?raw";

export type Credit = { name: string; what: string; license: string; url: string; text: string };

export const credits: Credit[] = [
  { name: "Tauri", what: "App framework", license: "MIT or Apache-2.0", url: "https://tauri.app", text: tauri },
  { name: "React", what: "User interface", license: "MIT", url: "https://react.dev", text: react },
  { name: "Monaco Editor", what: "Built-in text editor", license: "MIT", url: "https://microsoft.github.io/monaco-editor", text: monaco },
  { name: "PDF.js", what: "Built-in PDF viewer, by Mozilla", license: "Apache-2.0", url: "https://mozilla.github.io/pdf.js", text: pdfjs },
  { name: "SheetJS", what: "Built-in spreadsheet viewer", license: "Apache-2.0", url: "https://sheetjs.com", text: sheetjs },
  { name: "AWS SDK for Rust", what: "S3 connection", license: "Apache-2.0", url: "https://github.com/awslabs/aws-sdk-rust", text: awsSdk },
  { name: "Tailwind CSS", what: "Styling", license: "MIT", url: "https://tailwindcss.com", text: tailwind },
  { name: "shadcn/ui", what: "Design tokens and component styles", license: "MIT", url: "https://ui.shadcn.com", text: shadcn },
  { name: "Lucide", what: "Icons and app icon", license: "ISC", url: "https://lucide.dev", text: lucide },
  { name: "Chakra Petch", what: "Font, by Cadson Demak", license: "SIL Open Font License 1.1", url: "https://github.com/m4rc1e/Chakra-Petch", text: chakraPetch },
  {
    name: "Codicons",
    what: "Icon font in the text editor",
    license: "CC BY 4.0",
    url: "https://github.com/microsoft/vscode-codicons",
    text: "Codicons © Microsoft Corporation.\nIncluded unmodified as part of Monaco Editor.\nLicensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0):\nhttps://creativecommons.org/licenses/by/4.0/",
  },
  { name: "Tokio", what: "Async runtime", license: "MIT", url: "https://tokio.rs", text: tokio },
  { name: "Serde", what: "Settings files", license: "MIT or Apache-2.0", url: "https://serde.rs", text: serde },
  { name: "keyring-rs", what: "Secret key storage", license: "MIT or Apache-2.0", url: "https://github.com/hwchen/keyring-rs", text: keyring },
  { name: "futures-rs", what: "Parallel transfers", license: "MIT or Apache-2.0", url: "https://github.com/rust-lang/futures-rs", text: futures },
  { name: "mime_guess", what: "File types", license: "MIT", url: "https://github.com/abonander/mime_guess", text: mimeGuess },
  { name: "gtk-rs", what: "Desktop integration (Linux)", license: "MIT", url: "https://gtk-rs.org", text: gtk },
  { name: "dbus-rs", what: "Desktop theme (Linux)", license: "MIT or Apache-2.0", url: "https://github.com/diwic/dbus-rs", text: dbus },
];

export type Component = { name: string; version: string; source: "crate" | "npm"; license: string; url: string; texts: number[] };
/** Every bundled component; loaded only when the About page asks for it (it is about 1 MB). */
export const loadAllComponents = () =>
  import("./licenses/third-party.json").then((m) => m.default as { texts: string[]; components: Component[] });
