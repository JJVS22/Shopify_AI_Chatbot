import { saveMessage } from "../db.server";
import AppConfig from "./config.server";

export function createToolService() {
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, conversationId) => {
    if (toolUseResponse.error && toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      const errorText = typeof toolUseResponse.error.data === "string"
        ? toolUseResponse.error.data
        : JSON.stringify(toolUseResponse.error.data);
      await addToolResultToHistory(conversationHistory, toolUseId, errorText, conversationId);
      sendMessage({ type: 'auth_required' });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      const errorText = toolUseResponse.error
        ? (typeof toolUseResponse.error.data === "string" ? toolUseResponse.error.data : JSON.stringify(toolUseResponse.error))
        : "Unknown error";
      await addToolResultToHistory(conversationHistory, toolUseId, errorText, conversationId);
    }
  };

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

  const extractToolResultText = (toolUseResponse) => {
    if (!toolUseResponse) return "No result";
    if (toolUseResponse.content && Array.isArray(toolUseResponse.content) && toolUseResponse.content.length > 0) {
      return toolUseResponse.content[0].text || JSON.stringify(toolUseResponse.content[0]);
    }
    return typeof toolUseResponse === "string" ? toolUseResponse : JSON.stringify(toolUseResponse);
  };

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
    if (mcpClient && (product.id || product.product_id)) {
      const gid = product.id || product.product_id;
      const attempts = [
        { product_id: gid },
        { catalog: { product_id: gid } },
      ];
      for (const args of attempts) {
        try {
          const res = await mcpClient.callTool('get_product_details', args);
          const text = res?.content?.[0]?.text;
          if (!text) continue;
          const data = typeof text === 'string' ? JSON.parse(text) : text;
          const detail = data?.product || data?.products?.[0] || data;
          const url = detail?.url || detail?.onlineStoreUrl || detail?.online_store_url;
          if (url && /^https?:\/\//i.test(String(url))) return String(url);
          if (detail?.handle) return `/products/${detail.handle}`;
        } catch (err) {
          console.warn('[Tool] get_product_details failed:', err.message);
        }
      }
    }

    return ''; // unknown — no broken link
  };

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

  const extractProductDescription = (product) => {
    if (!product.description) return '';
    if (typeof product.description === 'string') return product.description;
    if (product.description.html) return product.description.html;
    if (product.description.text) return product.description.text;
    return '';
  };

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

  const formatProductData = (product, resolvedUrl) => {
    return {
      id: product.product_id || product.id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || 'Product',
      price: extractProductPrice(product),
      image_url: extractProductImage(product),
      description: extractProductDescription(product),
      url: resolvedUrl !== undefined ? resolvedUrl : extractProductUrl(product)
    };
  };

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
