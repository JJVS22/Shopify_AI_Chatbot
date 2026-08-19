/**
 * Chat API Route
 * Handles chat interactions with DeepSeek API and MCP tools
 */
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createToolService } from "../services/tool.server";
import process from "node:process";
import {
  createLlmProvider,
  getTryonOpenAiTools,
} from "../services/providers/index";
import { handleTryonToolCall, isTryonTool } from "../services/tryon.server";
import { gateOpenAiTools } from "../services/layers/gateTools";
import {
  getCustomOpenAiTools,
  handleCustomToolCall,
  isCustomTool,
} from "../services/providers/custom/tools";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Return the persisted message history for a conversation.
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);
  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
}

/**
 * Parse the incoming chat request and wrap a single chat session in an SSE stream.
 */
async function handleChatRequest(request) {
  try {
    const body = await request.json();
    const userMessage = body.message;

    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Drive a single chat turn: connect to the MCP servers, run the LLM with tool
 * calls in a bounded loop, execute try-on / MCP tools, and stream events back
 * to the client (id, chunks, tool progress, try-on results, product cards).
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream
}) {
  const deepseekService = createLlmProvider();
  const toolService = createToolService();

  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const shopDomain = request.headers.get("Origin");
  const customerUrls = await getCustomerAccountUrls(shopDomain, conversationId);
  const mcpApiUrl = customerUrls?.mcpApiUrl;

  const mcpClient = new MCPClient(
    shopDomain,
    conversationId,
    shopId,
    mcpApiUrl,
  );

  try {
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    try {
      await mcpClient.connectToStorefrontServer();
      await mcpClient.connectToCustomerServer();
      console.log(`[MCP] Connected with ${mcpClient.tools.length} total tools`);
      if (mcpClient.tools.length > 0) {
        console.log(`[MCP] Tool names:`, mcpClient.tools.map(t => t.name).join(', '));
      } else {
        console.warn(`[MCP] WARNING: 0 tools loaded — tool calling will not work!`);
      }
    } catch (error) {
      console.warn('[MCP] Failed to connect to MCP servers, continuing without tools:', error.message);
    }

    let productsToDisplay = [];

    await saveMessage(conversationId, 'user', userMessage);

    const dbMessages = await getConversationHistory(conversationId);
    const conversationHistory = buildConversationHistory(dbMessages);

    const mcpTools = mcpClient.tools.length > 0 ? mcpClient.getOpenAiTools() : [];
    const tryonTools = process.env.REPLICATE_API_TOKEN ? getTryonOpenAiTools() : [];
    const customTools = getCustomOpenAiTools();
    const openAiTools = gateOpenAiTools([...mcpTools, ...customTools, ...tryonTools]);
    console.log(
      '[Chat] Tools registered for LLM:',
      openAiTools.map(t => t.function.name).join(', ')
    );

    let storeContext = null;
    try {
      storeContext = await buildStoreContext(mcpClient);
      if (storeContext) console.log('[Chat] Store context built for LLM');
    } catch (err) {
      console.warn('[Chat] Failed to build store context:', err.message);
    }

    const MAX_LOOPS = deepseekService.MAX_TOOL_LOOP_ITERATIONS;

    for (let i = 0; i < MAX_LOOPS; i++) {
      console.log(`[Chat] Tool loop iteration ${i + 1}/${MAX_LOOPS}`);

      const result = await deepseekService.getCompletion({
        messages: conversationHistory,
        promptType,
        tools: openAiTools,
        storeContext,
      });

      const hasToolCalls = result?.tool_calls && result.tool_calls.length > 0;

      if (!hasToolCalls) {
        console.log(`[Chat] No tool calls in response, ending loop`);
        if (result?.content) {
          stream.sendMessage({ type: "chunk", chunk: result.content });
        }

        conversationHistory.push({ role: "assistant", content: result?.content || "" });
        await saveMessage(conversationId, "assistant", result?.content || "");

        stream.sendMessage({ type: "message_complete" });
        break;
      }

      stream.sendMessage({
        type: "tool_use",
        tool_use_message: "Looking up products for you..."
      });

      conversationHistory.push({
        role: "assistant",
        content: null,
        tool_calls: result.tool_calls,
      });
      await saveMessage(conversationId, "assistant", JSON.stringify({
        content: null,
        tool_calls: result.tool_calls,
      }));

      for (const toolCall of result.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          toolArgs = {};
        }

        console.log(`Executing tool: ${toolName}`, toolArgs);

        if (isTryonTool(toolName)) {
          stream.sendMessage({
            type: "tool_use",
            tool_use_message:
              toolName === "tryon_2d"
                ? "Running AI 2D try-on..."
                : "Generating 3D model (this can take 20–60 seconds)...",
          });

          try {
            const toolResult = await handleTryonToolCall(toolName, toolArgs, conversationId);

            await toolService.addToolResultToHistory(
              conversationHistory,
              toolCall.id,
              JSON.stringify(toolResult),
              conversationId
            );

            if (toolResult.ok && toolName === "tryon_2d" && toolResult.image_url) {
              stream.sendMessage({
                type: "tryon_2d_result",
                image_url: toolResult.image_url,
                product_title: toolResult.product_title || null,
                id: toolResult.id || null,
              });
            }

            if (toolResult.ok && toolName === "tryon_3d" && toolResult.viewer_url) {
              stream.sendMessage({
                type: "tryon_3d_result",
                glb_url: toolResult.glb_url,
                viewer_url: toolResult.viewer_url,
                preview_video_url: toolResult.preview_video_url || null,
                id: toolResult.id || null,
              });
            }
          } catch (err) {
            console.error(`[Chat] Try-on tool ${toolName} failed:`, err);
            await toolService.addToolResultToHistory(
              conversationHistory,
              toolCall.id,
              JSON.stringify({ ok: false, error: err.message }),
              conversationId
            );
          }
          continue;
        }

        if (isCustomTool(toolName)) {
          stream.sendMessage({
            type: "tool_use",
            tool_use_message: "Let me take care of that for you...",
          });

          const shopDomain = request.headers.get("Origin") || null;
          const toolResult = await handleCustomToolCall(toolName, toolArgs, { conversationId, shopDomain });

          await toolService.addToolResultToHistory(
            conversationHistory,
            toolCall.id,
            JSON.stringify(toolResult),
            conversationId
          );

          // Human CS handoff (Layer 3) — notify the frontend to switch modes.
          if (toolResult.ok && toolResult.type === "human_support") {
            stream.sendMessage({
              type: "human_support",
              message: toolResult.message || "Connecting you to a human agent...",
              ticket_id: toolResult.ticket_id || null,
              assistance_type: toolResult.assistance_type || null,
            });
          }

          // Callback booking — frontend renders a fixed-question form.
          if (toolResult.ok && toolResult.type === "callback_form") {
            stream.sendMessage({
              type: "callback_form",
              message: toolResult.message || "",
            });
          }

          // Cart updates — frontend shows "Continue to Shop" / "Check Out" buttons.
          if (toolResult.ok && (toolResult.type === "cart" || toolResult.type === "cart_summary")) {
            stream.sendMessage({
              type: "cart_updated",
              message: toolResult.message || "",
              checkout_url: toolResult.checkout_url || null,
            });
          }

          continue;
        }

        try {
          const toolResponse = await mcpClient.callTool(toolName, toolArgs);

          if (toolResponse.error) {
            await toolService.handleToolError(
              toolResponse, toolName, toolCall.id,
              conversationHistory,
              (msg) => stream.sendMessage(msg),
              conversationId
            );
          } else {
            await toolService.handleToolSuccess(
              toolResponse, toolName, toolCall.id,
              conversationHistory, productsToDisplay, conversationId, mcpClient
            );
          }
        } catch (error) {
          console.error(`Failed to call tool ${toolName}:`, error);
          await toolService.addToolResultToHistory(
            conversationHistory, toolCall.id,
            `Error: ${error.message}`,
            conversationId
          );
        }
      }
    }

    stream.sendMessage({ type: 'end_turn' });

    if (productsToDisplay.length > 0) {
      console.log(`[Chat] Sending ${productsToDisplay.length} product results to frontend`);
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });

      // Persist product cards so they can be restored when the user navigates
      // between pages (stored as a special "product" message).
      try {
        await saveMessage(conversationId, 'product', JSON.stringify(productsToDisplay));
      } catch (err) {
        console.error('[Chat] Failed to persist product results:', err.message);
      }
    } else {
      console.log(`[Chat] No products to display (tool wasn't called or failed)`);
    }
  } catch (error) {
    console.error('Chat session error:', error);
    throw error;
  }
}

