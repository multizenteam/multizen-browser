import { createReadStream, createWriteStream, statSync } from "node:fs";
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
const VERSION = 1;
/** AES-256-GCM */
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

interface ArchiveManifest {
  magic: typeof MAGIC;
  version: number;
  profile: Profile;
  files: Array<{ path: string; size: number; sha256: string }>;
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
): Promise<void> {
  const files = await collectFiles(profile.dataDir);
  const manifest: ArchiveManifest = {
    magic: MAGIC,
    version: VERSION,
    profile,
    files: files.map((f) => ({ path: f.relPath, size: f.size, sha256: f.sha256 })),
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

  const plaintext = Buffer.concat([manifestLen, manifestJson, ...fileChunks]);

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
  if (version !== VERSION) {
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

    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== fileMeta.sha256) {
      throw new Error(`Checksum mismatch for ${fileMeta.path}`);
    }

    const base = resolve(restored.dataDir);
    const absPath = resolve(base, fileMeta.path);
    // Must stay strictly inside dataDir. Compare against `base + sep` so a
    // sibling dir sharing the prefix (…/<id>-evil) can't slip through, and
    // reject the base itself as a file target.
    if (absPath !== base && !absPath.startsWith(base + sep)) {
      throw new Error(`Refusing path-traversal entry: ${fileMeta.path}`);
    }
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content);
  }

  return restored;
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
