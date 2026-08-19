import MCPClient from "../mcp-client";
import { findPairingProducts } from "../services/pairings.server";

/**
 * Return complementary product suggestions for a completed 2D try-on.
 * Each product is tagged with `tryon_image_url` so the frontend can offer a
 * "Try with this look" action that re-edits the photo with the suggested item.
 *
 * POST body: { product_title?, source_image_url, conversation_id? }
 */
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
    const productTitle = body.product_title || body.productTitle || null;
    const sourceImageUrl = body.source_image_url || body.sourceImageUrl || null;
    const conversationId = body.conversation_id || body.conversationId || null;

    if (!sourceImageUrl) {
      return json({ ok: false, error: "source_image_url is required" }, 400, request);
    }

    const shopDomain = request.headers.get("Origin");
    const shopId = request.headers.get("X-Shopify-Shop-Id");

    let products = [];
    if (shopDomain) {
      const mcpClient = new MCPClient(shopDomain, conversationId, shopId, undefined);
      try {
        await mcpClient.connectToStorefrontServer();
        products = await findPairingProducts({ productTitle, mcpClient });
      } catch (err) {
        console.error("[api.tryon.pairings] MCP connect/search failed:", err.message);
      }
    }

    for (const p of products) {
      p.tryon_image_url = sourceImageUrl;
      p.tryon_product_title = productTitle || null;
    }

    return json({ ok: true, product_title: productTitle, products }, 200, request);
  } catch (error) {
    console.error("[api.tryon.pairings]", error);
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
