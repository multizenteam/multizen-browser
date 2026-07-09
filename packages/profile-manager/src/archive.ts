import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import type { Profile } from "@multizen/types";

const scrypt = promisify(scryptCb);

const MAGIC = "MZAR";
/** v1 = profile user-data-dir only. v2 = also bundles shared-store extension
 *  code so a fresh machine gets working extensions, not dangling references. */
const VERSION = 2;
/** Archive versions this build can read. */
const SUPPORTED_VERSIONS = new Set([1, 2]);
/** AES-256-GCM */
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

interface FileMeta {
  path: string;
  size: number;
  sha256: string;
}

interface BundledExtension {
  id: string;
  version: string;
  files: FileMeta[];
}

interface ArchiveManifest {
  magic: typeof MAGIC;
  version: number;
  profile: Profile;
  files: FileMeta[];
  /** v2+: shared-store extensions bundled into the archive. Their file
   *  payloads follow the profile files in the same sequential framing. */
  extensions?: BundledExtension[];
}

export interface ExportOptions {
  /**
   * Shared-store extension directories to bundle into the archive so importing
   * on another machine restores the extension code too (not just a reference
   * that dangles until the user re-adds it). Each entry's files are read from
   * `dir` and stored under the extension's (id, version).
   */
  extensions?: Array<{ id: string; version: string; dir: string }>;
}

/**
 * Pack a profile (metadata + on-disk user-data-dir) into a single
 * encrypted archive file. Use a passphrase the user remembers; we don't
 * store passphrases on our servers.
 *
 * Format (v1):
 *   bytes 0..3      "MZAR" magic
 *   bytes 4..5      version (uint16 BE)
 *   bytes 6..21     salt (16 bytes)
 *   bytes 22..33    iv (12 bytes)
 *   bytes 34..N     ciphertext (manifest JSON + concatenated file contents)
 *   bytes N..N+15   GCM auth tag (16 bytes, last)
 */
export async function exportProfile(
  profile: Profile,
  passphrase: string,
  outPath: string,
  opts: ExportOptions = {},
): Promise<void> {
  const files = await collectFiles(profile.dataDir);

  // Collect bundled extensions (v2). Each extension's files are appended after
  // the profile files, in the same [len][content] framing, so import can read
  // them sequentially by walking manifest.files then manifest.extensions.
  const bundled: BundledExtension[] = [];
  const extChunks: Buffer[] = [];
  for (const ext of opts.extensions ?? []) {
    const extFiles = await collectFiles(ext.dir);
    if (extFiles.length === 0) continue; // nothing on disk to bundle
    bundled.push({
      id: ext.id,
      version: ext.version,
      files: extFiles.map((f) => ({ path: f.relPath, size: f.size, sha256: f.sha256 })),
    });
    for (const f of extFiles) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(f.size, 0);
      extChunks.push(len);
      extChunks.push(await readFile(f.absPath));
    }
  }

  const manifest: ArchiveManifest = {
    magic: MAGIC,
    version: VERSION,
    profile,
    files: files.map((f) => ({ path: f.relPath, size: f.size, sha256: f.sha256 })),
    extensions: bundled.length > 0 ? bundled : undefined,
  };

  const manifestJson = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestLen = Buffer.alloc(4);
  manifestLen.writeUInt32BE(manifestJson.length, 0);

  const fileChunks: Buffer[] = [];
  for (const f of files) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(f.size, 0);
    fileChunks.push(len);
    fileChunks.push(await readFile(f.absPath));
  }

  const plaintext = Buffer.concat([manifestLen, manifestJson, ...fileChunks, ...extChunks]);

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = (await scrypt(passphrase, salt, KEY_LEN)) as Buffer;

  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(6);
  header.write(MAGIC, 0, 4, "ascii");
  header.writeUInt16BE(VERSION, 4);

  const out = Buffer.concat([header, salt, iv, ciphertext, tag]);
  await writeFile(outPath, out);
}

export interface ImportOptions {
  /**
   * Predicate telling whether a profile id already exists locally. When the
   * archive's original id is taken (re-importing on the same machine), the
   * restore gets a fresh id — so it lands in its OWN dataDir and never
   * overwrites the existing profile's files.
   */
  idTaken?: (id: string) => boolean;
  /**
   * Shared extension store root (`<userData>/data/extension-store`). When set,
   * v2 archives restore their bundled extensions here (under `<id>/<version>`)
   * so a fresh machine has the extension code. An existing store entry is left
   * untouched (never clobbered). When unset, bundled extensions are ignored.
   */
  extensionStoreRoot?: string;
}

