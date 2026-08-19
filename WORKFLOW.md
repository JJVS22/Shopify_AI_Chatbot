# WORKFLOW — Shop AI Chatbot

**App:** Shopify AI chat assistant with 2D / 3D virtual try-on, cart, and a 3-layer customer service split
**Models involved:**
| Role | Provider | What it does |
|------|----------|--------------|
| LLM (chat brain) | DeepSeek (`deepseek-v4-flash`) | Understands user text, decides which tool to call |
| 2D image edit (try-on) | Replicate `prunaai/p-image-edit` | Composes a store product with a person photo |
| Image → 3D | Replicate `firtoz/trellis` | Generates a GLB 3D model from an image |

**Stack:** React Router (Vite SSR) backend + Shopify theme extension (vanilla JS) storefront. Chat uses Server-Sent Events (SSE) streaming. Data lives in SQLite (Prisma) + files on disk.

---

## 1. Architecture

```
Storefront chat bubble (extensions/chat-bubble/assets/chat.js)
   │  SSE stream: id / chunk / message_complete / product_results /
   │              tryon_2d_result / tryon_3d_result / cart_updated /
   │              human_support / callback_form / auth_required / tool_use / end_turn
   ▼
/chat  (app/routes/chat.jsx)  ──  Tool loop  ──┐
   │                                             │ DeepSeek decides tool_calls
   │  gateTools filters which tools the LLM sees │ (layers 1+2 + safe handoff tools)
   │
   ├─ Shopify MCP tools  → mcpClient (storefront + customer MCP)
   │     search_catalog / get_product_details / get_cart / update_cart / ... → product cards
   │
   ├─ tryon_2d / tryon_3d  → tryon.server → Replicate (p-image-edit / trellis)
   │                          └─ saves files to storage/tryon-results/{2d|3d}/ + SQLite refs
   │
   └─ Custom tools (app/services/providers/custom/) → cart, store info, tickets, callback
         add_to_cart / remove_from_cart / get_cart_summary / get_checkout_url
         get_store_info / escalate_to_human / request_after_sale_assistance
         create_support_ticket / schedule_callback
   │
   ▼
HTTP APIs (also call the same services):
   POST /api/tryon/2d                 → 2D try-on result
   POST /api/tryon/3d                 → 3D GLB + viewer URL
   POST /api/tryon/callback           → create a callback SupportTicket
   GET  /api/tryon/results/{2d|3d}/<file>  → serves saved files
   GET  /tryon/viewer?glb=...         → Three.js 360° GLB viewer
   GET  /api/image-proxy?url=...      → CORS-safe image proxy
   GET  /chat?history=true            → conversation history (text + product cards)
```

**On the storefront itself:** the product card's **Add to Cart** button calls the real Shopify Ajax Cart API directly (`POST /cart/add.js`) — same origin, no backend round-trip.

---

## 2. Customer service layers

Tools are organized **by layer**, with an **origin** tag (storefront / customer / custom).

| Layer | Access | Tools |
|-------|--------|-------|
| **1 — No auth, fully auto** | Public store data + AI | `search_catalog`, `get_product_details`, `search_shop_policies_and_faqs`, `get_store_info`, `get_shipping_estimate`, `get_featured_or_new_products`, `get_product_availability`, `add_to_cart`, `remove_from_cart`, `get_cart_summary`, `get_checkout_url`, `tryon_2d`, `tryon_3d` |
| **2 — Customer auth (auth-on-demand)** | Personal/account | `apply_discount_code`, `get_cart`, `update_cart`, `get_most_recent_order_status`, `get_order_details`, `get_order_history`, `track_shipment`, `get_store_credit_balances`, `get_customer_profile`, `get_wishlist`, `add_to_wishlist` |
| **3 — Human CS / merchant-gated** | Never auto-completes; creates tickets | `escalate_to_human`, `request_after_sale_assistance` (return/refund/cancel/modify/warranty), `create_support_ticket`, `schedule_callback` |

- `app/services/layers/toolLayers.js` — the registry (layer + origin + comments).
- `app/services/layers/gateTools.js` — `gateOpenAiTools()` registers Layer 1 + Layer 2 + the safe Layer 3 handoff tools; **excludes** MCP `request_return` so the LLM can't auto-trigger merchant actions.
- Layer 2 uses **auth-on-demand**: when a customer-scoped tool needs a token, the backend returns `auth_required` → the chat shows a **"Log in to continue"** button (OAuth popup + token polling).

---

## 3. File map

### Backend routes (`app/routes/`)

