import { createSupportTicket } from "../db.server";

/**
 * Callback booking form submission (Layer 3 — human CS).
 * POST /api/tryon/callback
 * Body: { conversation_id, name, email, phone, call_time, reason }
 * Creates a SupportTicket of type "callback".
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
    const callTime = body.call_time || body.date_time;

    if (!conversationId || !callTime) {
      return json(
        { ok: false, error: "conversation_id and call_time are required" },
        400,
        request
      );
    }

    const ticket = await createSupportTicket({
      conversationId,
      type: "callback",
      summary: body.reason || "Customer requested a callback",
      callTime,
      contactPhone: body.phone || body.contact_phone || null,
      customerName: body.name || body.customer_name || null,
      customerEmail: body.email || body.customer_email || null,
    });

    return json(
      {
        ok: true,
        ticket_id: ticket.id,
        message:
          "Callback scheduled for " +
          formatDateTimeDDMMYYYY(callTime) +
          ". A support agent will contact you then.",
      },
      200,
      request
    );
  } catch (error) {
    console.error("[api.callback]", error);
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

/**
 * Format a date value as DD/MM/YYYY HH:MM.
 * @param {string|Date} value
 * @returns {string}
 */
function formatDateTimeDDMMYYYY(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
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
