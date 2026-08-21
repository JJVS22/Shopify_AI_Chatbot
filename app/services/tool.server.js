import { saveMessage } from "../db.server";
import AppConfig from "./config.server";

/**
 * Create a tool service that handles MCP tool results: success/error handling,
 * product search result parsing, and persisting tool messages to history.
 */
export function createToolService() {
  // Once get_product_details is confirmed to be returning non-JSON errors, stop
  // calling it for the rest of this service's lifetime to avoid slow, noisy retries.
  let detailsResolveBroken = false;

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

    // Keep the tool result the LLM sees consistent with the cards that are
    // actually shown (max maxProductsToDisplay), so the text answer never
    // lists more products than the cards.
    let historyText = resultText;
    if (toolName === AppConfig.tools.productSearchName) {
      historyText = trimProductResultText(resultText, AppConfig.tools.maxProductsToDisplay);
    }

    await addToolResultToHistory(conversationHistory, toolUseId, historyText, conversationId);
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
   * Cap the number of products inside a search_catalog tool result so the LLM
   * only ever sees as many products as will be shown as cards.
   * @param {string} resultText
   * @param {number} max
   * @returns {string}
   */
  const trimProductResultText = (resultText, max) => {
    if (!resultText || typeof resultText !== "string") return resultText;
    try {
      const data = JSON.parse(resultText);
      if (data && Array.isArray(data.products) && data.products.length > max) {
        data.products = data.products.slice(0, max);
        return JSON.stringify(data);
      }
    } catch (err) {
      // Not JSON — leave as-is.
    }
    return resultText;
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
            products = [];
            for (const rawProduct of rawProducts) {
              const url = await resolveProductUrl(rawProduct, mcpClient);
              products.push(formatProductData(rawProduct, url));
            }

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
   * Build a real, clickable storefront URL for a product.
   * Prefers an absolute URL or handle from the search result; otherwise
   * queries get_product_details to find the handle (numeric-id /products/<id>
   * paths are not valid Shopify product links).
   * @param {Object} product - raw catalog product
   * @param {Object} [mcpClient] - MCPClient instance
   * @returns {Promise<string>} absolute URL or "/products/<handle>", or "" if unknown
   */
  const resolveProductUrl = async (product, mcpClient) => {
    // Direct absolute URLs or handle-based paths from the search response
    const direct = extractProductUrl(product);
    if (direct && /^https?:\/\//i.test(direct)) return direct;
    if (product.handle) return `/products/${product.handle}`;
    if (direct && direct.startsWith('/products/') && !/\/products\/\d+$/.test(direct)) {
      return direct; // handle-based path, not a numeric-id fallback
    }

    // Try to get the real handle/URL via get_product_details
    if (!detailsResolveBroken && mcpClient && (product.id || product.product_id)) {
      const gid = product.id || product.product_id;
      const numericId = String(gid).replace(/^gid:\/\/shopify\/Product\//, '');
      const attempts = [
        { product_id: gid },
        { catalog: { product_id: gid } },
        { product_id: numericId },
        { id: gid },
        { catalog: { id: gid } },
      ];
      for (const args of attempts) {
        try {
          const res = await mcpClient.callTool('get_product_details', args);
          const text = res?.content?.[0]?.text;

          // Some MCP servers return an error string (e.g. "Missing required ...")
          // instead of JSON. Log it fully and move on rather than crashing.
          if (!text) continue;
          if (typeof text !== 'string') {
            const obj = text?.product || text?.products?.[0] || text;
            const url = obj?.url || obj?.onlineStoreUrl || obj?.online_store_url;
            if (url && /^https?:\/\//i.test(String(url))) return String(url);
            if (obj?.handle) return `/products/${obj.handle}`;
            continue;
          }
          const trimmed = text.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            console.warn('[Tool] get_product_details non-JSON response:', trimmed.slice(0, 200));
            detailsResolveBroken = true;
            break;
          }
          const data = JSON.parse(trimmed);
          const detail = data?.product || data?.products?.[0] || data;
          const url = detail?.url || detail?.onlineStoreUrl || detail?.online_store_url;
          if (url && /^https?:\/\//i.test(String(url))) return String(url);
          if (detail?.handle) return `/products/${detail.handle}`;
        } catch (err) {
          console.warn('[Tool] get_product_details failed:', err.message);
        }
      }
    }

    // Fallback: a numeric-id path like /products/123. Shopify 301-redirects
    // these to the product's handle URL, so it is still a working product-page
    // link (better than no link at all for e.g. the featured products).
    const fallback = direct && direct.startsWith('/products/') ? direct : '';
    return fallback;
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
   * Extract the display price from a product.
   *
   * The Shopify storefront MCP has returned two different shapes over time:
   *  - newer /api/ucp/mcp (UCP catalog spec): `price_range: { min: { amount: 1899, currency: "USD" } }`
   *    and `variants[].price: { amount: 1899, currency }` — amounts in MINOR units (cents).
   *  - older /api/mcp: `price_range: { min: "28.0", currency: "CAD" }` and
   *    `variants[].price: "28.0"` — amounts in MAJOR units (plain strings/numbers).
   *
   * This handles both: object amounts are treated as cents (÷100), scalar
   * amounts are treated as major units directly.
   */
  const extractProductPrice = (product) => {
    const formatPrice = (majorAmount, currency) => {
      if (currency) {
        try {
          return new Intl.NumberFormat("en", {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(majorAmount);
        } catch (err) {
          // fall through to the "$" fallback
        }
      }
      return `$${Number(majorAmount).toFixed(2)}`;
    };

    const moneyValue = (value, fallbackCurrency) => {
      if (value == null) return null;
      // Object shape → amount in minor units (cents); scalar → major units.
      if (typeof value === 'object') {
        const amount = value.amount ?? value.value;
        if (amount == null) return null;
        return {
          major: Number(amount) / 100,
          currency: value.currency || fallbackCurrency || '',
        };
      }
      return {
        major: Number(value),
        currency: fallbackCurrency || '',
      };
    };

    if (product.price_range) {
      const pr = product.price_range;
      const parsed = moneyValue(pr.min ?? pr, pr.currency);
      if (parsed) return formatPrice(parsed.major, parsed.currency);
    }
    if (product.variants && product.variants.length > 0) {
      const v = product.variants[0];
      const parsed = moneyValue(v.price, v.currency);
      if (parsed) return formatPrice(parsed.major, parsed.currency);
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
    // get_product_details returns a single "selectedOrFirstAvailableVariant"
    // instead of a full variants array — treat it as the variant list so the
    // add-to-cart button gets a real variant id.
    let variants = Array.isArray(product.variants) ? product.variants : [];
    if (variants.length === 0 && product.selectedOrFirstAvailableVariant) {
      variants = [product.selectedOrFirstAvailableVariant];
    }
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
        available: v.available != null
          ? v.available
          : (v.availability ? v.availability.available : null),
        options: Array.isArray(v.options)
          ? v.options.map((o) => ({ name: o.name, value: o.label || o.value }))
          : Array.isArray(v.selected_options)
            ? v.selected_options.map((o) => ({ name: o.name, value: o.value }))
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
    // get_product_details returns availability on the selected variant only.
    if (product.selectedOrFirstAvailableVariant?.availability?.available != null) {
      return product.selectedOrFirstAvailableVariant.availability.available;
    }
    if (product.selectedOrFirstAvailableVariant?.available != null) {
      return product.selectedOrFirstAvailableVariant.available;
    }
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