/**
 * Build a short "what does this store sell" context for the LLM by doing one
 * catalog search, so it doesn't invent unrelated products.
 * @param {MCPClient} mcpClient
 * @returns {Promise<string|null>}
 */
async function buildStoreContext(mcpClient) {
  if (!mcpClient || !mcpClient.tools.length) return null;
  if (!mcpClient.storefrontTools.some((t) => t.name === AppConfig.tools.productSearchName)) {
    return null;
  }

  const res = await mcpClient.callTool(AppConfig.tools.productSearchName, {
    catalog: { query: "products" },
  });

  const text = res?.content?.[0]?.text;
  if (!text) return null;

  const data = typeof text === "string" ? JSON.parse(text) : text;
  if (!data?.products || data.products.length === 0) return null;

  const titles = data.products
    .slice(0, 20)
    .map((p) => p.title || "Untitled product")
    .join("\n- ");

  return (
    `The store sells the following products (catalog preview):\n- ${titles}\n` +
    `Recommend ONLY products available in this store. Before suggesting products, ` +
    `confirm availability with the search_catalog tool.`
  );
}

/**
 * Rebuild the LLM message history from persisted DB messages, reconstructing
 * assistant tool_calls and tool results from their JSON-encoded form.
 */
function buildConversationHistory(dbMessages) {
  const history = [];

  for (const msg of dbMessages) {
    if (msg.role === 'user') {
      history.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed && typeof parsed === 'object' && parsed.tool_calls) {
          history.push({
            role: 'assistant',
            content: parsed.content || null,
            tool_calls: parsed.tool_calls,
          });
        } else {
          history.push({ role: 'assistant', content: msg.content });
        }
      } catch {
        history.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      try {
        const parsed = JSON.parse(msg.content);
        history.push({
          role: 'tool',
          tool_call_id: parsed.tool_call_id,
          content: parsed.content,
        });
      } catch {
        history.push({ role: 'tool', content: msg.content });
      }
    }
  }

  return history;
}

/**
 * Resolve the customer account MCP/OpenID endpoints for a shop (cached in DB),
 * using Shopify's well-known discovery URLs.
 */
async function getCustomerAccountUrls(shopDomain, conversationId) {
  try {
    const existingUrls = await getCustomerAccountUrlsFromDb(conversationId);
    if (existingUrls) return existingUrls;

    const { hostname } = new URL(shopDomain);

    const urls = await Promise.all([
      fetch(`https://${hostname}/.well-known/customer-account-api`).then(res => res.json()),
      fetch(`https://${hostname}/.well-known/openid-configuration`).then(res => res.json()),
    ]).then(async ([mcpResponse, openidResponse]) => {
      const response = {
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      };

      await storeCustomerAccountUrls({
        conversationId,
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      });

      return response;
    });

    return urls;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return null;
  }
}

/**
 * Build CORS response headers mirroring the request origin.
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400"
  };
}

/**
 * Build headers for a server-sent events (SSE) response.
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}
