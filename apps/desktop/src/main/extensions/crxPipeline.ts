import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extract from "extract-zip";
import type { ExtensionConfig } from "@multizen/types";
import { storeEntryDir } from "./extensionStore.ts";

const MAX_UNPACKED_BYTES = 150 * 1024 * 1024; // ~150 MB cap per extension

interface CrxUnwrapResult {
  /** Path to the inner zip (or the original path when the input wasn't a CRX). */
  zipPath: string;
  /** The developer's DER public key, if recoverable from the CRX header. The
   *  Chrome Web Store ID is SHA-256(this)[:16]; injecting it as manifest `key`
   *  makes the unpacked extension load under its genuine store ID. */
  publicKey?: Buffer;
}

export interface UnpackToStoreInput {
  /** Absolute path to a .crx file, .zip file, or an unpacked extension folder. */
  source: string;
  /** Root of the shared store, e.g. `<userData>/data/extension-store`. */
  storeRoot: string;
  /** How the extension was obtained (for the stored ExtensionConfig). */
  origin: ExtensionConfig["source"];
}

/**
 * Validate + unpack an extension into the SHARED store at
 * `<storeRoot>/<id>/<version>/`, deduped by id+version, and return a shared
 * ExtensionConfig reference. The bytes are stored once and loaded into any
 * number of profiles via --load-extension.
 *
 * Identity:
 *  - Web Store / CRX with a recoverable developer key → the genuine store ID,
 *    and the key is injected into the stored manifest.json so Chromium loads the
 *    extension under that real ID (looks like a normal install; not anomalous).
 *  - Keyless folder/zip → a stable content-hash ID (shareable + dedupable).
 *  - If a manifest already carries a `key`, that ID is used as-is.
 * Key recovery failure NEVER blocks the install — it degrades to the
 * content-hash ID.
 *
 * Atomic + concurrent-safe: everything happens in a temp staging dir and is
 * renamed into the final entry only once validated. If the target entry already
 * exists (another profile installed the same id+version, possibly concurrently)
 * the stage is discarded and the existing entry reused.
 */
