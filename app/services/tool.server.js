import { saveMessage } from "../db.server";
import AppConfig from "./config.server";

/**
 * Derive a Shopify-style handle (URL slug) from a product title.
 * Matches Shopify's default handle generation closely enough for a fallback:
 * lowercase, `&` → "and", spaces/punctuation → "-", collapsed and trimmed.
 * @param {string} title
 * @returns {string}
 */
function slugifyTitle(title) {
  if (!title) return "";
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[''"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create a tool service that handles MCP tool results: success/error handling,
 * product search result parsing, and persisting tool messages to history.
 */
export function createToolService() {
  // Cache of resolved product URLs keyed by product id/GID, so we never make
  // more than one get_product_details call per product in a session.
  const urlCache = new Map();

  /**
   * Handle a failed MCP tool call: persist the error to conversation history
   * and, if it requires customer authorization, notify the frontend.
   */
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, conversationId) => {
    if (toolUseResponse.error && toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      const errorText = typeof toolUseResponse.error.data === "string"
        ? toolUseResponse.error.data
        : JSON.stringify(toolUseResponse.error.data);

      // Extract the authorization URL from the markdown link, if present,
      // so the frontend can render a "Log in" button.
      let authUrl = null;
      if (typeof toolUseResponse.error.data === "string") {
        const match = toolUseResponse.error.data.match(/\[([^\]]*)\]\(([^)]+)\)/);
        if (match) authUrl = match[2];
      }

      await addToolResultToHistory(conversationHistory, toolUseId, errorText, conversationId);
      sendMessage({ type: 'auth_required', auth_url: authUrl });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      const errorText = toolUseResponse.error
        ? (typeof toolUseResponse.error.data === "string" ? toolUseResponse.error.data : JSON.stringify(toolUseResponse.error))
        : "Unknown error";
      await addToolResultToHistory(conversationHistory, toolUseId, errorText, conversationId);
    }
  };

  /**
   * Handle a successful MCP tool call: extract result text, add new products
   * from a catalog search to the display list (deduplicating by id), and
   * persist the result to conversation history.
   */
  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, conversationId, mcpClient) => {
    const resultText = extractToolResultText(toolUseResponse);

    console.log(`[Tool] ${toolName} succeeded, result length: ${resultText.length}`);

    if (toolName === AppConfig.tools.productSearchName) {
      console.log(`[Tool] Raw product search response:`, JSON.stringify(toolUseResponse).substring(0, 500));
      const products = await processProductSearchResult(toolUseResponse, mcpClient);
      if (products.length > 0) {
        const existingIds = new Set(productsToDisplay.map(p => p.id));
        const newProducts = products.filter(p => !existingIds.has(p.id));
        if (newProducts.length > 0) {
          console.log(`[Tool] Adding ${newProducts.length} new products (${products.length - newProducts.length} duplicates skipped)`);
          productsToDisplay.push(...newProducts);
        } else {
          console.log(`[Tool] All ${products.length} products already in display list (skipped)`);
        }
      } else {
        console.warn(`[Tool] Product search returned 0 products to display`);
      }
    }

    await addToolResultToHistory(conversationHistory, toolUseId, resultText, conversationId);
  };

  /**
   * Pull the human-readable text out of an MCP tool response (content[0].text).
   */
  const extractToolResultText = (toolUseResponse) => {
    if (!toolUseResponse) return "No result";
    if (toolUseResponse.content && Array.isArray(toolUseResponse.content) && toolUseResponse.content.length > 0) {
      return toolUseResponse.content[0].text || JSON.stringify(toolUseResponse.content[0]);
    }
    return typeof toolUseResponse === "string" ? toolUseResponse : JSON.stringify(toolUseResponse);
  };

  /**
   * Parse a catalog search tool response into a normalized product list,
   * resolving each product to a real storefront URL.
   */
  const processProductSearchResult = async (toolUseResponse, mcpClient) => {
    try {
      console.log("[Tool] Processing product search result");
      let products = [];

      if (toolUseResponse.content && toolUseResponse.content.length > 0) {
        const rawText = toolUseResponse.content[0].text;
        console.log(`[Tool] Raw content text (first 300 chars):`, typeof rawText === 'string' ? rawText.substring(0, 300) : JSON.stringify(rawText).substring(0, 300));

        try {
          let responseData;
          if (typeof rawText === 'object') {
            responseData = rawText;
          } else if (typeof rawText === 'string') {
            responseData = JSON.parse(rawText);
          }

          console.log(`[Tool] Parsed response keys:`, Object.keys(responseData || {}));
          if (responseData?.instructions) {
            console.log(`[Tool] instructions:`, JSON.stringify(responseData.instructions));
          }
          if (responseData?.messages) {
            console.log(`[Tool] messages:`, JSON.stringify(responseData.messages));
          }

          if (responseData?.products && Array.isArray(responseData.products)) {
            console.log(`[Tool] Found ${responseData.products.length} products in response`);
            if (responseData.products.length > 0) {
              console.log(`[Tool] First raw product keys:`, Object.keys(responseData.products[0]));
              console.log(`[Tool] First raw product sample:`, JSON.stringify(responseData.products[0]).substring(0, 500));
            }

            const rawProducts = responseData.products.slice(0, AppConfig.tools.maxProductsToDisplay);
            // Resolve all product URLs in parallel; resolveProductUrl now does
            // at most one (cached) MCP call per product instead of 5 sequential.
            products = await Promise.all(
              rawProducts.map(async (rawProduct) => {
                const url = await resolveProductUrl(rawProduct, mcpClient);
                return formatProductData(rawProduct, url);
              })
            );

            console.log(`[Tool] Formatted ${products.length} products`);
            if (products.length > 0) {
              console.log(`[Tool] Sample formatted product:`, JSON.stringify(products[0]));
            }
          } else {
            console.warn(`[Tool] No 'products' array found in response data`);
          }
        } catch (e) {
          console.error("[Tool] Error parsing product data:", e, "Raw text:", typeof rawText === 'string' ? rawText.substring(0, 200) : '');
        }
      } else {
        console.warn("[Tool] Tool response has no content array");
      }

      return products;
    } catch (error) {
      console.error("[Tool] Error processing product search results:", error);
      return [];
    }
  };

  /**
   * Resolve a clickable storefront URL for a product.
   *
   * Order of preference:
   *   1. Absolute URL already present in the search result
   *   2. A handle from the search result  →  /products/<handle>
   *   3. Any /products/ path (handle- or numeric-id based) — Shopify redirects
   *      /products/<numeric-id> to the canonical handle URL, so it is a valid link
   *   4. A single, cached get_product_details lookup as a last resort
   *
   * NOTE: this used to loop through 5 sequential get_product_details calls per
   * product (up to ~50 MCP round-trips per catalog search). That made every chat
   * turn extremely slow, so it is now one attempt, cached by product id.
   * @param {Object} product - raw catalog product
   * @param {Object} [mcpClient] - MCPClient instance
   * @returns {Promise<string>} absolute URL or "/products/<handle>", or "" if unknown
   */
  const resolveProductUrl = async (product, mcpClient) => {
    const direct = extractProductUrl(product);
    if (direct && /^https?:\/\//i.test(direct)) return direct;
    if (product.handle) return `/products/${product.handle}`;
    if (direct && direct.startsWith('/products/') && !/\/products\/\d+$/.test(direct)) {
      return direct; // handle-based path (not a numeric-id fallback)
    }

    const gid = product.id || product.product_id;
    if (gid && urlCache.has(gid)) return urlCache.get(gid);

    let resolved = '';

    // Try one cached get_product_details lookup to get the real handle/URL.
    if (mcpClient) {
      try {
        const res = await mcpClient.callTool('get_product_details', { product_id: gid });
        const text = res?.content?.[0]?.text;
        if (text) {
          let obj = text;
          if (typeof text === 'string') {
            const trimmed = text.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              try { obj = JSON.parse(trimmed); } catch { obj = null; }
            } else {
              console.warn('[Tool] get_product_details non-JSON response:', trimmed.slice(0, 200));
              obj = null;
            }
          }
          const detail = obj?.product || obj?.products?.[0] || obj;
          const url = detail?.url || detail?.onlineStoreUrl || detail?.online_store_url;
          if (url && /^https?:\/\//i.test(String(url))) {
            resolved = String(url);
          } else if (detail?.handle) {
            resolved = `/products/${detail.handle}`;
          }
        }
      } catch (err) {
        console.warn('[Tool] get_product_details failed:', err.message);
      }
    }

    // Fallback: build the handle from the title (Shopify's default slug) so the
    // link resolves to the product page instead of a numeric-id path that 404s.
    if (!resolved) {
      const slug = slugifyTitle(product.title);
      if (slug) resolved = `/products/${slug}`;
    }

    if (gid && resolved) urlCache.set(gid, resolved);
    return resolved;
  };

  /**
   * Best-effort extraction of a product image URL from any of the many
   * possible catalog response shapes.
   */
  const extractProductImage = (product) => {
    if (product.image_url) return product.image_url;
    if (product.image?.src) return product.image.src;
    if (product.image?.url) return product.image.url;
    if (product.featured_image) return product.featured_image;
    if (product.featuredImage?.url) return product.featuredImage.url;
    if (product.featuredImage?.src) return product.featuredImage.src;
    if (product.images && product.images.length > 0) {
      return product.images[0].src || product.images[0].url || '';
    }
    if (product.media && Array.isArray(product.media) && product.media.length > 0) {
      const first = product.media[0];
      if (first.url) return first.url;
      if (first.image?.url) return first.image.url;
    }
    if (product.variants?.[0]?.media && Array.isArray(product.variants[0].media) && product.variants[0].media.length > 0) {
      const vm = product.variants[0].media[0];
      if (vm.url) return vm.url;
      if (vm.image?.url) return vm.image.url;
    }
    if (product.media?.edges?.[0]?.node?.image?.url) return product.media.edges[0].node.image.url;
    if (product.media?.edges?.[0]?.node?.previewImage?.url) return product.media.edges[0].node.previewImage.url;
    return '';
  };

  /**
   * Extract the display price from a product, converting minor units (cents)
   * to a formatted currency string.
   */
  const extractProductPrice = (product) => {
    if (product.price_range) {
      const pr = product.price_range;
      const minAmount = pr.min?.amount ?? pr.amount;
      const currency = pr.min?.currency ?? pr.currency ?? '';
      if (minAmount != null) {
        const price = (Number(minAmount) / 100).toFixed(2);
        return currency ? `${currency} $${price}` : `$${price}`;
      }
    }
    if (product.variants && product.variants.length > 0) {
      const v = product.variants[0];
      const amount = v.price?.amount ?? v.price;
      const currency = v.price?.currency ?? v.currency ?? '';
      if (amount != null) {
        const price = (Number(amount) / 100).toFixed(2);
        return currency ? `${currency} $${price}` : `$${price}`;
      }
    }
    return 'Price not available';
  };

  /**
   * Extract the product description as plain text from string or rich-text shapes.
   */
  const extractProductDescription = (product) => {
    if (!product.description) return '';
    if (typeof product.description === 'string') return product.description;
    if (product.description.html) return product.description.html;
    if (product.description.text) return product.description.text;
    return '';
  };

  /**
   * Extract a storefront URL/handle from a product, falling back to a numeric
   * product ID extracted from a Shopify GID.
   */
  const extractProductUrl = (product) => {
    if (product.url) return product.url;
    if (product.online_store_url) return product.online_store_url;
    if (product.onlineStoreUrl) return product.onlineStoreUrl;
    if (product.handle) return `/products/${product.handle}`;
    const gid = product.id || product.product_id || '';
    const match = gid.match(/gid:\/\/shopify\/Product\/(\d+)/);
    if (match) return `/products/${match[1]}`;
    return '';
  };

  /**
   * Normalize a raw product into the shape consumed by the frontend.
   */
  const formatProductData = (product, resolvedUrl) => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    return {
      id: product.product_id || product.id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || 'Product',
      handle: product.handle || null,
      price: extractProductPrice(product),
      image_url: extractProductImage(product),
      description: extractProductDescription(product),
      url: resolvedUrl !== undefined ? resolvedUrl : extractProductUrl(product),
      available: extractProductAvailability(product),
      variant_id: extractProductVariantId(variants[0] || product),
      options: Array.isArray(product.options)
        ? product.options.map((o) => ({
            name: o.name || 'Option',
            values: Array.isArray(o.values) ? o.values : [],
          }))
        : [],
      variants: variants.map((v) => ({
        id: extractProductVariantId(v),
        title: v.title || null,
        options: Array.isArray(v.options)
          ? v.options.map((o) => ({ name: o.name, value: o.label || o.value }))
          : [],
      })),
    };
  };

  const extractProductVariantId = (productOrVariant) => {
    const vid = productOrVariant?.variants?.[0]?.id
      || productOrVariant?.variant_id
      || productOrVariant?.id;
    if (!vid) return null;
    const m = String(vid).match(/gid:\/\/shopify\/ProductVariant\/(\d+)/);
    return m ? m[1] : vid;
  };

  const extractProductAvailability = (product) => {
    if (product.available != null) return product.available;
    if (product.availability?.available != null) return product.availability.available;
    if (product.variants?.[0]?.availability?.available != null) {
      return product.variants[0].availability.available;
    }
    if (product.variants?.[0]?.available != null) return product.variants[0].available;
    return null; // unknown
  };

  /**
   * Append a tool result message to the in-memory history and persist it.
   */
  const addToolResultToHistory = async (conversationHistory, toolUseId, content, conversationId) => {
    const toolResultMessage = {
      role: "tool",
      tool_call_id: toolUseId,
      content: content,
    };

    conversationHistory.push(toolResultMessage);

    if (conversationId) {
      try {
        await saveMessage(conversationId, 'tool', JSON.stringify({ tool_call_id: toolUseId, content }));
      } catch (error) {
        console.error('Error saving tool result to database:', error);
      }
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    addToolResultToHistory,
    extractToolResultText,
    formatProductData,
  };
}

export default {
  createToolService,
};
