# Tool Calling & Product Display — Changes Summary

## Overview

This document catalogs all changes made across 7 files to enable DeepSeek tool calling and proper product rendering in the Shopify AI Chatbot.

---

## File-by-File Changes

### 1. `app/services/config.server.js`

**Line 26** — Tool name corrected to match MCP server:

```
- productSearchName: "search_shop_catalog"
+ productSearchName: "search_catalog"
```

The MCP server exposes the catalog search tool as `search_catalog`, not `search_shop_catalog`. The `handleToolSuccess` function uses this constant to identify product search results for display extraction. With the wrong name, product data was fetched but never extracted.

---

### 2. `app/mcp-client.js`

**Lines 289–303** — Added `getOpenAiTools()` method:

```js
getOpenAiTools() {
  return this.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}
```

MCP tools use format: `{ name, description, input_schema }`. DeepSeek (OpenAI SDK) requires: `{ type: "function", function: { name, description, parameters } }`. This method converts between the two formats.

---

### 3. `app/services/deepseek.server.js`

Complete rewrite. Key changes:

| Line | Change | Why |
|------|--------|-----|
| 27 | Added `tool_choice: "auto"` | Without this, DeepSeek may ignore provided tools entirely |
| 37–49 | Extracted `getCompletion()` as standalone function | Previously only available via `streamConversation`, which mixed API call with callback logic. Needed a clean function for the tool-calling loop |
| 46–59 | Added `[DeepSeek]` prefix logging | Shows: how many tools/messages sent, whether response contains `tool_calls` or is text-only. Critical for debugging |
| 68 | Exported `MAX_TOOL_LOOP_ITERATIONS = 5` | Safety limit to prevent infinite loops if the LLM keeps calling tools |

---

### 4. `app/services/tool.server.js`

Complete rewrite. Key changes:

| Lines | Function | What it fixes |
|-------|----------|---------------|
| 35–41 | `extractToolResultText()` | MCP returns `{ content: [{ type: "text", text: "..." }] }`. This extracts the actual text payload. |
| 82–96 | `handleToolSuccess()` logging | Prints raw MCP response, product keys, sample product — needed to debug data structure |
| 100–123 | `extractProductImage()` | Added 2 fallback paths: `product.media[0].url` and `product.variants[0].media[0].url`. MCP stores images inside variant media arrays. Old code had 8 paths but missed these. |
| 125–145 | `extractProductPrice()` (new) | MCP returns `price_range: { min: { amount: 74995, currency: "USD" } }`. Old code did string interpolation on the raw object → `"[object Object]"`. New code drills into `min.amount / 100` → `"USD $749.95"`. |
| 147–153 | `extractProductDescription()` (new) | MCP returns `description: { html: "" }` object. Old `|| ''` fallback on an object is always truthy → `"[object Object]"`. New code extracts `.html` or `.text`. |
| 155–164 | `extractProductUrl()` (new) | MCP returns GID (`gid://shopify/Product/9096566079665`) but not `handle` or `url`. Regex-parses numeric ID → `/products/9096566079665`. |
| 166–175 | `formatProductData()` | Now delegates to the four extraction functions above |
| 177–193 | `addToolResultToHistory()` | Switched from Anthropic format (`role: "user"`, `content: [{ type: "tool_result" }]`) to OpenAI format (`role: "tool"`, `tool_call_id`, `content`). DeepSeek requires OpenAI format. |

---

### 5. `app/routes/chat.jsx`

Complete rewrite. Key changes:

| Lines | Change | Why |
|-------|--------|-----|
| 91 | `customerUrls?.mcpApiUrl` | Previously destructured `{ mcpApiUrl }` directly which threw if `getCustomerAccountUrls` returned `null` |
| 104–114 | MCP tool name logging | Prints tool names and warns if 0 tools loaded — critical for catching connection failures |
| 119 | `mcpClient.getOpenAiTools()` | Uses OpenAI-format tools instead of raw MCP format |
| 123–196 | **Tool calling loop** | Core new feature. Max 5 iterations: calls DeepSeek → checks for `tool_calls` → executes via MCP → adds results to history → repeats until text-only response |
| 198–208 | `product_results` event | Sends formatted products to frontend via SSE after the tool loop completes. Logs whether products were sent or skipped |
| 212–248 | `buildConversationHistory()` | Reconstructs conversation from DB rows into proper OpenAI message format. Handles `role: "tool"` messages with `tool_call_id` and assistant messages containing `tool_calls` — the old `{ role, content }` flat mapping lost this structure |

---

### 6. `app/prompts/prompts.json`

Both system prompts — `search_shop_catalog` → `search_catalog` (to match actual MCP tool name).