export async function importProfile(
  archivePath: string,
  passphrase: string,
  destProfilesRoot: string,
  opts: ImportOptions = {},
): Promise<Profile> {
  const buf = await readFile(archivePath);
  if (buf.subarray(0, 4).toString("ascii") !== MAGIC) {
    throw new Error("Not a MultiZen archive");
  }
  const version = buf.readUInt16BE(4);
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`Unsupported archive version: ${version}`);
  }

  const salt = buf.subarray(6, 6 + SALT_LEN);
  const iv = buf.subarray(6 + SALT_LEN, 6 + SALT_LEN + IV_LEN);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(6 + SALT_LEN + IV_LEN, buf.length - 16);

  const key = (await scrypt(passphrase, salt, KEY_LEN)) as Buffer;
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure ⇒ wrong passphrase (or a tampered/corrupt archive).
    throw new Error("Wrong passphrase or corrupted archive.");
  }

  let cursor = 0;
  const manifestLen = plaintext.readUInt32BE(cursor);
  cursor += 4;
  const manifest = JSON.parse(
    plaintext.subarray(cursor, cursor + manifestLen).toString("utf8"),
  ) as ArchiveManifest;
  cursor += manifestLen;

  // Preserve the original id when free (faithful move to another machine); mint
  // a fresh one if it's already taken here (duplicate import), OR if the
  // archive's id is not a safe path segment. The id becomes a directory name
  // (`<profilesRoot>/<id>`), so an attacker-crafted id like "" or ".." could
  // otherwise redirect the whole restore outside its own dataDir.
  const original = manifest.profile.id;
  const idUsable = isSafeIdSegment(original) && !opts.idTaken?.(original);
  const targetId = idUsable ? original : randomUUID();
  const restored: Profile = {
    ...manifest.profile,
    id: targetId,
    dataDir: join(destProfilesRoot, targetId),
  };

  await mkdir(restored.dataDir, { recursive: true });

  for (const fileMeta of manifest.files) {
    const len = plaintext.readUInt32BE(cursor);
    cursor += 4;
    const content = plaintext.subarray(cursor, cursor + len);
    cursor += len;
    verifyChecksum(fileMeta, content);
    await writeGuarded(restored.dataDir, fileMeta.path, content);
  }

  // v2: restore bundled shared-store extensions. The chunks follow the profile
  // files in the same order as manifest.extensions[].files. We always read the
  // chunks (to stay checksum-honest even when we skip writing), but only write
  // to the store when a root is provided and the entry isn't already present.
  for (const ext of manifest.extensions ?? []) {
    const destDir = opts.extensionStoreRoot
      ? join(opts.extensionStoreRoot, sanitizeSegment(ext.id), sanitizeSegment(ext.version || "0"))
      : null;
    // Don't clobber an extension the user already has in the store.
    const skipWrite = !destDir || existsSync(destDir);
    for (const fileMeta of ext.files) {
      const len = plaintext.readUInt32BE(cursor);
      cursor += 4;
      const content = plaintext.subarray(cursor, cursor + len);
      cursor += len;
      verifyChecksum(fileMeta, content);
      if (skipWrite || !destDir) continue;
      await writeGuarded(destDir, fileMeta.path, content);
    }
  }

  return restored;
}

/** Throw if the content's SHA-256 doesn't match the manifest entry. */
function verifyChecksum(fileMeta: FileMeta, content: Buffer): void {
  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== fileMeta.sha256) {
    throw new Error(`Checksum mismatch for ${fileMeta.path}`);
  }
}

/**
 * Write `content` to `relPath` inside `baseDir`, refusing any path that escapes
 * baseDir. Compare against `base + sep` so a sibling sharing the prefix can't
 * slip through, and reject the base itself as a file target.
 */
async function writeGuarded(baseDir: string, relPath: string, content: Buffer): Promise<void> {
  const base = resolve(baseDir);
  const absPath = resolve(base, relPath);
  if (absPath !== base && !absPath.startsWith(base + sep)) {
    throw new Error(`Refusing path-traversal entry: ${relPath}`);
  }
  await mkdir(join(absPath, ".."), { recursive: true });
  await writeFile(absPath, content);
}

/**
 * A store path segment (extension id / version) taken from an untrusted archive
 * becomes a directory name, so reject anything that isn't a plain segment —
 * "", ".", "..", or containing a separator would let a crafted archive escape
 * the store root.
 */
function sanitizeSegment(seg: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seg) || seg === "." || seg === "..") {
    throw new Error(`Refusing unsafe extension path segment: ${seg}`);
  }
  return seg;
}

/**
 * A profile id is used verbatim as a directory name, so restrict it to a plain
 * single path segment (uuids qualify). Rejects "", ".", "..", and anything with
 * a path separator — the values that would let a crafted archive escape its
 * dataDir.
 */
function isSafeIdSegment(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== "." && id !== "..";
}

interface CollectedFile {
  absPath: string;
  relPath: string;
  size: number;
  sha256: string;
}

async function collectFiles(root: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const stat = statSync(abs);
        const sha = await fileSha256(abs);
        out.push({
          absPath: abs,
          relPath: relative(root, abs),
          size: stat.size,
          sha256: sha,
        });
      }
    }
  }
  try {
    await walk(root);
  } catch (e) {
    // Profile may not yet have a populated user-data-dir
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return out;
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Suppress unused-import warning for createWriteStream (kept for potential streaming variant)
void createWriteStream;
