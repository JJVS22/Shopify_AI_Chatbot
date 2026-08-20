import { addToCart, removeFromCart, getCartSummary, getCheckoutUrl } from "./cart.server";
import { getStoreInfo } from "./store-info.server";
import {
  escalateToHuman,
  requestAfterSaleAssistance,
  createSupportTicketHandler,
  scheduleCallback,
} from "./tickets.server";

/**
 * Custom tools (origin = "custom"). These are our own tools layered on top of
 * Shopify's MCP tools. Each belongs to a layer (see ../layers/toolLayers.js).
 */

/**
 * Dispatch a custom tool call to its handler.
 * @param {string} name
 * @param {object} args
 * @param {{conversationId?: string, shopDomain?: string, shopId?: string, mcpClient?: object}} [ctx]
 */
export async function handleCustomToolCall(name, args, ctx = {}) {
  try {
    switch (name) {
      case "get_store_info":
        return await getStoreInfo(args, ctx);
      case "get_shipping_estimate":
        return { ok: true, type: "info", message: "Shipping is calculated at checkout. Check the store's shipping policy for details." };
      case "get_featured_or_new_products":
        return { ok: true, type: "info", message: "Use search_catalog with a query like 'featured' or 'new arrivals' to browse products." };
      case "get_product_availability":
        return { ok: true, type: "info", message: "Availability is shown on each product card (In stock / Out of stock)." };
      case "add_to_cart":
        return await addToCart(args, ctx);
      case "remove_from_cart":
        return await removeFromCart(args, ctx);
      case "get_cart_summary":
        return await getCartSummary(ctx);
      case "get_checkout_url":
        return await getCheckoutUrl(ctx);

      // Layer 3 — human CS / merchant-gated (only creates SupportTickets)
      case "escalate_to_human":
        return await escalateToHuman(args, ctx);
      case "request_after_sale_assistance":
        return await requestAfterSaleAssistance(args, ctx);
      case "create_support_ticket":
        return await createSupportTicketHandler(args, ctx);
      case "schedule_callback":
        return await scheduleCallback(args, ctx);
      default:
        return { ok: false, error: `Unknown custom tool: ${name}` };
    }
  } catch (err) {
    console.error(`[CustomTool] ${name} failed:`, err);
    return { ok: false, error: err.message };
  }
}

export function getCustomOpenAiTools() {
  return [
    {
      type: "function",
      function: {
        name: "get_store_info",
        description:
          "Return the store's public info: shop name, domain, contact email/phone, address, currency, locale. No login required.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_shipping_estimate",
        description:
          "Provide a best-effort shipping estimate based on the store's policies/FAQs. No login required.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_featured_or_new_products",
        description:
          "List featured or new products from the store catalog. No login required.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_product_availability",
        description:
          "Check whether a specific product/variant is in stock. No login required.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "Product id or GID" },
            variant_id: { type: "string", description: "Optional variant id" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_to_cart",
        description:
          "Add a product/variant to the customer's cart. Works WITHOUT login. Login is only required at checkout.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string" },
            variant_id: { type: "string" },
            quantity: { type: "number" },
            product_title: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_from_cart",
        description:
          "Remove a line item from the customer's cart. Works WITHOUT login.",
        parameters: {
          type: "object",
          properties: {
            line_item_id: { type: "string" },
            product_title: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_cart_summary",
        description:
          "Return the current cart contents: items, totals, discount status. Works WITHOUT login.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_checkout_url",
        description:
          "Provide a checkout link so the customer can proceed to checkout (guest checkout is allowed — no login required).",
        parameters: { type: "object", properties: {} },
      },
    },
    // Layer 3 — human CS / merchant-gated (only creates SupportTickets)
    {
      type: "function",
      function: {
        name: "escalate_to_human",
        description:
          "Transfer the conversation to a human support agent. Only use when the customer explicitly asks for a human or for issues that need live help.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" },
            details: { type: "object" },
            customer_name: { type: "string" },
            customer_email: { type: "string" },
            order_ref: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_after_sale_assistance",
        description:
          "Log an after-sale request for a human to review: return, refund, cancel_order, modify_order, or warranty. Never auto-completes these — it creates a support ticket.",
        parameters: {
          type: "object",
          properties: {
            assistance_type: {
              type: "string",
              enum: ["return", "refund", "cancel_order", "modify_order", "warranty"],
            },
            order_ref: { type: "string" },
            summary: { type: "string" },
            details: { type: "object" },
            customer_name: { type: "string" },
            customer_email: { type: "string" },
          },
          required: ["assistance_type"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_support_ticket",
        description: "Create a generic support ticket for a human agent.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            details: { type: "object" },
            order_ref: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_callback",
        description:
          "Schedule a callback from a human agent. Calling this opens a form in the chat for the customer to fill in (name, contact, preferred date/time, reason). Do NOT ask the customer to type these answers — just call the tool.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Optional reason (pre-filled if already known)" },
          },
        },
      },
    },
  ];
}

/**
 * Dispatch a custom tool call to its handler.
 * @param {string} name
 * @param {object} args
 * @param {{conversationId?: string, shopDomain?: string, shopId?: string, mcpClient?: object}} [ctx]
 */
export function isCustomTool(name) {
  const schemas = getCustomOpenAiTools();
  return schemas.some((t) => t.function.name === name);
}

export default {
  getCustomOpenAiTools,
  handleCustomToolCall,
  isCustomTool,
};