Also added the bold critical instruction block:

> **CRITICAL: When a customer asks about products, you MUST use the search_catalog tool to find matching products before responding.**

---

### 7. `extensions/chat-bubble/assets/chat.css`

| Selector | Change | Why |
|----------|--------|-----|
| `.shop-ai-product-grid` | Removed `min-height: 220px`, added `align-items: stretch` | The fixed min-height forced cards too short, clipping the button below. Cards now size to content. |
| `.shop-ai-product-card` | Removed `overflow: hidden`, changed `display: block` → `display: flex; flex-direction: column` | `overflow: hidden` clipped any content exceeding card height (including the button). Flex layout lets card grow naturally. |
| `.shop-ai-product-image` | Added `flex-shrink: 0` | Prevents image from being squished when content is tall |
| `.shop-ai-product-info` | Added `display: flex; flex-direction: column; flex: 1` | Pushes the button to the bottom of the card |
| `.shop-ai-product-title` | Changed from `white-space: nowrap` truncation to 2-line clamp | Single-line overflow was truncating titles; 2-line clamp shows more context |
| `.shop-ai-product-price` | Margin changed from `0 0 10px 0` to `0 0 auto 0` | `auto` margin pushes button to card bottom |
| `.shop-ai-add-to-cart` | Added `flex-shrink: 0; margin-top: 8px` | Guarantees button is always visible at the card bottom |

---

## End-to-End Flow

```
User: "Show me shoes"
  │
  ▼
chat.jsx → saveMessage(conversationId, 'user', message)
  │
  ▼
buildConversationHistory() reconstructs messages from DB
  │
  ▼
Tool loop (max 5 iterations):
  │
  ├─ deepseekService.getCompletion(messages, tools)
  │     │
  │     ├─ deepseek.server.js: buildApiPayload() adds tool_choice: "auto"
  │     └─ deepseek.server.js: calls deepseekClient.chat.completions.create()
  │
  ├─ Response has tool_calls?
  │     │
  │     ├─ YES → mcpClient.callTool(toolName, toolArgs)
  │     │         │
  │     │         ├─ Tool = "search_catalog"?
  │     │         │     │
  │     │         │     ├─ YES → toolService.handleToolSuccess()
  │     │         │     │          │
  │     │         │     │          ├─ extractProductImage()  (variants[0].media[0].url)
  │     │         │     │          ├─ extractProductPrice()  (price_range.min.amount / 100)
  │     │         │     │          ├─ extractProductUrl()    (GID → /products/{id})
  │     │         │     │          └─ productsToDisplay.push(formatted)
  │     │         │     │
  │     │         │     └─ NO → addToolResultToHistory()
  │     │         │
  │     │         └─ Continue loop (tool result added to history)
  │     │
  │     └─ NO → stream.sendMessage("chunk", text)
  │              stream.sendMessage("message_complete")
  │              break
  │
  ▼
stream.sendMessage("end_turn")
stream.sendMessage("product_results", products)
  │
  ▼
Frontend (chat.js):
  ├─ handleStreamEvent("chunk") → displays AI text
  ├─ handleStreamEvent("product_results") → displayProductResults()
  │     │
  │     └─ Product.createCard() for each product:
  │           ├─ <img src="image_url">
  │           ├─ <h3> title
  │           ├─ <p> price
  │           └─ <button class="shop-ai-add-to-cart"> Add to Cart
  │
  └─ CSS renders cards with images, prices, and visible buttons
```

## Cross-File Problems Found

| Problem | Files involved | Root cause |
|---------|---------------|------------|
| Tool never matched for product extraction | `config.server.js` ↔ `tool.server.js` ↔ MCP | `search_shop_catalog` ≠ `search_catalog` |
| DeepSeek received tools but couldn't understand them | `mcp-client.js` ↔ `deepseek.server.js` | MCP `input_schema` format vs OpenAI `type/function/parameters` format |
| Tool result stored in wrong message format | `tool.server.js` ↔ `deepseek.server.js` | Anthropic `role: user + content: [{type: "tool_result"}]` vs OpenAI `role: tool + tool_call_id` |
| Price displayed as `[object Object]` | `tool.server.js` | Nested `price_range.min` object stringified instead of accessing `.amount` |
| Image not found | `tool.server.js` | Image at `variants[0].media[0].url` — no extraction path for this location |
| Button clipped by CSS | `chat.css` | `overflow: hidden` + `min-height: 220px` cut off card content |
| Conversation history reconstruction broken | `chat.jsx` | DB rows mapped to flat `{role, content}` — lost `tool_call_id` and `tool_calls` |
