import { run3dTryon } from "../services/tryon.server";

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
    const body = await request.json();
    const image = body.image_url || body.image;

    if (!image) {
      return json({ error: "image_url is required" }, 400, request);
    }

    const result = await run3dTryon({ image });

    return json(
      {
        ok: true,
        id: result.id,
        glb_url: result.absoluteGlbUrl || result.glbUrl,
        preview_video_url: result.absolutePreviewVideoUrl || result.previewVideoUrl,
        viewer_url: result.viewerUrl,
        local_glb_path: result.localGlbPath,
        provider: result.provider,
        message: result.message,
      },
      200,
      request
    );
  } catch (error) {
    console.error("[api.tryon.3d]", error);
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
