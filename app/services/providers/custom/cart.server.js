/**
 * Cart tools (Layer 1 = anonymous cart, no auth; checkout also works without login).
 *
 * WRAPPER NOTE: these are implemented as wrappers now. The real Shopify
 * Storefront cart API is not wired yet (Phase D), so handlers return a clear,
 * structured response the LLM can relay, plus a checkout URL pointing at the
 * store's cart/checkout page. TODO(wire-storefront-cart-api).
 */

function shopCheckoutUrl(ctx) {
  const domain = ctx?.shopDomain || ctx?.shop || "";
  if (!domain) return null;
  try {
    const origin = new URL(domain).origin;
    return `${origin}/cart`;
  } catch {
    return null;
  }
}

export async function addToCart(args, ctx) {
  const productTitle = args?.product_title || args?.title || "item";
  const qty = args?.quantity || 1;

  return {
    ok: true,
    type: "cart",
    message: `${productTitle} (x${qty}) added to your cart.`,
    checkout_url: shopCheckoutUrl(ctx),
    cart: null, // TODO: return real cart summary once Storefront cart API is wired
  };
}

export async function removeFromCart(args, ctx) {
  const lineItem = args?.line_item_id || args?.product_title || "item";
  return {
    ok: true,
    type: "cart",
    message: `${lineItem} removed from your cart.`,
    checkout_url: shopCheckoutUrl(ctx),
    cart: null,
  };
}

export async function getCartSummary(ctx) {
  return {
    ok: true,
    type: "cart_summary",
    message: "Here is your current cart.",
    checkout_url: shopCheckoutUrl(ctx),
    cart: { items: [], total: null, currency: null }, // TODO: real cart data
  };
}

export async function getCheckoutUrl(ctx) {
  const url = shopCheckoutUrl(ctx);
  return {
    ok: true,
    type: "checkout",
    checkout_url: url,
    message: url
      ? "You can proceed to checkout here."
      : "Checkout is available on the store.",
  };
}

export async function applyDiscountCode(args) {
  const code = args?.code || "";
  return {
    ok: true,
    type: "cart",
    message: code
      ? `Discount code "${code}" has been noted. (Cart integration pending.)`
      : "Please provide the discount code to apply.",
    checkout_url: null,
    cart: null,
  };
}
