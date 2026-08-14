# WORKFLOW — Shop AI Chatbot

**App:** Shopify AI chat assistant with 2D / 3D virtual try-on
**Models involved:**
| Role | Provider | What it does |
|------|----------|--------------|
| LLM (chat brain) | DeepSeek (`deepseek-v4-flash`) | Understands user text, decides which tool to call |
| 2D image edit (try-on) | Replicate `prunaai/p-image-edit` | Composes a store product with a person photo |
| Image → 3D | Replicate `firtoz/trellis` | Generates a GLB 3D model from an image |

**Stack:** React Router (Vite SSR) backend + Shopify theme extension (vanilla JS) storefront. Chat uses Server-Sent Events (SSE) streaming.

---

## 1. Architecture

```
Storefront chat bubble (extensions/chat-bubble/assets/chat.js)
   │  SSE stream: id / chunk / message_complete / product_results /
   │              tryon_2d_result / tryon_3d_result / tool_use / end_turn
   ▼
/chat  (app/routes/chat.jsx)  ──  Tool loop  ──┐
   │                                            │ DeepSeek decides tool_calls
   │  search_catalog ──► MCP client            │ (connect to shopify MCP servers)
   │                     └─► product cards in chat
   │
   │  tryon_2d ──► tryon.server ──► p-image-edit adapter ──► Replicate
   │                     └─► saves image to storage/tryon-results/2d/
   │
   └─ tryon_3d ──► tryon.server ──► trellis adapter ──► Replicate
                          └─► saves GLB/mp4/ply to storage/tryon-results/3d/
   │
   ▼
HTTP APIs (also call the same tryon.server functions):
   POST /api/tryon/2d                 → 2D try-on result
   POST /api/tryon/3d                 → 3D GLB + viewer URL
   GET  /api/tryon/results/{2d|3d}/<file>  → serves saved files
   GET  /tryon/viewer?glb=...         → Three.js 360° GLB viewer
   GET  /api/image-proxy?url=...      → CORS-safe image proxy
```

---

## 2. File map

### Backend routes (`app/routes/`)

| File | Job |
|------|-----|
| `chat.jsx` | Main chat SSE endpoint + DeepSeek tool-calling loop |
| `api.tryon.2d.jsx` | HTTP endpoint for 2D try-on (multipart photo upload or JSON URLs) |
| `api.tryon.3d.jsx` | HTTP endpoint for 3D generation (image URL → GLB + viewer URL) |
| `api.tryon.results.$.jsx` | Serves locally saved 2D/3D result files |
| `tryon.viewer.jsx` | HTML page with Three.js + OrbitControls to view a GLB in 360° |
| `api.image-proxy.jsx` | Proxies product images so the browser canvas stays untainted |

### Services (`app/services/`)

| File | Job |
|------|-----|
| `deepseek.server.js` | DeepSeek client + `getCompletion` (OpenAI-style tool calling) |
| `tryon.server.js` | High-level try-on orchestration shared by routes + LLM tools |
| `tool.server.js` | Processes MCP product-search results into display cards |
| `streaming.server.js` | SSE stream manager |
| `config.server.js` | All env-driven app configuration |

### Providers (`app/services/providers/`)

| File | Job |
|------|-----|
| `replicate.server.js` | Shared Replicate SDK client + file upload/download helpers |
| `storage.server.js` | Saves/loads try-on results on disk with JSON metadata |
| `imageEdit/replicate-p-image-edit.adapter.js` | 2D try-on adapter (swappable) |
| `imageTo3d/replicate-trellis.adapter.js` | Image→3D adapter (swappable) |
| `index.js` | Provider factories + OpenAI tool definitions for try-on |

### Frontend (`extensions/chat-bubble/`)

| File | Job |
|------|-----|
| `assets/chat.js` | All storefront chat logic (UI, messages, SSE, product cards, try-on) |
| `assets/chat.css` | Chat + try-on styling |
| `blocks/chat-interface.liquid` | Chat widget template |

### Other

