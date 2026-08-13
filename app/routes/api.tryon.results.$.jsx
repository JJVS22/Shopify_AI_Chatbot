import fs from "node:fs/promises";
import {
  resolveTryonResultFile,
  contentTypeForFilename,
} from "../services/providers/storage.server";

/**
 * Serve locally saved try-on files:
 * GET /api/tryon/results/2d/<file>
 * GET /api/tryon/results/3d/<file>
 */
export async function loader({ request, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  const splat = params["*"] || "";
  const parts = splat.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return new Response("Not found", { status: 404 });
  }

  const [kind, filename] = parts;
  const absolutePath = resolveTryonResultFile(kind, filename);
  if (!absolutePath) {
    return new Response("Invalid path", { status: 400 });
  }

  try {
    const data = await fs.readFile(absolutePath);
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForFilename(filename),
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}