| File | Job |
|------|-----|
| `chat.jsx` | Main chat SSE endpoint + DeepSeek tool-calling loop (gated tools, custom dispatch) |
| `api.tryon.2d.jsx` | 2D try-on endpoint (multipart photo upload or JSON URLs) |
| `api.tryon.3d.jsx` | 3D generation endpoint (image URL → GLB + viewer URL) |
| `api.tryon.callback.jsx` | Creates a callback `SupportTicket` from the chat form |
| `api.tryon.results.$.jsx` | Serves locally saved 2D/3D result files |
| `tryon.viewer.jsx` | HTML page with Three.js + OrbitControls to view a GLB in 360° |
| `api.image-proxy.jsx` | Proxies product images so the browser canvas stays untainted |
| `auth.callback.jsx` / `auth.token-status.jsx` | Customer OAuth token exchange + status polling |
| `admin.*` (future) | Merchant ticket view (Phase C) |

### Services (`app/services/`)

| File | Job |
|------|-----|
| `deepseek.server.js` | DeepSeek client + `getCompletion` (OpenAI-style tool calling, optional `storeContext`) |
| `tryon.server.js` | High-level try-on orchestration + DB record writing |
| `tool.server.js` | Processes MCP product-search results into display cards (incl. stock + variants) |
| `cleanup.server.js` | 24h TTL sweep: deletes old conversations + try-on files |
| `streaming.server.js` | SSE stream manager |
| `config.server.js` | All env-driven app configuration |

### Providers (`app/services/providers/`)

| File | Job |
|------|-----|
| `replicate.server.js` | Shared Replicate SDK client + file upload/download helpers |
| `storage.server.js` | Saves/loads try-on files on disk (no JSON sidecars; metadata in SQLite) |
| `imageEdit/replicate-p-image-edit.adapter.js` | 2D try-on adapter (swappable) |
| `imageTo3d/replicate-trellis.adapter.js` | Image→3D adapter (swappable; saves GLB + MP4 only) |
| `index.js` | Provider factories + try-on tool definitions |
| `custom/tools.js` | OpenAI schemas + dispatch for ALL custom tools |
| `custom/cart.server.js` | Anonymous cart wrappers + checkout URL |
| `custom/store-info.server.js` | `get_store_info` (ShopMeta cache, Admin API wrapper) |
| `custom/tickets.server.js` | Layer 3: tickets, escalation, callback form trigger |

### Layers (`app/services/layers/`)

| File | Job |
|------|-----|
| `toolLayers.js` | Layer registry (layer1/2/3 + origin) + `ALLOWED_TOOL_NAMES` |
| `gateTools.js` | Filters which tools the LLM sees |

### Frontend (`extensions/chat-bubble/`)

| File | Job |
|------|-----|
| `assets/chat.js` | All storefront chat logic (UI, messages, SSE, product cards, try-on, cart, forms) |
| `assets/chat.css` | Chat + try-on + cart + forms styling |
| `blocks/chat-interface.liquid` | Chat widget template |

### Other

| File | Job |
|------|-----|
| `app/mcp-client.js` | MCPClient: connects to Shopify MCP servers, calls catalog/customer tools |
| `app/auth.server.js` | Customer OAuth PKCE flow (generates auth URL) |
| `app/prompts/prompts.json` | System prompts: catalog-aware, placement confirmation, 3-layer guidance |
| `app/db.server.js` | Prisma DB access (messages, tokens, try-on refs, support tickets, shop meta) |

---

## 4. Database (SQLite via Prisma)

