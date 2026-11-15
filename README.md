# shad3

shad3 is a simple, fast S3 browser for Linux and Windows (x64 only). Rust ([Tauri 2](https://tauri.app) + AWS SDK) backend, React + Tailwind frontend.

Works with Amazon S3 and anything S3-compatible: Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, Hetzner, MinIO, Garage, Ceph…

- Add buckets in the sidebar (provider presets or "Other"), with **Test connection** and an offer to create the bucket if it is missing
- Browse folders, create files and folders (right-click → New file / New folder), rename and delete them
- Upload files and folders (button or drag & drop from your file manager); if names already exist you choose Replace, Keep both (adds a number) or Skip per file, or once for all. Download files and folders
- Parallel multipart uploads for big files, progress in the sidebar; × cancels a running transfer
- Right-click → Properties (Alt+Enter): size, type, ETag, storage class, encryption, headers and custom metadata; for folders the number of files and total size
- Edit text files in the built-in editor or in your own editor (Settings ⚙, pick it by name or Browse to its path): every save there is uploaded again. Edits never silently overwrite a file someone else changed meanwhile
- View images (zoom with wheel or + / −, drag to move, rotate, flip, 1:1 / fit), play videos and audio (seek, volume) right from the bucket, streamed; ← / → step through a folder. What plays depends on your system's codecs; on Fedora, H.264/H.265 video needs the codec packages from RPM Fusion
- Settings (⚙): light / dark / system theme, animations on or off, and per file type (text, pictures, videos, audio, other) open with the built-in viewer, your desktop's default app, or any program (e.g. VLC, which streams the file directly)
- Credits and licenses of every open-source component shad3 bundles (all Rust crates and npm packages, fonts, shadcn/ui) are under Settings → About
- Built-in PDF viewer (pdf.js) and spreadsheet viewer (SheetJS: xlsx, xls, ods, numbers)
- Activity history: recent actions bottom left, the full list with filters under Settings → History
- Select many files with the checkboxes on the left, by dragging a selection box, or with Ctrl / Shift click
- Keyboard: `Enter` open / edit, `Ctrl+S` save in the editor, `Backspace` up, `F2` rename, `Del` delete, `Ctrl+A` select all, `F5` refresh

Secret keys are stored encrypted in your system keyring (KWallet or GNOME Keyring via the Secret Service API; Credential Manager on Windows) and never reach the UI. The rest of each connection (bucket, endpoint, region, access key) is in `~/.config/de.lovinoes.shad3/profiles.json` (Windows: `%APPDATA%\de.lovinoes.shad3`).

## Build

Fedora:

```bash
sudo dnf install -y gcc gcc-c++ make cmake webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel rpm-build dbus-devel
```

Debian / Ubuntu:

```bash
sudo apt install -y build-essential cmake libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libdbus-1-dev pkg-config
```

Then:

```bash
npm install
npm run tauri dev      # run while developing
npm run tauri build -- --bundles rpm,deb,appimage   # in src-tauri/target/release/bundle/
```

### Windows

Windows installers (`.exe` and `.msi`) are built by GitHub Actions (`.github/workflows/build.yml`): push a tag like `v0.1.0` or start the workflow from the Actions tab, then download the artifacts. It builds the Linux packages too. To build on a Windows PC instead, install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) and run `npm install && npm run tauri build -- --bundles nsis,msi`.

## Tests

```bash
cd src-tauri && cargo test
```

The server test runs only when `S3_TEST_ENDPOINT` is set, for example against a local MinIO:

```bash
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_KEY=minioadmin S3_TEST_SECRET=minioadmin cargo test
```

## Licenses of bundled components

`src/licenses/third-party.json` lists every crate and npm package that ships in the app, with its license texts. Regenerate it after changing dependencies:

```bash
npm run credits
```

## Credits

App icon and UI icons: [Lucide](https://lucide.dev) (ISC License). Font: Chakra Petch (SIL Open Font License).
