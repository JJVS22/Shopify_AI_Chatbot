import { unauthenticated } from "../shopify.server";
import AppConfig from "../services/config.server";
import { createToolService } from "../services/tool.server";
import MCPClient from "../mcp-client";

/**
 * GET /api/featured
 * Returns the newest products in the store for the chat's "New products"
 * greeting.
 *
 * The newest ordering + full product data come from the Admin GraphQL API
 * (CREATED_AT, newest first). Each product is then looked up through the
 * storefront MCP so the price/currency matches the storefront (presentment
 * currency) when possible; if the storefront lookup yields no price, the Admin
 * price is used so a price is always shown. Falls back to a storefront catalog
 * search if the Admin session isn't available.
 */
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    const shopDomain = request.headers.get("Origin") || null;
    const shopId = request.headers.get("X-Shopify-Shop-Id") || null;

    const products = await fetchNewestProductsAdmin(shopDomain);
    if (products && products.length > 0) {
      return json({ ok: true, source: "admin", products }, 200, request);
    }

    const fallback = await fetchNewestProductsCatalog(shopDomain, shopId);
    return json({ ok: true, source: "catalog", products: fallback }, 200, request);
  } catch (error) {
    console.error("[api.featured]", error);
    return json({ ok: false, error: error.message, products: [] }, 200, request);
  }
}

/**
 * Get the newest products from Admin (with full data + prices), then enrich
 * each with a storefront lookup so prices match what the customer sees.
 */
async function fetchNewestProductsAdmin(shopDomain) {
  const newest = await fetchNewestAdminProducts(shopDomain);
  if (newest.length === 0) return [];

  const mcpClient = new MCPClient(shopDomain, null, null);
  try {
    await mcpClient.connectToStorefrontServer();
  } catch (err) {
    console.warn("[api.featured] Storefront MCP unavailable:", err.message);
  }

  const toolService = createToolService();
  const products = [];

  for (const item of newest) {
    let product = null;

    if (mcpClient.storefrontTools.length > 0) {
      product = await lookupProductViaStorefront(mcpClient, toolService, item.gid);
    }

    if (!product) {
      // Fall back to the Admin data so we always have a product + price.
      product = toolService.formatProductData(item.raw, `/products/${item.raw.handle || ""}`);
    }

    // Ensure a price is always present (storefront price preferred).
    if (!product.price || product.price === "Price not available") {
      product.price = formatAdminPrice(item.adminPrice);
    }

    products.push(product);
    if (products.length >= AppConfig.tools.maxProductsToDisplay) break;
  }

  return products;
}

/**
 * Query the Admin GraphQL API for the newest products (full data + price).
 * @returns {Promise<Array<{gid: string, adminPrice: object, raw: object}>>}
 */
async function fetchNewestAdminProducts(shopDomain) {
  if (!shopDomain) return [];

  let hostname;
  try {
    hostname = new URL(shopDomain).hostname;
  } catch {
    return [];
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(hostname));
  } catch (err) {
    console.warn("[api.featured] No admin session:", err.message);
    return [];
  }

  const response = await admin.graphql(
    `query NewestProducts {
      products(first: ${AppConfig.tools.maxProductsToDisplay}, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            title
            handle
            description
            featuredImage { url }
            priceRange { minVariantPrice { amount currencyCode } }
            options { name values }
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }`
  );

  const data = await response.json();
  const nodes = data?.data?.products?.edges?.map((e) => e.node) || [];

  return nodes
    .map((node) => {
      const raw = nodeToRawProduct(node);
      if (!raw) return null;
      return {
        gid: node.id,
        adminPrice: {
          amount: node.priceRange?.minVariantPrice?.amount,
          currency: node.priceRange?.minVariantPrice?.currencyCode || "",
        },
        raw,
      };
    })
    .filter(Boolean);
}

/**
 * Fetch a single product's details via the storefront MCP (try the catalog
 * lookup tools with several arg shapes).
 */
