import { Buffer } from "node:buffer";
import AppConfig from "../services/config.server";
import { saveTryonResult } from "../services/providers/storage.server";

/**
 * POST /api/upload
 * Stores a customer-uploaded image and returns a public URL that can be used
 * as the `person_image_url` for 2D try-on. The file is saved under the same
 * storage the try-on results use, so it is served by /api/tryon/results/*.
 *
 * Body: multipart/form-data with an `image` file field.
 * Returns: { ok, url (absolute), public_url (relative), conversation_id? }
 */
export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("image");
    const conversationId = formData.get("conversation_id") || formData.get("conversationId") || null;

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ ok: false, error: "No image file provided (field name: image)." }, 400, request);
    }

    const type = String(file.type || "");
    if (!type.startsWith("image/")) {
      return json({ ok: false, error: "Only image files are allowed." }, 400, request);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) {
      return json({ ok: false, error: "The uploaded file is empty." }, 400, request);
    }
    if (buffer.length > 10 * 1024 * 1024) {
      return json({ ok: false, error: "Image must be under 10MB." }, 400, request);
    }

    const extension = imageExtension(file.name || type);
    const saved = await saveTryonResult("2d", buffer, extension);

    const base = (AppConfig.tryon.appUrl || "").replace(/\/+$/, "");
    const absoluteUrl = `${base}${saved.publicUrl.startsWith("/") ? "" : "/"}${saved.publicUrl}`;

    return json(
      {
        ok: true,
        url: absoluteUrl,
        public_url: saved.publicUrl,
        conversation_id: conversationId,
      },
      200,
      request
    );
  } catch (error) {
    console.error("[api.upload]", error);
    return json({ ok: false, error: error.message }, 500, request);
  }
}

function imageExtension(filenameOrType) {
  const name = String(filenameOrType || "").toLowerCase();
  if (/\.png$/.test(name) || name.includes("png")) return "png";
  if (/\.webp$/.test(name) || name.includes("webp")) return "webp";
  if (/\.gif$/.test(name) || name.includes("gif")) return "gif";
  return "jpg";
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Shopify-Shop-Id",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}