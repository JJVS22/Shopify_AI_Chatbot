/**
 * Tool Layers — customer service split.
 *
 * Structure: layers primary, origin secondary.
 * Every tool belongs to one of 3 layers and has an origin:
 *   origin = "storefront" (Shopify storefront MCP) | "customer" (Shopify customer MCP) | "custom" (ours)
 *
 * Layer semantics:
 *   layer1 = no auth, fully automatic
 *   layer2 = customer auth required (auth-on-demand popup, strategy (a))
 *   layer3 = real human CS / merchant-gated (creates SupportTickets, never auto-acts)
 */

export const TOOL_LAYERS = {
  layer1: {
    label: "No auth, fully auto",
    tools: [
      // Shopify storefront MCP — public catalog/policy data
      { name: "search_catalog", origin: "storefront", note: "Search products; cards show stock" },
      { name: "get_product_details", origin: "storefront", note: "Full single-product details + URL resolution" },
      { name: "search_shop_policies_and_faqs", origin: "storefront", note: "Public policies + FAQs" },

      // Custom tools — public store info + anonymous cart + AI try-on (all no auth)
      { name: "get_store_info", origin: "custom", note: "Shop name/domain/contact/currency/locale (Admin API wrapper)" },
      { name: "get_shipping_estimate", origin: "custom", note: "Best-effort shipping estimate from policies" },
      { name: "get_featured_or_new_products", origin: "custom", note: "Curated featured/new listing (wraps search_catalog)" },
      { name: "get_product_availability", origin: "custom", note: "Stock status for a product/variant" },
      { name: "add_to_cart", origin: "custom", note: "Add item to anonymous cart (no auth)" },
      { name: "remove_from_cart", origin: "custom", note: "Remove item from anonymous cart" },
      { name: "get_cart_summary", origin: "custom", note: "Current anonymous cart: items, totals" },
      { name: "get_checkout_url", origin: "custom", note: "Checkout URL → rendered as a Checkout button (guest checkout allowed)" },

      // Custom tools — try-on (no auth)
      { name: "tryon_2d", origin: "custom", note: "2D virtual try-on via Replicate" },
      { name: "tryon_3d", origin: "custom", note: "Image → 3D model via Replicate" },
    ],
  },

  layer2: {
    label: "Customer auth required (auth-on-demand)",
    tools: [
      { name: "apply_discount_code", origin: "custom", note: "Apply/remove discount code on cart" },
      { name: "get_cart", origin: "customer", note: "Auth cart read (existing MCP)" },
      { name: "update_cart", origin: "customer", note: "Auth cart update (existing MCP)" },
      { name: "get_most_recent_order_status", origin: "customer", note: "Last placed order status (existing MCP)" },
      { name: "get_order_details", origin: "custom", note: "Order details by id (wrapper)" },
      { name: "get_order_history", origin: "custom", note: "List of past orders (wrapper; wire later)" },
      { name: "track_shipment", origin: "custom", note: "Shipping/fulfillment tracking (wrapper; wire later)" },
      { name: "get_store_credit_balances", origin: "customer", note: "Store-credit balance(s) (existing MCP)" },
      { name: "get_customer_profile", origin: "custom", note: "Name + email; addresses only on demand" },
      { name: "get_wishlist", origin: "custom", note: "Wishlist read (wrapper; wire later)" },
      { name: "add_to_wishlist", origin: "custom", note: "Wishlist add (wrapper; wire later)" },
    ],
  },

  layer3: {
    label: "Real human CS / merchant-gated",
    tools: [
      // Custom handoff tools — SAFE to expose: they only create SupportTickets.
      { name: "escalate_to_human", origin: "custom", note: "Hand current chat + context to a live agent" },
      { name: "request_after_sale_assistance", origin: "custom", note: "Combined return/refund/cancel/modify/warranty → ticket" },
      { name: "create_support_ticket", origin: "custom", note: "Generic support ticket" },
      { name: "schedule_callback", origin: "custom", note: "Book a human callback (date/time + contact) → ticket" },
      // MCP tools we intentionally DO NOT auto-expose (would auto-trigger merchant actions).
      { name: "request_return", origin: "customer", note: "EXCLUDED — folded into request_after_sale_assistance" },
    ],
  },
};

/**
 * Tool names that are safe to expose to the LLM:
 *   Layer 1 + Layer 2 tools,
 *   plus the Layer 3 handoff tools (they only create tickets).
 * Excludes MCP tools that would auto-trigger merchant actions (e.g. request_return).
 */
export const ALLOWED_TOOL_NAMES = new Set([
  ...TOOL_LAYERS.layer1.tools.map((t) => t.name),
  ...TOOL_LAYERS.layer2.tools.map((t) => t.name),
  // Layer 3 handoff tools that are safe (ticket creation only):
  "escalate_to_human",
  "request_after_sale_assistance",
  "create_support_ticket",
  "schedule_callback",
]);

/** Origin lookup for a tool name (for logging / docs). */
export function getToolOrigin(name) {
  for (const layer of Object.values(TOOL_LAYERS)) {
    const hit = layer.tools.find((t) => t.name === name);
    if (hit) return hit.origin;
  }
  return null;
}

export default {
  TOOL_LAYERS,
  ALLOWED_TOOL_NAMES,
  getToolOrigin,
};
