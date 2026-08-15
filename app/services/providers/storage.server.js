import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AppConfig from "../config.server";

function resultsRoot() {
  return path.resolve(process.cwd(), AppConfig.tryon.resultsDir);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Save a try-on artifact under storage/tryon-results/{kind}/
 * @param {"2d"|"3d"} kind
 * @param {Buffer} buffer
 * @param {string} extension e.g. "jpg", "glb", "mp4"
 * @param {object} [meta]
 * @returns {Promise<{ id: string, kind: string, relativePath: string, absolutePath: string, publicUrl: string, metaPath: string }>}
 */
export async function saveTryonResult(kind, buffer, extension, meta = {}) {
  if (kind !== "2d" && kind !== "3d") {
    throw new Error(`Invalid tryon kind: ${kind}`);
  }

  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const filename = `${id}.${extension.replace(/^\./, "")}`;
  const dir = path.join(resultsRoot(), kind);
  await ensureDir(dir);

  const absolutePath = path.join(dir, filename);
  await fs.writeFile(absolutePath, buffer);

  const relativePath = path.join(kind, filename);
  const publicUrl = `${AppConfig.tryon.publicBasePath}/${kind}/${filename}`;

  const metaPath = path.join(dir, `${id}.json`);
  const metaPayload = {
    id,
    kind,
    filename,
    relativePath,
    publicUrl,
    createdAt: new Date().toISOString(),
    ...meta,
  };
  await fs.writeFile(metaPath, JSON.stringify(metaPayload, null, 2), "utf8");

  console.log(`[TryOnStorage] Saved ${kind} result: ${absolutePath}`);

  return {
    id,
    kind,
    fileName: filename,
    relativePath,
    absolutePath,
    publicUrl,
    metaPath,
    meta: metaPayload,
  };
}

/**
 * Resolve a public path segment under tryon results to an absolute file path.
 * Prevents path traversal.
 */
export function resolveTryonResultFile(kind, filename) {
  if (kind !== "2d" && kind !== "3d") return null;
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return null;
  }

  const absolutePath = path.join(resultsRoot(), kind, filename);
  const root = resultsRoot();
  if (!absolutePath.startsWith(root)) return null;
  return absolutePath;
}

export function contentTypeForFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".mp4": "video/mp4",
    ".ply": "application/octet-stream",
    ".json": "application/json",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * Delete a saved try-on file by its relative path (e.g. "2d/<file>.jpg").
 * Also removes the JSON sidecar. Safe to call for missing files.
 * @param {string} relativePath
 */
export async function deleteTryonResultFile(relativePath) {
  if (!relativePath || relativePath.includes("..")) return;
  const full = path.join(resultsRoot(), relativePath);
  const root = resultsRoot();
  if (!full.startsWith(root)) return;

  try {
    await fs.unlink(full);
    console.log(`[TryOnStorage] Deleted file: ${full}`);
  } catch {
    // ignore missing files
  }

  const metaPath = full.replace(/\.[^.]+$/, ".json");
  try {
    await fs.unlink(metaPath);
  } catch {
    // ignore
  }
}

export default {
  saveTryonResult,
  resolveTryonResultFile,
  contentTypeForFilename,
  deleteTryonResultFile,
};
