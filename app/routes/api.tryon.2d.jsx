import { run2dTryon } from "../services/tryon.server";
import { Buffer } from "node:buffer";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return json({ error: "Use POST" }, 405, request);
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let personImage;
    let productImage;
    let prompt;
    let productTitle;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const personFile = form.get("person_image");
      productImage = form.get("product_image_url") || form.get("product_image");
      prompt = form.get("prompt") || undefined;
      productTitle = form.get("product_title") || undefined;

      if (personFile && typeof personFile === "object" && personFile.arrayBuffer) {
        const buf = Buffer.from(await personFile.arrayBuffer());
        const mime = personFile.type || "image/jpeg";
        personImage = `data:${mime};base64,${buf.toString("base64")}`;
      } else if (typeof personFile === "string") {
        personImage = personFile;
      }
    } else {
      const body = await request.json();
      personImage = body.person_image_url || body.personImage;
      productImage = body.product_image_url || body.productImage;
      prompt = body.prompt;
      productTitle = body.product_title || body.productTitle;
    }

    if (!personImage || !productImage) {
      return json(
        { error: "person_image and product_image_url are required" },
        400,
        request
      );
    }

    const result = await run2dTryon({
      personImage,
      productImage,
      prompt,
      productTitle,
    });

    return json(
      {
        ok: true,
        id: result.id,
        image_url: result.absoluteImageUrl || result.imageUrl,
        local_path: result.localPath,
        product_title: result.productTitle,
        provider: result.provider,
        message: result.message,
      },
      200,
      request
    );
  } catch (error) {
    console.error("[api.tryon.2d]", error);
    return json({ ok: false, error: error.message }, 500, request);
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
