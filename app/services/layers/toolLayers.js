/**
 * Tool Layers — customer service split.
 *
 * This app intentionally does NOT use customer-account authentication. Only
 * tools that need NO login are exposed:
 *   layer1 = no auth, fully automatic (catalog, cart, try-on, store info)
 *   layer3 = human CS / merchant-gated (creates SupportTickets, never auto-acts)
 *
 * Customer-account (layer 2) tools — orders, wishlist, store credit, customer
 * profile, discount codes — are intentionally NOT exposed.
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
      { name: "add_to_cart", origin: "custom", note: "Add item to a guest cart via storefront MCP (no auth)" },
      { name: "remove_from_cart", origin: "custom", note: "Remove item from the guest cart" },
      { name: "get_cart_summary", origin: "custom", note: "Current guest cart: items, totals, checkout URL" },
      { name: "get_checkout_url", origin: "custom", note: "Checkout URL → rendered as a Checkout button (guest checkout)" },

      // Custom tools — try-on (no auth)
      { name: "tryon_2d", origin: "custom", note: "2D virtual try-on via Replicate" },
      { name: "tryon_3d", origin: "custom", note: "Image → 3D model via Replicate" },
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
    ],
  },
};

/**
 * Tool names that are safe to expose to the LLM:
 *   All Layer 1 tools (no auth) + the Layer 3 handoff tools (ticket creation only).
 * Customer-account tools (orders, wishlist, profile, store credit, discounts)
 * are intentionally excluded.
 */
export const ALLOWED_TOOL_NAMES = new Set([
  ...TOOL_LAYERS.layer1.tools.map((t) => t.name),
  ...TOOL_LAYERS.layer3.tools.map((t) => t.name),
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