export async function unpackToStore(input: UnpackToStoreInput): Promise<ExtensionConfig> {
  const { source, storeRoot, origin } = input;
  if (!existsSync(source)) throw new Error(`Extension source not found: ${source}`);

  await mkdir(storeRoot, { recursive: true });
  const staging = join(storeRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });

  try {
    let publicKey: Buffer | undefined;
    const info = await stat(source);
    if (info.isDirectory()) {
      await cp(source, staging, { recursive: true });
    } else {
      const unwrapped = await crxToZip(source, staging);
      publicKey = unwrapped.publicKey;
      await extract(unwrapped.zipPath, { dir: staging });
      if (unwrapped.zipPath !== source) await rm(unwrapped.zipPath, { force: true });
    }

    const root = await resolveManifestRoot(staging);
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("No manifest.json found in the extension.");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest_version?: number;
      name?: string;
      version?: string;
      default_locale?: string;
      key?: string;
    };
    if (manifest.manifest_version !== 3) {
      throw new Error(
        `Manifest V${manifest.manifest_version ?? "?"} isn't supported by modern Chromium — only V3 extensions can be loaded.`,
      );
    }

    const size = await dirSize(root);
    if (size > MAX_UNPACKED_BYTES) {
      throw new Error(
        `Extension is too large (${Math.round(size / 1024 / 1024)} MB > 150 MB limit).`,
      );
    }

    // Determine the extension identity, preferring the genuine store key.
    let id: string;
    if (manifest.key) {
      // Manifest already pins the key → already the genuine store ID.
      id = computeExtensionId({ key: manifest.key });
    } else if (publicKey) {
      // Recovered the dev key from the CRX header → inject it so Chromium loads
      // under the real store ID, and key our entry by that ID.
      const keyB64 = publicKey.toString("base64");
      id = computeExtensionId({ key: keyB64 });
      manifest.key = keyB64;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    } else {
      // Keyless (folder/zip, or a CRX whose key we couldn't parse) → stable
      // content-hash ID. Install still succeeds; just no store-ID benefit.
      id = await contentHashId(root);
    }
    const version = manifest.version ?? "";
    const name = await resolveName(manifest, root);

    const finalDir = storeEntryDir(storeRoot, id, version);
    if (existsSync(finalDir)) {
      // Already in the store (same id+version) — reuse, discard our stage. This
      // is the dedup + concurrent-install convergence point.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    } else {
      await mkdir(join(finalDir, ".."), { recursive: true });
      try {
        await rename(root, finalDir);
      } catch (e) {
        // A concurrent installer may have published the same entry between our
        // existsSync check and rename — treat an existing target as success.
        if (existsSync(finalDir)) {
          await rm(staging, { recursive: true, force: true }).catch(() => {});
        } else {
          throw e;
        }
      }
      if (root !== staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    return {
      id,
      name,
      version,
      enabled: true,
      scope: "shared",
      dir: "",
      source: origin,
    };
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Strip the CRX2/CRX3 header off a .crx, writing the inner zip to `outDir`. */
async function crxToZip(crxPath: string, outDir: string): Promise<CrxUnwrapResult> {
  const buf = await readFile(crxPath);
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") {
    // Not a CRX — maybe a plain zip mislabeled. Use as-is.
    return { zipPath: crxPath };
  }
  const version = buf.readUInt32LE(4);
  let zipStart: number;
  let publicKey: Buffer | undefined;
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
    // The CRX3 header is a `CrxFileHeader` protobuf carrying the dev public key.
    publicKey = extractCrx3PublicKey(buf.subarray(12, 12 + headerLen));
  } else if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
    if (pubKeyLen > 0 && 16 + pubKeyLen <= buf.length) {
      publicKey = Buffer.from(buf.subarray(16, 16 + pubKeyLen));
    }
  } else {
    throw new Error(`Unsupported CRX version ${version}.`);
  }
  if (zipStart <= 0 || zipStart >= buf.length) {
    throw new Error("Corrupt CRX: invalid zip offset.");
  }
  const zipPath = join(outDir, `${randomUUID()}.zip`);
  await writeFile(zipPath, buf.subarray(zipStart));
  return { zipPath, publicKey };
}

/**
 * Pull the developer public key out of a CRX3 `CrxFileHeader` protobuf:
 *   CrxFileHeader {
 *     repeated AsymmetricKeyProof sha256_with_rsa   = 2;
 *     repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
 *     optional bytes signed_header_data             = 10000;  // SignedData
 *   }
 *   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *   SignedData         { bytes crx_id     = 1; }              // 16-byte ID
 *
 * Store CRX3 files carry MULTIPLE proofs (the extension's own key plus Google's
 * "verified contents" key), so the FIRST proof is not necessarily the right one.
 * The canonical ID lives in `signed_header_data.crx_id`; we return the proof
 * whose SHA-256(public_key)[:16] matches that id. Minimal length-delimited
 * reader, no proto dependency. Returns undefined on any malformed/ambiguous
 * input (no matching proof, no crx_id) so the install degrades to a content-hash
 * ID rather than ever injecting a WRONG key.
 */
