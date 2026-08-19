import { ALLOWED_TOOL_NAMES } from "./toolLayers";

/**
 * Gate which tools the LLM can see.
 *
 * Rules:
 *   - Layer 1 + Layer 2 tools are registered (Layer 2 triggers auth-on-demand).
 *   - Layer 3 handoff tools are registered (they only create SupportTickets).
 *   - Layer 3 MCP tools (e.g. request_return) are filtered OUT so the LLM can
 *     never auto-trigger merchant actions — those go through
 *     request_after_sale_assistance instead.
 *
 * @param {Array<{type:string, function:{name:string}}>} openAiTools
 * @returns {Array} filtered tools
 */
export function gateOpenAiTools(openAiTools) {
  if (!Array.isArray(openAiTools)) return [];
  return openAiTools.filter((tool) => {
    const name = tool?.function?.name;
    if (!name) return false;
    const allowed = ALLOWED_TOOL_NAMES.has(name);
    if (!allowed) {
      console.log(`[Gate] Excluded tool from LLM: ${name}`);
    }
    return allowed;
  });
}

export default {
  gateOpenAiTools,
};