| Table | Role |
|-------|------|
| `Conversation` | Chat ID; links messages, try-on results, support tickets; `updatedAt` drives 24h cleanup |
| `Message` | Chat history (`role`: user/assistant/tool/**product**). Product cards are saved as `product` messages so they restore on page navigation |
| `TryOnResult` | Links a conversation to its 2D/3D files (path + public URL + provider/model) |
| `SupportTicket` | Layer 3 tickets (return/refund/cancel/modify/warranty/callback/escalation) |
| `ShopMeta` | Cached `get_store_info` data |
| `Session` / `CustomerToken` / `CodeVerifier` / `CustomerAccountUrls` | OAuth + customer MCP endpoint cache |

Binary files (jpg/glb/mp4) stay on **disk** under `storage/tryon-results/`; SQLite holds only metadata. Cleanup: `cleanup.server.js` deletes conversations + files older than 24h.

---

## 5. File & function explanations

### `app/routes/chat.jsx`

| Function | Job |
|----------|-----|
| `loader` / `action` | GET/POST entry → history or SSE chat |
| `handleChatRequest` | Parses `{message, conversation_id, prompt_type}`, opens an SSE stream |
| `handleChatSession` | Core orchestration: store context, gated tools, tool loop, dispatch, SSE events |
| `buildStoreContext` | One `search_catalog` call → list of store's products → injected into system prompt |
| `buildConversationHistory` | Rebuilds OpenAI-format messages from DB (skips `product` role) |
| `getCustomerAccountUrls` | Fetches/caches the shop's customer-account MCP endpoint |

**Tool loop dispatch order:**
1. `tryon_2d` / `tryon_3d` → `handleTryonToolCall` (Replicate) → `tryon_2d_result` / `tryon_3d_result`
2. Custom tools → `handleCustomToolCall` → may emit `human_support`, `callback_form`, or `cart_updated`
3. Everything else → `mcpClient.callTool(...)` (Shopify MCP) → tool service

### `app/services/deepseek.server.js`

`getSystemPrompt` · `buildApiPayload` (thinking disabled with tools) · `getCompletion({messages, promptType, tools, storeContext})` → message with optional `tool_calls` · `streamConversation` · `createDeepseekService`.

### `app/services/tryon.server.js`

`run2dTryon` / `run3dTryon` (call provider + write `TryOnResult` rows) · `handleTryonToolCall` · `isTryonTool` · `toAbsoluteUrl` (uses `AppConfig.tryon.appUrl`).

### `app/services/providers/custom/tools.js`

`getCustomOpenAiTools()` → OpenAI schemas for all custom tools · `handleCustomToolCall(name, args, ctx)` dispatch · `isCustomTool(name)`.

### `app/services/providers/custom/cart.server.js`

`addToCart` / `removeFromCart` / `getCartSummary` / `getCheckoutUrl` / `applyDiscountCode` — wrappers returning `{ok, type, message, checkout_url, cart}`; real Storefront cart API wired in Phase D. `checkout_url` = `{shopDomain}/cart` (guest checkout).

### `app/services/providers/custom/tickets.server.js`

`escalateToHuman` / `requestAfterSaleAssistance` (combined return/refund/cancel/modify/warranty) / `createSupportTicketHandler` → create a `SupportTicket`. `scheduleCallback` → returns `{type:'callback_form'}` (the chat shows a form; the form POSTs to `/api/tryon/callback`).

### `app/services/layers/toolLayers.js` & `gateTools.js`

Layer registry + `ALLOWED_TOOL_NAMES`; `gateOpenAiTools()` filters LLM tool registration.

### `app/services/tool.server.js`

`handleToolSuccess` (search_catalog → products, dedupe) · `handleToolError` (auth_required → includes `auth_url`) · `processProductSearchResult` (async; resolves real URLs) · `formatProductData` → `{id, title, price, image_url, description, url, available, variant_id, options, variants}` · `extractProduct*` helpers · `addToolResultToHistory`.

### `app/services/cleanup.server.js`

`runCleanup(maxAgeHours=24)` finds conversations idle >24h, deletes their files + rows; `startCleanupScheduler()` runs at boot + every 30 min (wired in `entry.server.jsx`).

### `app/mcp-client.js`

`connectToStorefrontServer` / `connectToCustomerServer` (tool discovery) · `callTool` / `callStorefrontTool` / `callCustomerTool` (401 → auth flow) · `getOpenAiTools`.

### Frontend `extensions/chat-bubble/assets/chat.js`

| Module / function | Job |
|-------------------|-----|
| `UI.init` / `setupEventListeners` | Chat open/close, input/send, bubble drag, resize toggle |
| `UI.restorePersistedUi` / `updateWindowDirection` | Session persistence + open-up/down logic |
| `UI.displayProductResults` | Renders product cards |
| `UI.displayAuthRequired` | "Log in to continue" button (auth popup + token polling) |
| `UI.displayCartUpdated` | Cart message + "Proceed to checkout" link |
| `UI.displayCallbackForm` | Fixed-question callback form → POST `/api/tryon/callback` |
| `Message.send` | Sends text + starts SSE stream |
| `API.streamResponse` / `handleStreamEvent` | SSE streaming + event dispatch |
| `Product.createCard` | Product card: image, stock badge, price, **variant picker**, **Add to Cart** (`/cart/add.js`), **Try On** |
| `TryOn.*` | 2D/3D try-on (upload → `/api/tryon/2d`, `/api/tryon/3d`, viewer link) |
| `Auth.*` | OAuth popup + token polling |

---

## 6. End-to-end flows

### Product search
```
User: "show me snowboards"
  → tool loop → DeepSeek calls search_catalog → Shopify MCP products
  → tool.server formats (image, price, stock, url, variants)
  → SSE product_results → product cards; also saved as role:'product' message
```

### Add to cart (button — real cart)
```
Click "Add to Cart" on a card
  → variant picker shown if the product has Size/Color options
  → POST /cart/add.js (Ajax Cart API, same origin) with selected variant_id
  → chat shows: {title} (variant) added · your cart (line items + subtotal) · [Proceed to checkout](/cart)
```

### 2D try-on
```
"Try On" → upload photo → POST /api/tryon/2d → p-image-edit (Blob upload)
  → saved to storage/tryon-results/2d/ → shown in chat + "View in 3D" button
```
LLM path: `tryon_2d` tool with `placement` confirmed first.

### 3D try-on
```
"View in 3D" (confirm) / LLM tryon_3d → POST /api/tryon/3d
  → trellis → GLB + MP4 saved → /tryon/viewer?glb=... → new tab + link in chat
```

### Login (Layer 2)
```
Customer asks for order/discount/etc → customer tool → no token → auth_required (with auth_url)
  → chat shows "Log in to continue" button → OAuth popup → token stored → resume
```

### Human CS / callback (Layer 3)
```
Return/refund/cancel/modify/warranty/"talk to human"
  → request_after_sale_assistance / escalate_to_human → SupportTicket → "Connecting you to a human…"
Company contact or "real person" request
  → LLM OFFERS callback ("Would you like us to call you back?") → if yes → schedule_callback
  → chat shows the callback form → POST /api/tryon/callback → SupportTicket (type callback)
```

---

## 7. SSE event reference

| Event | Payload | Frontend action |
|-------|---------|-----------------|
| `id` | `{conversation_id}` | Stores conversation id |
| `chunk` | `{chunk}` | Appends text to current assistant message |
| `message_complete` | — | Finalizes the message |
| `end_turn` | — | Ends the turn |
| `product_results` | `{products[]}` | Renders product cards |
| `tryon_2d_result` | `{image_url, product_title}` | Shows the 2D try-on image + View in 3D button |
| `tryon_3d_result` | `{viewer_url, glb_url}` | Opens viewer + shows link in chat |
| `cart_updated` | `{message, checkout_url}` | Cart message + checkout link |
| `human_support` | `{message, ticket_id}` | Handoff message |
| `callback_form` | `{message}` | Renders the callback form |
| `auth_required` | `{auth_url}` | "Log in to continue" button |
| `tool_use` | `{tool_use_message}` | "working…" bubble |
| `error` / `rate_limit_exceeded` | `{error}` | Error message |

---

## 8. Config / environment (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | — | DeepSeek chat LLM |
| `REPLICATE_API_TOKEN` | — | Replicate 2D + 3D models |
| `LLM_PROVIDER` | `deepseek` | LLM provider selector |
| `IMAGE_EDIT_PROVIDER` | `replicate-p-image-edit` | 2D provider selector |
| `IMAGE_TO_3D_PROVIDER` | `replicate-trellis` | 3D provider selector |
| `REPLICATE_IMAGE_EDIT_MODEL` | `prunaai/p-image-edit` | 2D model slug |
| `REPLICATE_IMAGE_TO_3D_MODEL` | `firtoz/trellis:...` | 3D model slug (pinned) |
| `TRYON_RESULTS_DIR` | `storage/tryon-results` | Local output folder (gitignored) |
| `APP_URL` | `https://localhost:3458` | Public backend base for absolute URLs (must be HTTPS) |

---

## 9. Notes / known behaviors

- **Real cart:** the card's Add to Cart uses Shopify's Ajax Cart API (`/cart/add.js`) directly — it works with the customer's real cart. Custom `add_to_cart`/`get_cart_summary` tools are wrappers until the Storefront API is wired (Phase D).
- **Cart persistence in chat:** product cards are saved as `role:'product'` messages so they reappear on page navigation. A transient history-fetch error does **not** clear the conversation ID anymore.
- **Variant picker:** derived from the product's variants; shown only when a real choice exists (option with >1 value).
- **3D output:** only `.glb` + `.mp4` are saved (no gaussian ply, no JSON sidecars).
- **Callback:** triggered via `schedule_callback` → a fixed-question form; the LLM offers it proactively for contact/real-person requests (never auto-opens the form).
- **24h retention:** `cleanup.server.js` deletes old conversations + files.
- **No MediaPipe.** 2D is fully server-side via Replicate.
- **Swapping models:** change the provider factory in `app/services/providers/index.js` + the `*_PROVIDER` env; chat/route code is unchanged.