function extractCrx3PublicKey(header: Buffer): Buffer | undefined {
  try {
    const signed = firstField(header, 10000);
    const crxId = signed ? firstField(signed, 1) : undefined;
    if (!crxId || crxId.length !== 16) return undefined;
    const proofs = [...collectFields(header, 2), ...collectFields(header, 3)];
    for (const proof of proofs) {
      const pk = firstField(proof, 1);
      if (!pk || pk.length === 0) continue;
      const digest = createHash("sha256").update(pk).digest().subarray(0, 16);
      if (digest.equals(crxId)) return Buffer.from(pk);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** All length-delimited (wire type 2) sub-messages for `field` in `msg`. */
function collectFields(msg: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < msg.length) {
    const [tag, t1] = readVarint(msg, i);
    i = t1;
    const f = tag >>> 3;
    const wire = tag & 0x7;
    if (wire !== 2) {
      i = skipField(msg, i, wire);
      continue;
    }
    const [len, t2] = readVarint(msg, i);
    i = t2;
    if (f === field) out.push(msg.subarray(i, i + len));
    i += len;
  }
  return out;
}

/** First length-delimited sub-field (`field`, wire type 2) of `msg`. */
function firstField(msg: Buffer, field: number): Buffer | undefined {
  return collectFields(msg, field)[0];
}

/** Decode a base-128 varint at `pos`; returns [value, nextPos]. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error("varint overrun");
    const byte = buf[i] ?? 0;
    result += (byte & 0x7f) * Math.pow(2, shift);
    i++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 49) throw new Error("varint too long");
  }
  return [result, i];
}

/** Advance past a non-length-delimited field given its wire type. */
function skipField(buf: Buffer, pos: number, wire: number): number {
  if (wire === 0) return readVarint(buf, pos)[1]; // varint
  if (wire === 5) return pos + 4; // 32-bit
  if (wire === 1) return pos + 8; // 64-bit
  throw new Error(`unsupported wire type ${wire}`);
}

/**
 * Compute the Chromium extension ID. With a manifest `key`, it's the SHA-256 of
 * the DER public key; otherwise it's the SHA-256 of the absolute install path
 * (how Chromium derives the ID for unpacked extensions). First 16 bytes, hex,
 * mapped 0–f → a–p.
 */
export function computeExtensionId(opts: { key?: string; absPath?: string }): string {
  let digestInput: Buffer;
  if (opts.key) {
    digestInput = Buffer.from(opts.key, "base64");
  } else {
    digestInput = Buffer.from(opts.absPath ?? "", "utf8");
  }
  return hashToId(createHash("sha256").update(digestInput).digest());
}

/** Map a digest to a Chromium-style 32-char a–p extension ID (first 16 bytes). */
function hashToId(hash: Buffer): string {
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i] ?? 0;
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * Deterministic ID derived from the unpacked file tree — used for keyless
 * folder/zip installs (no developer key to recover). Identical bytes always
 * yield the same ID, so two profiles uploading the same extension dedup to one
 * shared store entry. Hashes each file's relative path + contents in sorted
 * order so the result is independent of filesystem walk order.
 */
async function contentHashId(dir: string): Promise<string> {
  const files: string[] = [];
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === "." ? dir : join(dir, rel);
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks (DoS / escape)
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) files.push(childRel);
    }
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(join(dir, rel)));
  }
  return hashToId(hash.digest());
}

/** If `dir` has no manifest.json but a single subdirectory that does, return it. */
async function resolveManifestRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());
  if (subdirs.length === 1 && subdirs[0]) {
    const inner = join(dir, subdirs[0].name);
    if (existsSync(join(inner, "manifest.json"))) return inner;
  }
  return dir;
}

/** Resolve a display name, dereferencing `__MSG_x__` via the default locale. */
async function resolveName(
  manifest: { name?: string; default_locale?: string },
  extDir: string,
): Promise<string> {
  const raw = manifest.name ?? "";
  const msg = /^__MSG_(.+)__$/.exec(raw);
  if (msg && manifest.default_locale) {
    try {
      const messagesPath = join(extDir, "_locales", manifest.default_locale, "messages.json");
      const messages = JSON.parse(await readFile(messagesPath, "utf8")) as Record<
        string,
        { message?: string }
      >;
      const key = msg[1] ?? "";
      const resolved =
        messages[key]?.message ?? messages[key.toLowerCase()]?.message ?? undefined;
      if (resolved) return resolved;
    } catch {
      // fall through to a sensible fallback
    }
  }
  return raw && !msg ? raw : "Extension";
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // don't follow symlinks (size DoS / escape)
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const s = await stat(p).catch(() => null);
        if (s) total += s.size;
      }
    }
  }
  return total;
}

/** Exposed for callers that download a CRX to a temp file first. */
export function tempCrxPath(): string {
  return join(tmpdir(), `mz-ext-${randomUUID()}.crx`);
}