async function lookupProductViaStorefront(mcpClient, toolService, gid) {
  const attempts = [
    { name: "lookup_catalog", args: { catalog: { ids: [gid] } } },
    { name: "lookup_catalog", args: { ids: [gid] } },
    { name: "get_product", args: { catalog: { id: gid } } },
    { name: "get_product", args: { id: gid } },
    { name: "get_product_details", args: { product_id: gid } },
    { name: "get_product_details", args: { id: gid } },
  ];

  for (const attempt of attempts) {
    if (!mcpClient.storefrontTools.some((t) => t.name === attempt.name)) continue;
    try {
      const res = await mcpClient.callStorefrontTool(attempt.name, attempt.args);
      const data = parseMcpJson(res);
      const productData = data?.product || data?.products?.[0] || data?.result?.product;
      if (!productData) continue;

      const wrapped = {
        content: [{ type: "text", text: JSON.stringify({ products: [productData] }) }],
      };
      const products = await toolService.processProductSearchResult(wrapped, mcpClient);
      if (products && products.length > 0) return products[0];
    } catch (err) {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Fallback: search the storefront catalog for new arrivals / products.
 */
async function fetchNewestProductsCatalog(shopDomain, shopId) {
  const mcpClient = new MCPClient(shopDomain, null, shopId);
  await mcpClient.connectToStorefrontServer();

  const toolService = createToolService();
  const products = [];
  const seen = new Set();

  for (const query of ["new arrivals", "new", "products"]) {
    const res = await mcpClient.callTool(AppConfig.tools.productSearchName, {
      catalog: { query },
    });
    const found = await toolService.processProductSearchResult(res, mcpClient);
    for (const product of found) {
      if (!seen.has(product.id)) {
        seen.add(product.id);
        products.push(product);
      }
      if (products.length >= AppConfig.tools.maxProductsToDisplay) break;
    }
    if (products.length > 0) break;
  }

  return products.slice(0, AppConfig.tools.maxProductsToDisplay);
}

/**
 * Convert an Admin GraphQL product node into the raw shape expected by
 * toolService.formatProductData.
 */
function nodeToRawProduct(node) {
  if (!node) return null;
  const gidToNumeric = (gid) => {
    const m = String(gid || "").match(/\/(\d+)$/);
    return m ? m[1] : gid;
  };
  const variants =
    (node.variants?.edges || []).map((e) => e.node).filter(Boolean) || [];
  const firstVariant = variants[0] || null;
  const minPrice = node.priceRange?.minVariantPrice;
  const currency = minPrice?.currencyCode || "";

  return {
    product_id: gidToNumeric(node.id),
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: node.description ? { html: node.description } : "",
    image_url: node.featuredImage?.url || "",
    price_range: minPrice
      ? {
          min: { amount: Math.round(parseFloat(minPrice.amount) * 100), currency },
        }
      : null,
    available: firstVariant ? firstVariant.availableForSale ?? null : null,
    variants: variants.map((v) => ({
      id: v.id,
      variant_id: gidToNumeric(v.id),
      title: v.title,
      available: v.availableForSale ?? null,
      options: (v.selectedOptions || []).map((o) => ({ name: o.name, value: o.value })),
    })),
    options: (node.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
  };
}

/**
 * Format a price from Admin MoneyV2 fields. The amount is normally major units
 * (e.g. "12.99"), but some responses use minor units ("1299"); a value with a
 * decimal point is treated as major units, otherwise as minor units / 100. The
 * result is rendered with the store's currency via Intl.
 */
function formatAdminPrice(adminPrice) {
  if (!adminPrice) return "Price not available";
  const rawAmount = String(adminPrice.amount ?? "").trim();
  if (!rawAmount || !/^[+-]?[\d.]+$/.test(rawAmount)) return "Price not available";

  const isMajor = rawAmount.includes(".");
  const amount = isMajor ? parseFloat(rawAmount) : parseFloat(rawAmount) / 100;
  if (!Number.isFinite(amount)) return "Price not available";

  const currency = adminPrice.currency || "";
  try {
    if (currency) {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    }
  } catch (err) {
    // fall through to the "$" fallback below
  }
  return `$${amount.toFixed(2)}`;
}

/**
 * Extract the JSON payload from an MCP tool result.
 */
function parseMcpJson(result) {
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

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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