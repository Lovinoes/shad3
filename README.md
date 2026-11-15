# shad3

A simple S3 browser for Linux (and Windows), styled to match my site ([lovinoes.de](https://lovinoes.de)).

Works with AWS S3 and anything S3-compatible: Cloudflare R2, Backblaze B2, Hetzner, Wasabi, MinIO etc.

Built with Tauri, Rust and React. x64 only.

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
