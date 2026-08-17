import AppConfig from "./config.server";
import { createLlmProvider } from "./providers/index";
import { createToolService } from "./tool.server";

/**
 * Ask the LLM for complementary catalog search queries for the tried-on item.
 * Falls back to the product title itself and a generic "products" query.
 * @param {string|null} productTitle
 * @returns {Promise<string[]>}
 */
export async function buildPairingQueries(productTitle) {
  const fallback = productTitle ? [productTitle, "products"] : ["products"];
  try {
    const llm = createLlmProvider();
    const queryResult = await llm.getCompletion({
      messages: [
        {
          role: "user",
          content: productTitle
            ? `The customer just did a 2D virtual try-on of "${productTitle}". ` +
              `Suggest 1-3 short catalog search queries for OTHER products that would naturally pair with it ` +
              `and could be worn/used together in a new try-on. ` +
              `Do NOT suggest the same type of item (e.g., if it's pants, do not query for pants/shorts/jeans). ` +
              `Return ONLY a JSON array of strings, no markdown.`
            : `The customer just did a 2D virtual try-on. ` +
              `Suggest 1-3 short catalog search queries for complementary products that could be worn/used together. ` +
              `Return ONLY a JSON array of strings, no markdown.`,
        },
      ],
      promptType: AppConfig.api.defaultPromptType,
      tools: [],
      storeContext: null,
    });
    const text = queryResult?.content || "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {
    console.warn("[Pairing] Failed to generate pairing queries:", err.message);
  }
  return fallback;
}

/**
 * Search the catalog for a given query, trying the common argument shapes the
 * search_catalog tool may expect.
 * @returns {Promise<Array>} normalized products
 */
export async function searchCatalogForPairings(mcpClient, toolService, query) {
  const attempts = [{ catalog: { query } }, { query }];
  for (const args of attempts) {
    try {
      const result = await mcpClient.callTool(AppConfig.tools.productSearchName, args);
      const products = await toolService.processProductSearchResult(result, mcpClient);
      if (products.length > 0) return products;
    } catch (err) {
      console.warn("[Pairing] Search failed with args", JSON.stringify(args), err.message);
    }
  }
  return [];
}

/**
 * Find complementary products that pair well with the tried-on item.
 * Requires a connected MCPClient with the storefront search_catalog tool.
 * @param {object} params
 * @param {string|null} params.productTitle
 * @param {object} params.mcpClient
 * @param {number} [params.limit]
 * @returns {Promise<Array>} up to `limit` products (not tagged with try_on url)
 */
export async function findPairingProducts({ productTitle, mcpClient, limit = 4 }) {
  if (!mcpClient?.tools?.length) return [];
  if (!mcpClient.storefrontTools.some((t) => t.name === AppConfig.tools.productSearchName)) {
    return [];
  }

  const toolService = createToolService();
  const pairings = [];

  try {
    const queries = await buildPairingQueries(productTitle);
    const excludedTitleLower = (productTitle || "").toLowerCase();

    for (const query of queries.slice(0, 4)) {
      if (pairings.length >= limit) break;
      if (typeof query !== "string" || !query.trim()) continue;

      const products = await searchCatalogForPairings(mcpClient, toolService, query.trim());
      for (const product of products) {
        if (pairings.length >= limit) break;
        if (excludedTitleLower && product.title && product.title.toLowerCase().includes(excludedTitleLower)) continue;
        if (pairings.some((p) => p.id === product.id)) continue;
        pairings.push(product);
      }
    }
  } catch (err) {
    console.error("[Pairing] findPairingProducts failed:", err.message);
  }

  return pairings;
}

export default {
  buildPairingQueries,
  searchCatalogForPairings,
  findPairingProducts,
};
