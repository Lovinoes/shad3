// Writes src/licenses/third-party.json: every open-source component shipped in shad3 with its
// license texts, read from the packages themselves. Run `npm run credits` after changing
// dependencies (needs `cargo` and an installed node_modules).
//
// Rust: all normal (non-dev, non-build) dependencies of the app on the targets it ships for
// (x64 Linux and Windows). JavaScript: everything reachable from package.json "dependencies",
// plus Tailwind CSS and Vite themselves (their generated code ends up in the app, their build
// tooling does not).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|thirdpartynotices)/i;

const texts = [];
const textIndex = new Map();
/** Stores each distinct license text once; returns its index. */
const store = (text) => {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!textIndex.has(t)) textIndex.set(t, texts.push(t) - 1);
  return textIndex.get(t);
};
const licenseTexts = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && LICENSE_FILE.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => store(readFileSync(join(dir, f.name), "utf8")));

const repoUrl = (r) => {
  let u = typeof r === "string" ? r : r?.url;
  if (!u) return "";
  u = u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
  if (/^github:/.test(u)) u = `https://github.com/${u.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`;
  return u.startsWith("https://") ? u : "";
};

const components = [];

// --- Rust crates ---
const targets = ["x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"].flatMap((t) => ["--filter-platform", t]);
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", ...targets, "--manifest-path", join(root, "src-tauri/Cargo.toml")], { maxBuffer: 1 << 28 }),
);
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const seen = new Set([meta.resolve.root]);
const queue = [meta.resolve.root];
while (queue.length) {
  for (const d of nodes.get(queue.shift()).deps) {
    if (seen.has(d.pkg) || !d.dep_kinds.some((k) => k.kind === null)) continue;
    seen.add(d.pkg);
    queue.push(d.pkg);
  }
}
seen.delete(meta.resolve.root);
for (const id of seen) {
  const p = pkgs.get(id);
  components.push({
    name: p.name,
    version: p.version,
    source: "crate",
    license: p.license ?? (p.license_file ? "See license file" : "Unknown"),
    url: repoUrl(p.repository) || repoUrl(p.homepage) || `https://crates.io/crates/${p.name}`,
    texts: licenseTexts(dirname(p.manifest_path)),
  });
}

// --- JavaScript packages ---
const resolve = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dir === dirname(dir)) return null;
  }
};
const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmSeen = new Set();
const walk = (name, from, deps = true) => {
  const dir = resolve(name, from);
  if (!dir || npmSeen.has(dir)) return;
  npmSeen.add(dir);
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  components.push({
    name: p.name,
    version: p.version,
    source: "npm",
    license: typeof p.license === "string" ? p.license : (p.license?.type ?? "Unknown"),
    url: repoUrl(p.repository) || repoUrl(p.homepage) || `https://www.npmjs.com/package/${p.name}`,
    texts: licenseTexts(dir),
  });
  // Optional dependencies are native helpers for Node (e.g. pdf.js's canvas), never in the app.
  if (deps) for (const dep of Object.keys(p.dependencies ?? {})) walk(dep, dir);
};
for (const name of Object.keys(top.dependencies)) walk(name, root);
for (const name of ["tailwindcss", "vite"]) walk(name, root, false);

components.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
writeFileSync(join(root, "src/licenses/third-party.json"), JSON.stringify({ texts, components }) + "\n");
const crates = components.filter((c) => c.source === "crate").length;
const missing = components.filter((c) => !c.texts.length).map((c) => `${c.name}@${c.version}`);
console.log(`${components.length} components (${crates} crates, ${components.length - crates} npm), ${texts.length} distinct license texts.`);
if (missing.length) console.log(`No license file shipped with: ${missing.join(", ")}`);