| File | Job |
|------|-----|
| `app/mcp-client.js` | MCPClient: connects to Shopify MCP servers, calls catalog tools |
| `app/prompts/prompts.json` | System prompts incl. try-on/placement instructions |
| `app/db.server.js` | Prisma DB access (messages, tokens, customer URLs) |

---

## 3. File & function explanations

### `app/routes/chat.jsx`

| Function | Job |
|----------|-----|
| `loader` | GET handler: OPTIONS preflight, `?history=true` history fetch, or SSE chat |
| `action` | POST handler → `handleChatRequest` |
| `handleHistoryRequest` | Returns a conversation's message history as JSON |
| `handleChatRequest` | Parses `{message, conversation_id, prompt_type}`, opens an SSE stream |
| `handleChatSession` | The core orchestration: loads history, registers tools, runs the tool loop |
| `buildConversationHistory` | Rebuilds OpenAI-format messages from DB rows (incl. `tool_calls` and `tool` results) |
| `getCustomerAccountUrls` | Fetches/caches the shop's customer-account MCP endpoint |
| `getCorsHeaders` / `getSseHeaders` | CORS / SSE response headers |

**Tool loop (inside `handleChatSession`):** up to `MAX_TOOL_LOOP_ITERATIONS` (5) rounds:
1. Call `deepseekService.getCompletion(messages, tools)`.
2. If **no** `tool_calls` → stream the text as `chunk`, send `message_complete`, stop.
3. If **yes** → for each tool call:
   - `tryon_2d` / `tryon_3d` → `handleTryonToolCall(...)` → emit `tryon_2d_result` / `tryon_3d_result` SSE.
   - anything else → `mcpClient.callTool(...)` (e.g. `search_catalog`) and process via tool service.
4. Add assistant + tool results to history, save to DB, repeat.

### `app/services/deepseek.server.js`

| Function | Job |
|----------|-----|
| `getSystemPrompt` | Picks the system prompt by `promptType` |
| `buildApiPayload` | Adds `tools`/`tool_choice` (thinking disabled when tools are present) |
| `getCompletion` | One DeepSeek chat completion; returns message with optional `tool_calls` |
| `streamConversation` | Convenience wrapper (text + full-message callbacks) |
| `createDeepseekService` | Factory returning the service object |

### `app/services/providers/index.js`

| Function | Job |
|----------|-----|
| `createLlmProvider` | Factory for the LLM (currently DeepSeek; swap via `LLM_PROVIDER`) |
| `createImageEditProvider` | Factory for the 2D model (currently p-image-edit) |
| `createImageTo3dProvider` | Factory for the 3D model (currently trellis) |
| `getTryonOpenAiTools` | Returns `tryon_2d` / `tryon_3d` OpenAI function definitions for the LLM |

### `app/services/providers/replicate.server.js`

