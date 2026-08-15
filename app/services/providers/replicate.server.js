import Replicate from "replicate";
import process from "node:process";
import { Buffer } from "node:buffer";

let client = null;

/**
 * Lazily create and cache the Replicate SDK client.
 */
export function getReplicateClient() {
  if (client) return client;

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set. Add it to your .env file."
    );
  }

  client = new Replicate({
    auth: token,
    userAgent: "shop-chat-agent/tryon",
  });

  return client;
}

/**
 * Normalize Replicate file-like outputs to a downloadable URL or Buffer.
 */
export async function materializeReplicateFile(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return { url: value, buffer: null };
  }

  if (value instanceof URL) {
    return { url: value.toString(), buffer: null };
  }

  if (typeof value.url === "function") {
    const url = value.url();
    return { url: typeof url === "string" ? url : url?.toString?.(), buffer: null };
  }

  if (typeof value.href === "string") {
    return { url: value.href, buffer: null };
  }

  if (Buffer.isBuffer(value)) {
    return { url: null, buffer: value };
  }

  if (value instanceof Uint8Array) {
    return { url: null, buffer: Buffer.from(value) };
  }

  if (typeof value.arrayBuffer === "function") {
    const ab = await value.arrayBuffer();
    return { url: null, buffer: Buffer.from(ab) };
  }

  if (typeof value === "object" && value.url) {
    return { url: String(value.url), buffer: null };
  }

  return null;
}

/**
 * Download a materialized Replicate output (URL or Buffer) into a Node Buffer.
 */
export async function downloadToBuffer(urlOrMaterialized) {
  if (!urlOrMaterialized) return null;

  if (Buffer.isBuffer(urlOrMaterialized)) return urlOrMaterialized;
  if (urlOrMaterialized.buffer) return urlOrMaterialized.buffer;

  const url = typeof urlOrMaterialized === "string"
    ? urlOrMaterialized
    : urlOrMaterialized.url;

  if (!url) return null;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download Replicate output: ${res.status} ${url}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Convert an image input into something the Replicate SDK can upload/fetch.
 * Replicate cannot fetch `data:` URLs, so base64 blobs are turned into Blobs
 * (the SDK auto-uploads them to Replicate's file API).
 * @param {*} value - https URL string, data: URL string, Buffer, or Blob/File
 */
export function toReplicateFile(value) {
  if (Buffer.isBuffer(value)) {
    return new Blob([value], { type: "application/octet-stream" });
  }
  if (typeof value === "string" && value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma === -1) return value;
    const header = value.slice(5, comma);
    const mime = header.split(";")[0] || "image/jpeg";
    const bin = Buffer.from(value.slice(comma + 1), "base64");
    console.log(`[Replicate] Converted data: URL → Blob (${mime}, ${bin.length} bytes)`);
    return new Blob([bin], { type: mime });
  }
  return value;
}

export default {
  getReplicateClient,
  materializeReplicateFile,
  downloadToBuffer,
  toReplicateFile,
};
