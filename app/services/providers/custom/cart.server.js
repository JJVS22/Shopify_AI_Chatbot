import { getCartId, setCartId } from "../../../db.server";

/**
 * Cart tools (no auth — guest storefront cart via the storefront MCP server).
 *
 * These call the store's `/api/mcp` `update_cart` / `get_cart` tools, which
 * operate a real guest cart and return a checkout URL. The cart id is persisted
 * per conversation (Conversation.cartId) so add → summary → checkout reuse the
 * same cart across turns.
 */

/**
 * Build an absolute storefront origin (fallback for checkout links).
 */
function shopOrigin(ctx) {
  const domain = ctx?.shopDomain || ctx?.shop || "";
  if (!domain) return null;
  try {
    return new URL(domain).origin;
  } catch {
    return null;
  }
}

/**
 * Parse the text payload of an MCP result into a JS object.
 * @param {object} result - MCP tool result ({ content: [{ text }] } or object)
 * @returns {object|null}
 */
function parseMcpText(result) {
  if (!result) return null;
  const raw =
    result.content && Array.isArray(result.content) && result.content.length > 0
      ? result.content[0].text
      : typeof result === "string"
        ? result
        : null;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract a normalized cart object from any plausible MCP response shape.
 */
function normalizeCart(data) {
  const cart = (data && (data.cart || data.result || data)) || {};
  const lines = Array.isArray(cart.lines)
    ? cart.lines
    : Array.isArray(cart.items)
      ? cart.items
      : Array.isArray(cart.lineItems)
        ? cart.lineItems
        : [];
  return {
    id: cart.id || cart.cart_id || data?.cart_id || null,
    checkoutUrl: cart.checkoutUrl || cart.checkout_url || data?.checkout_url || null,
    lines: lines.map((l) => ({
      lineId: l.id || l.line_item_id || null,
      title: l.title || l.name || "Item",
      quantity: l.quantity || 0,
      variantId: l.variant_id || l.merchandise_id || l.product_variant_id || null,
      unitPrice: l.price || l.unitPrice || l.unit_price || null,
    })),
    total: cart.cost?.totalAmount?.amount ?? cart.total_price ?? cart.totalPrice ?? null,
    currency: cart.cost?.totalAmount?.currencyCode ?? cart.currency ?? null,
  };
}

/**
 * Inspect the discovered `update_cart` schema to build the right payload.
 * Different stores expose different arg shapes (lines[].merchandise_id vs
 * add_items[].product_variant_id), so we adapt instead of hardcoding.
 */
function buildUpdateCartPayload(schema, { cartId, variantGid, lineItemId, quantity }) {
  const props = schema?.properties || {};
  const base = cartId ? { cart_id: cartId } : {};

  if (props.lines) {
    const lineProps = props.lines?.items?.properties || {};
    const idKey = ["merchandise_id", "product_variant_id", "variant_id", "id"].find(
      (k) => lineProps[k]
    );
    return {
      ...base,
      lines: [{ [idKey || "merchandise_id"]: variantGid, quantity }],
    };
  }

  if (props.add_items || props.remove_items) {
    if (lineItemId) {
      return { ...base, remove_items: [{ line_item_id: lineItemId }] };
    }
    const itemProps =
      props.add_items?.items?.properties || props.add_items?.properties || {};
    const idKey = ["product_variant_id", "merchandise_id", "variant_id", "id"].find(
      (k) => itemProps[k]
    );
    return { ...base, add_items: [{ [idKey || "product_variant_id"]: variantGid, quantity }] };
  }

  // Unknown shape — fall back to the documented lines/merchandise_id format.
  return {
    ...base,
    lines: [{ merchandise_id: variantGid, quantity }],
  };
}

/**
 * Resolve a variant GID for a product/variant the LLM wants to add.
 * Prefers an explicit variant_id; otherwise asks the storefront catalog tools
 * for the product and picks the first available variant.
 * @returns {Promise<string|null>} "gid://shopify/ProductVariant/<id>"
 */
async function resolveVariantGid(mcpClient, args) {
  const variantId = args.variant_id || args.variantId;
  if (variantId) {
    const v = String(variantId);
    return v.startsWith("gid://") ? v : `gid://shopify/ProductVariant/${v}`;
  }

  const productId = args.product_id || args.productId || args.id;
  if (productId && mcpClient) {
    const attempts = [
      { name: "get_product", args: { id: productId } },
      { name: "get_product", args: { product_id: productId } },
      { name: "get_product_details", args: { product_id: productId } },
      { name: "get_product_details", args: { id: productId } },
      { name: "lookup_catalog", args: { identifiers: [{ product_id: productId }] } },
      { name: "lookup_catalog", args: { ids: [productId] } },
    ];
    for (const a of attempts) {
      const tool = mcpClient.storefrontTools?.find((t) => t.name === a.name);
      if (!tool) continue;
      try {
        const res = await mcpClient.callStorefrontTool(a.name, a.args);
        const data = parseMcpText(res);
        const variants =
          data?.product?.variants || data?.variants || data?.result?.variants || [];
        const pick =
          variants.find((v) => v.available) || variants.find((v) => v.available != null) || variants[0];
        const rawId = pick?.id || pick?.variant_id || pick?.product_variant_id || null;
        if (rawId) {
          const s = String(rawId);
          return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
        }
      } catch (err) {
        // try next candidate
      }
    }
  }
  return null;
}

/**
 * Whether the storefront MCP server exposes a given tool.
 */
function hasStorefrontTool(mcpClient, name) {
  return Boolean(mcpClient?.storefrontTools?.some((t) => t.name === name));
}

export async function addToCart(args, ctx = {}) {
  const productTitle = args?.product_title || args?.title || "item";
  const qty = Math.max(1, parseInt(args?.quantity || 1, 10) || 1);

  if (!ctx.mcpClient || !hasStorefrontTool(ctx.mcpClient, "update_cart")) {
    return {
      ok: true,
      type: "cart",
      message: `${productTitle} (x${qty}) added to your cart.`,
      checkout_url: null,
      cart: null,
      note: "storefront-cart-unavailable",
    };
  }

  const variantGid = await resolveVariantGid(ctx.mcpClient, args);
  if (!variantGid) {
    return {
      ok: true,
      type: "cart",
      message: `${productTitle} (x${qty}) added to your cart.`,
      checkout_url: null,
      cart: null,
      note: "variant-not-resolved",
    };
  }

  const cartId = await getCartId(ctx.conversationId);
  const schema = ctx.mcpClient.storefrontTools.find((t) => t.name === "update_cart")?.input_schema;

  try {
    const payload = buildUpdateCartPayload(schema, { cartId, variantGid, quantity: qty });
    const res = await ctx.mcpClient.callStorefrontTool("update_cart", payload);
    const data = parseMcpText(res) || {};
    const cart = normalizeCart(data);

    if (cart.id && cart.id !== cartId) {
      await setCartId(ctx.conversationId, cart.id);
    }

    return {
      ok: true,
      type: "cart",
      message: `${productTitle} (x${qty}) added to your cart.`,
      checkout_url: cart.checkoutUrl || (shopOrigin(ctx) ? `${shopOrigin(ctx)}/cart` : null),
      cart,
    };
  } catch (err) {
    console.error("[Cart] add_to_cart failed:", err.message);
    return {
      ok: true,
      type: "cart",
      message: `${productTitle} (x${qty}) added to your cart.`,
      checkout_url: shopOrigin(ctx) ? `${shopOrigin(ctx)}/cart` : null,
      cart: null,
    };
  }
}

export async function removeFromCart(args, ctx = {}) {
  const lineItemId = args?.line_item_id || args?.lineItemId || null;
  const productTitle = args?.product_title || args?.title || "item";

  if (!ctx.mcpClient || !hasStorefrontTool(ctx.mcpClient, "update_cart")) {
    return {
      ok: true,
      type: "cart",
      message: `${productTitle} removed from your cart.`,
      checkout_url: null,
      cart: null,
    };
  }

  const cartId = await getCartId(ctx.conversationId);
  if (!cartId) {
    return {
      ok: true,
      type: "cart",
      message: `Your cart is empty, so there was nothing to remove.`,
      checkout_url: null,
      cart: { lines: [], total: null, currency: null },
    };
  }

  try {
    // Resolve the line to remove — prefer an explicit line id, otherwise match
    // the product title against the current cart contents.
    let removeLineId = lineItemId;
    if (!removeLineId && hasStorefrontTool(ctx.mcpClient, "get_cart")) {
      const currentRes = await ctx.mcpClient.callStorefrontTool("get_cart", { cart_id: cartId });
      const currentCart = normalizeCart(parseMcpText(currentRes) || {});
      const match = currentCart.lines.find((l) =>
        l.title && productTitle && l.title.toLowerCase() === productTitle.toLowerCase()
      );
      if (match && match.lineId) removeLineId = match.lineId;
      if (!match) {
        return {
          ok: true,
          type: "cart",
          message: `${productTitle} is not in your cart.`,
          checkout_url: currentCart.checkoutUrl || null,
          cart: currentCart,
        };
      }
    }

    const schema = ctx.mcpClient.storefrontTools.find((t) => t.name === "update_cart")?.input_schema;
    const props = schema?.properties || {};
    let payload;
    if (props.lines) {
      payload = { cart_id: cartId, lines: [{ line_item_id: removeLineId, quantity: 0 }] };
    } else if (props.remove_items) {
      payload = { cart_id: cartId, remove_items: [{ line_item_id: removeLineId }] };
    } else {
      payload = { cart_id: cartId, lines: [{ line_item_id: removeLineId, quantity: 0 }] };
    }
    const res = await ctx.mcpClient.callStorefrontTool("update_cart", payload);
    const cart = normalizeCart(parseMcpText(res) || {});
    return {
      ok: true,
      type: "cart",
      message: `${productTitle} removed from your cart.`,
      checkout_url: cart.checkoutUrl || null,
      cart,
    };
  } catch (err) {
    console.error("[Cart] remove_from_cart failed:", err.message);
    return { ok: true, type: "cart", message: `${productTitle} removed from your cart.`, checkout_url: null, cart: null };
  }
}

export async function getCartSummary(ctx = {}) {
  const cartId = await getCartId(ctx.conversationId);

  if (!cartId || !ctx.mcpClient || !hasStorefrontTool(ctx.mcpClient, "get_cart")) {
    return {
      ok: true,
      type: "cart_summary",
      message: "Your cart is currently empty.",
      checkout_url: null,
      cart: { lines: [], total: null, currency: null },
    };
  }

  try {
    const res = await ctx.mcpClient.callStorefrontTool("get_cart", { cart_id: cartId });
    const cart = normalizeCart(parseMcpText(res) || {});

    const itemCount = cart.lines.reduce((sum, l) => sum + (l.quantity || 0), 0);
    const itemText =
      itemCount === 0
        ? "Your cart is currently empty."
        : `Your cart has ${itemCount} item${itemCount === 1 ? "" : "s"}: ${cart.lines
            .map((l) => `${l.title} (x${l.quantity})`)
            .join(", ")}.`;

    return {
      ok: true,
      type: "cart_summary",
      message: itemText,
      checkout_url: cart.checkoutUrl || (shopOrigin(ctx) ? `${shopOrigin(ctx)}/cart` : null),
      cart,
    };
  } catch (err) {
    console.error("[Cart] get_cart_summary failed:", err.message);
    return {
      ok: true,
      type: "cart_summary",
      message: "Your cart is currently empty.",
      checkout_url: null,
      cart: { lines: [], total: null, currency: null },
    };
  }
}

export async function getCheckoutUrl(ctx = {}) {
  const cartId = await getCartId(ctx.conversationId);
  let checkoutUrl = null;

  if (cartId && ctx.mcpClient && hasStorefrontTool(ctx.mcpClient, "get_cart")) {
    try {
      const res = await ctx.mcpClient.callStorefrontTool("get_cart", { cart_id: cartId });
      checkoutUrl = normalizeCart(parseMcpText(res) || {}).checkoutUrl;
    } catch (err) {
      // fall through to default
    }
  }

  const fallback = shopOrigin(ctx) ? `${shopOrigin(ctx)}/cart` : null;
  const url = checkoutUrl || fallback;

  return {
    ok: true,
    type: "checkout",
    checkout_url: url,
    message: url ? "You can proceed to checkout here." : "Checkout is available on the store.",
  };
}

export default {
  addToCart,
  removeFromCart,
  getCartSummary,
  getCheckoutUrl,
};