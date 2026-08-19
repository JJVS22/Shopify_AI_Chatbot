import { createSupportTicket } from "../../../db.server";

const TICKET_TYPES = [
  "return",
  "refund",
  "cancel_order",
  "modify_order",
  "warranty",
  "callback",
  "escalation",
];

const TYPE_LABELS = {
  return: "Return request",
  refund: "Refund request",
  cancel_order: "Order cancellation",
  modify_order: "Order modification",
  warranty: "Warranty claim",
  callback: "Callback request",
  escalation: "Escalation to human",
};

/**
 * Layer 3 — human CS / merchant-gated.
 * These handlers NEVER auto-complete anything; they create a SupportTicket
 * which a human agent or the merchant then processes.
 */

export async function escalateToHuman(args, { conversationId }) {
  const summary = args?.reason || args?.summary || "Customer requested to speak with a human.";
  const ticket = await createSupportTicket({
    conversationId,
    type: "escalation",
    summary,
    details: args?.details ? JSON.stringify(args.details) : null,
    customerName: args?.customer_name || null,
    customerEmail: args?.customer_email || null,
    orderRef: args?.order_ref || null,
  });

  return {
    ok: true,
    type: "human_support",
    ticket_id: ticket.id,
    message:
      "I've connected you to our support team. A human agent will take over shortly. Your request has been logged (ticket " +
      ticket.id.slice(0, 8) +
      ").",
  };
}

/**
 * Combined after-sale assistance: return / refund / cancel / modify / warranty.
 */
export async function requestAfterSaleAssistance(args, { conversationId }) {
  const type = args?.assistance_type || args?.type;
  if (!type || !TICKET_TYPES.includes(type)) {
    return {
      ok: false,
      error:
        "assistance_type must be one of: " + TICKET_TYPES.join(", ") + ".",
    };
  }

  const orderRef = args?.order_ref || null;
  const summary =
    args?.summary ||
    (TYPE_LABELS[type] || "After-sale assistance") +
      (orderRef ? ` for order ${orderRef}` : "");

  const ticket = await createSupportTicket({
    conversationId,
    type,
    summary,
    details: args?.details ? JSON.stringify(args.details) : null,
    customerName: args?.customer_name || null,
    customerEmail: args?.customer_email || null,
    orderRef,
  });

  return {
    ok: true,
    type: "human_support",
    ticket_id: ticket.id,
    assistance_type: type,
    message:
      "I've logged your " +
      (TYPE_LABELS[type] || "request") +
      " (ticket " +
      ticket.id.slice(0, 8) +
      "). A support agent will review it and get back to you.",
  };
}

export async function createSupportTicketHandler(args, { conversationId }) {
  const summary = args?.summary || args?.subject || "Support request";
  const ticket = await createSupportTicket({
    conversationId,
    type: "escalation",
    summary,
    details: args?.details ? JSON.stringify(args.details) : null,
    customerName: args?.customer_name || null,
    customerEmail: args?.customer_email || null,
    orderRef: args?.order_ref || null,
  });

  return {
    ok: true,
    type: "human_support",
    ticket_id: ticket.id,
    message:
      "Support ticket created (ticket " +
      ticket.id.slice(0, 8) +
      "). A human agent will review it.",
  };
}

/**
 * Callback booking. Instead of asking the customer to type answers, this
 * triggers a fixed-question form in the chat; the form then POSTs to
 * /api/tryon/callback to create the ticket.
 */
export async function scheduleCallback() {
  return {
    ok: true,
    type: "callback_form",
    message:
      "Please fill in the callback form below (name, contact, preferred date/time, and reason) and we will call you back.",
  };
}
