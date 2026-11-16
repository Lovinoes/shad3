# shad3

> [!WARNING]
> This app is fully vibecoded: it was written by AI (Claude Opus 5.5, using the ponytail skill) and only parts of it were reviewed by a human. Use it at your own risk.

A simple S3 browser for Linux (and Windows). I made it for myself: I needed a better S3 browser than the ones out there, they're all shit, so I vibecoded my own.

It should work with standard S3 providers like AWS, Cloudflare R2, Backblaze B2, Hetzner, Wasabi or MinIO. I only tested it on Datalix Object Storage.

Built with Tauri, Rust and React. x64 only.

## Features

- Browse, upload, download, rename and delete files and folders (drag & drop works too)
- Built-in viewers for pictures, videos, audio, PDFs and spreadsheets
- Built-in text editor, or open files in your own apps (VLC, your editor, ...)
- File properties and metadata
- Activity history
- Secret keys stored in your system keyring
- Light and dark theme

## Building

You need Node and Rust, plus these packages.

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
npm run tauri dev
```

To build the `.rpm`, `.deb` and AppImage (they end up in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build -- --bundles rpm,deb,appimage
```

The Windows installers are built by GitHub Actions. Push a tag like `v0.1.0` or run the workflow by hand.

## Good to know

- Secret keys are stored in your system keyring (GNOME Keyring, KWallet, or Credential Manager on Windows). Everything else is in `~/.config/de.lovinoes.shad3/`.
- Videos play with your system's codecs. On Fedora, H.264 and H.265 need the codecs from RPM Fusion.

## Tests

```bash
cd src-tauri && cargo test
```

One test talks to a real S3 server and only runs when you point it at one:

```bash
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_KEY=minioadmin S3_TEST_SECRET=minioadmin cargo test
```

## Licenses

The licenses of everything shad3 ships with are in the app under Settings → About. After changing dependencies, update that list with:

```bash
npm run credits
```
