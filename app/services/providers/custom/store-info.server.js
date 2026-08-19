import AppConfig from "../../config.server";
import { getShopMeta } from "../../../db.server";

/**
 * Layer 1 — public store info (no auth).
 *
 * WRAPPER NOTE: real shop data comes from the Shopify Admin API `shop` query
 * (name, email, phone, address, currency, locale). That API is wired later
 * (Phase D); for now we return a best-effort response from available config and
 * cache the result in ShopMeta.
 */
export async function getStoreInfo() {
  const shopDomain = AppConfig.tryon.appUrl || "";

  // Best-effort: try cached meta first.
  const cached = await getShopMeta(shopDomain);
  if (cached) {
    return {
      ok: true,
      type: "store_info",
      name: cached.name || null,
      domain: shopDomain,
      email: cached.email || null,
      phone: cached.phone || null,
      address: cached.address ? JSON.parse(cached.address) : null,
      currency: cached.currency || null,
      locale: cached.locale || null,
    };
  }

  // TODO(wire-admin-api): query Shopify Admin API `shop { name email phone
  // address1 city country currencyCode primaryDomain }` and upsertShopMeta().
  return {
    ok: true,
    type: "store_info",
    name: "This store",
    domain: shopDomain,
    email: null,
    phone: null,
    address: null,
    currency: null,
    locale: null,
    note: "Full store contact details are being connected.",
  };
}
