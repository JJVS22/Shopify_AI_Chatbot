import { saveMessage } from "../db.server";

/**
 * POST /api/save-message
 * Persist a chat message from the client so it is restored with the history
 * in a new tab. Used for client-generated messages that the server never sees:
 *  - role "assistant": the "X has been added to your cart" confirmation
 *  - role "product": the initial "New products" cards (shown at the top of
 *    the conversation)
 *
 * Body: { conversation_id, role: "assistant" | "product", content }
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
    const conversationId = body.conversation_id || body.conversationId;
    const role = body.role === "product" ? "product" : "assistant";
    const content = String(body.content || "");

    if (!conversationId || !content) {
      return json(
        { ok: false, error: "conversation_id and content are required" },
        400,
        request
      );
    }

    await saveMessage(conversationId, role, content);
    return json({ ok: true }, 200, request);
  } catch (error) {
    console.error("[api.save-message]", error);
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