| Function | Job |
|----------|-----|
| `getReplicateClient` | Lazy singleton Replicate client from `REPLICATE_API_TOKEN` |
| `materializeReplicateFile` | Normalizes Replicate file-like outputs (URL, Buffer, Blob, FileOutput) into `{url, buffer}` |
| `downloadToBuffer` | Downloads a URL (or returns a buffer) into a `Buffer` |
| `toReplicateFile` | Converts `data:` URLs / Buffers into a `Blob` so the Replicate SDK auto-uploads them (Replicate can't fetch `data:` URLs) |

### `app/services/providers/storage.server.js`

| Function | Job |
|----------|-----|
| `saveTryonResult(kind, buffer, ext, meta)` | Writes file to `storage/tryon-results/{2d|3d}/`, writes a `.json` sidecar, returns `{id, publicUrl, absolutePath, ...}` |
| `resolveTryonResultFile(kind, filename)` | Safe path resolution (blocks traversal) for serving files |
| `contentTypeForFilename` | Maps extension → MIME type |

### `app/services/providers/imageEdit/replicate-p-image-edit.adapter.js`

| Function | Job |
|----------|-----|
| `editImage({personImage, productImage, prompt, placement, options})` | Runs p-image-edit: builds placement-aware prompt, tries 4 input schemas, parses output, saves image locally |
| `pickImageOutput` / `findImageValue` | Recursively finds the first image/file value in the model output |
| `summarizeOutput` | Short summary of output for logging/errors |

Placement prompts: `holding` (e.g. snowboard), `wearing` (clothing), `next_to` (beside person). The LLM confirms placement with the user before calling.

### `app/services/providers/imageTo3d/replicate-trellis.adapter.js`

| Function | Job |
|----------|-----|
| `resolveLocalImageToDataUrl` | Converts a local `/api/tryon/results/...` reference into a base64 data URL (Replicate can't reach localhost) |
| `generate3d({image, options})` | Runs trellis, saves `model_file`→`.glb`, `color_video`→`.mp4`, `gaussian_ply`→`.ply` locally |

### `app/services/tryon.server.js`

| Function | Job |
|----------|-----|
| `run2dTryon(...)` | Calls the 2D provider, builds absolute image URL |
| `run3dTryon({image})` | Calls the 3D provider, builds GLB + viewer URLs |
| `handleTryonToolCall(toolName, toolArgs)` | Bridges LLM tool calls to `run2dTryon` / `run3dTryon` |
| `isTryonTool(name)` | True for `tryon_2d` / `tryon_3d` |
| `toAbsoluteUrl(pathOrUrl)` | Prefixes relative URLs with `AppConfig.tryon.appUrl` |

### `app/services/tool.server.js`

| Function | Job |
|----------|-----|
| `handleToolSuccess` | On `search_catalog`, extracts products (dedupe) into `productsToDisplay`; records tool result |
| `handleToolError` | Records tool errors (incl. auth-required flow) |
| `processProductSearchResult` | Parses the MCP response's `products` array into display products |
| `extractProductImage` / `extractProductPrice` / `extractProductDescription` / `extractProductUrl` | Robust field extraction from varied Shopify data shapes |
| `formatProductData` | Normalizes a raw product into `{id, title, price, image_url, description, url}` |
| `addToolResultToHistory` | Appends an OpenAI `role:"tool"` message to history + DB |

### `app/mcp-client.js`

| Function | Job |
|----------|-----|
| `connectToStorefrontServer` / `connectToCustomerServer` | Discover tools from Shopify MCP endpoints |
| `callTool` / `callStorefrontTool` / `callCustomerTool` | Invoke a discovered MCP tool |
| `getOpenAiTools` | Convert MCP `input_schema` → OpenAI `function.parameters` so DeepSeek can call them |

### `app/routes/tryon.viewer.jsx`

Serves a self-contained HTML page that loads **Three.js** (via importmap/CDN), uses `OrbitControls` (drag to rotate, scroll to zoom) and `GLTFLoader` to render the GLB at `?glb=/api/tryon/results/3d/<file>.glb`.

### Frontend `extensions/chat-bubble/assets/chat.js`

| Module / function | Job |
|-------------------|-----|
| `UI.init` / `setupEventListeners` | Chat window open/close, input/send |
| `UI.displayProductResults` | Renders product cards into the chat |
| `Message.send` | Sends user text and starts SSE stream |
| `API.streamResponse` | POSTs to `/chat`, parses SSE `data:` lines |
| `API.handleStreamEvent` | Dispatches SSE events (`chunk`, `product_results`, `tryon_2d_result`, `tryon_3d_result`, `tool_use`, ...) |
| `Product.createCard` | Builds product card: image, title, price, **Add to Cart**, **Try On** |
| `TryOn.open` | Opens upload modal for a product |
| `TryOn.showUploadUI` / `closeUploadUI` | Upload modal (click/drag) |
| `TryOn.handleFile` | Validates file → `runCloud2dTryon` → show result or error |
| `TryOn.runCloud2dTryon` | POSTs photo + product URL to `/api/tryon/2d` |
| `TryOn.displayResult` | Shows 2D result + **View in 3D** button |
| `TryOn.request3dFromImage` | Confirms with user, calls `/api/tryon/3d`, opens viewer + shows link in chat |
| `TryOn.add3dLinkMessage` | Appends a clickable viewer link message to the chat |

---

## 4. End-to-end flows

### Product search (LLM path)
```
User: "show me snowboards"
  → chat.jsx tool loop → DeepSeek calls search_catalog
  → mcpClient.callTool → Shopify MCP returns products
  → tool.server formats (image, price, url)
  → SSE product_results → product cards in chat
```

### 2D try-on — button path (no LLM)
```
User clicks "Try On" on a card → upload photo
  → handleFile → POST /api/tryon/2d (multipart: person photo + product_image_url)
  → api.tryon.2d → run2dTryon → p-image-edit adapter
      (person photo → Blob → Replicate auto-uploads)
  → output parsed → saved to storage/tryon-results/2d/<id>.jpg
  → response image_url → displayed in chat + "View in 3D" button
```

### 2D try-on — LLM path
```
User pastes image link + "try this on"
  → DeepSeek calls tryon_2d { person_image_url, product_image_url, placement }
  → handleTryonToolCall → run2dTryon (same pipeline)
  → SSE tryon_2d_result → image shown in chat
```
> Before calling `tryon_2d`, the LLM asks the user where the product should go (holding / wearing / next to) and waits for confirmation.

### 3D try-on (button or LLM)
```
"View in 3D" (confirm dialog)  OR  LLM tryon_3d
  → POST /api/tryon/3d { image_url }   (prefer the 2D result URL)
  → api.tryon.3d → run3dTryon → trellis adapter
      (local 2D file → data URL → Blob → Replicate)
  → model_file saved → storage/tryon-results/3d/<id>.glb
  → viewer_url = {appUrl}/tryon/viewer?glb=/api/tryon/results/3d/<id>.glb
  → opens viewer in new tab AND shows clickable link in chat
```

---

## 5. SSE event reference

| Event | Payload | Frontend action |
|-------|---------|-----------------|
| `id` | `{conversation_id}` | Stores conversation id |
| `chunk` | `{chunk}` | Appends text to current assistant message |
| `message_complete` | — | Finalizes the message formatting |
| `end_turn` | — | Ends the turn |
| `product_results` | `{products[]}` | Renders product cards |
| `tryon_2d_result` | `{image_url, product_title}` | Shows the 2D try-on image + View in 3D button |
| `tryon_3d_result` | `{viewer_url, glb_url}` | Opens viewer + shows link in chat |
| `tool_use` | `{tool_use_message}` | Shows a "searching / running…" bubble |
| `error` / `rate_limit_exceeded` | `{error}` | Shows an error message |
| `auth_required` | — | Saves last message for auth resume |

---

## 6. Config / environment (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | — | DeepSeek chat LLM |
| `REPLICATE_API_TOKEN` | — | Replicate 2D + 3D models (required for try-on tools to appear) |
| `LLM_PROVIDER` | `deepseek` | LLM provider selector |
| `IMAGE_EDIT_PROVIDER` | `replicate-p-image-edit` | 2D provider selector |
| `IMAGE_TO_3D_PROVIDER` | `replicate-trellis` | 3D provider selector |
| `REPLICATE_IMAGE_EDIT_MODEL` | `prunaai/p-image-edit` | 2D model slug |
| `REPLICATE_IMAGE_TO_3D_MODEL` | `firtoz/trellis:...` | 3D model slug (pinned version) |
| `TRYON_RESULTS_DIR` | `storage/tryon-results` | Local output folder (gitignored) |
| `APP_URL` | `https://localhost:3458` | Public backend base used to build absolute viewer/image URLs (must be HTTPS) |

---

## 7. Notes / known behaviors

- **Uploads don't need a public URL.** Uploaded photos are converted to `Blob`s; the Replicate SDK uploads them to Replicate's file API. `data:` URLs are never handed to Replicate directly.
- **3D source image** from a previous 2D result is resolved from local storage and uploaded the same way.
- **Placement confirmation** for 2D and a **confirm dialog** for 3D exist so the user explicitly agrees before AI tokens are spent.
- **Swapping models later**: edit the provider factory in `app/services/providers/index.js`, add/update an adapter, and set the matching `*_PROVIDER` env. Chat/route code does not change because everything goes through `createXxxProvider()`.
- **No MediaPipe.** 2D is fully server-side via Replicate; the storefront only uploads + displays results.
