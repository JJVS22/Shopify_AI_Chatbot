# Customer Service Layers — Final Implementation Plan

**Status:** Planned
**Date:** 2026-08-18
**Structure:** Layers primary + origin tag (storefront / customer / custom)

---

## 1. The 3 layers

| Layer | Access | What it means |
|-------|--------|---------------|
| **1 — No auth, fully auto** | Public store data + our AI | Answered automatically, no login needed |
| **2 — Customer auth required** | Personal/account data | Triggers the OAuth popup on demand (strategy (a)) |
| **3 — Real human CS / custom-gated** | Merchant approval / live agent | Never auto-completed; creates a SupportTicket for a human |

> `tryon_2d` / `tryon_3d` are **custom-origin** tools but require **no auth**, so they belong to **Layer 1** (there is no "layer 4").

---

## 2. Tool tables

### Layer 1 — No auth, fully auto
| Tool | Origin | Features |
|------|--------|----------|
| `search_catalog` (enhanced) | storefront | Search products; product cards now show **stock** ("In stock"/"Out of stock" from `variants[].availability`); dedupe; max N |
| `get_product_details` | storefront | Full single-product details; also resolves real product URLs |
| `search_shop_policies_and_faqs` | storefront | Store policies + FAQs (returns/shipping/terms) |
| `get_store_info` | custom (Admin API wrapper) | Shop name, domain, email, phone, address, currency, locale; cached in `ShopMeta` |
| `get_shipping_estimate` | custom | Best-effort shipping estimate from policies/FAQs |
| `get_featured_or_new_products` | custom | Curated "featured / new" listing (wraps `search_catalog`) |
| `get_product_availability` | custom | Stock status for a product/variant (or shown on cards) |
| `add_to_cart` | custom | Add product/variant + qty to **anonymous** cart; returns updated summary |
| `remove_from_cart` | custom | Remove a line item; returns updated summary |
| `get_cart_summary` | custom | Current cart: items, totals, discount status (no auth) |
| `tryon_2d` / `tryon_3d` | custom (Replicate) | Existing 2D/3D try-on |

### Layer 2 — Customer auth required (auth-on-demand)
| Tool | Origin | Features |
|------|--------|----------|
| `get_checkout_url` | custom | Returns checkout URL → rendered as a **Checkout button**; auth required here |
| `apply_discount_code` | custom | Apply/remove a discount code on the cart |
| `get_cart` / `update_cart` | customer (existing MCP) | Auth cart operations |
| `get_most_recent_order_status` | customer (existing MCP) | Status of last placed order |
| `get_order_details` | custom | Full details for a specific order (by id) |
| `get_order_history` | custom | List of past orders (wrapper; wire real API later) |
| `track_shipment` | custom | Shipping/fulfillment tracking status (wrapper; wire later) |
| `get_store_credit_balances` | customer (existing MCP) | Store-credit balance(s) |
| `get_customer_profile` | custom | **Name + email**; addresses only on demand (e.g. shipping tracking) |
| `get_wishlist` / `add_to_wishlist` | custom | Wishlist read/add (wrapper; wire later) |

### Layer 3 — Human CS / custom-gated
| Tool | Origin | Features |
|------|--------|----------|
| `request_after_sale_assistance` | custom | One combined tool — `assistance_type` ∈ {return, refund, cancel_order, modify_order, warranty}; captures order ref + summary + details → creates a `SupportTicket` → `human_support` event |
| `escalate_to_human` | custom | Hand off current chat + context → ticket (type `escalation`) + "Connecting you to a human…" |
| `create_support_ticket` | custom | Generic ticket with summary/details |
| `schedule_callback` | custom | Book date/time + contact (phone/email) → ticket (type `callback`) |

> `request_return` (Shopify MCP) is folded into `request_after_sale_assistance` and is **excluded** from auto-registration.

---

## 3. Code structure (layers primary + origin tag)

```
app/services/providers/
  mcp-client.js                     // existing — discovers Shopify storefront+customer tools (origin)
  custom/
    tools.js                        // OpenAI schemas + handler dispatch for ALL custom tools
    cart.server.js                  // add/remove/summary/checkout (L1 cart, L2 checkout) — wrappers
    store-info.server.js            // get_store_info (Admin API wrapper)
    tickets.server.js               // L3 tickets + callback + handoff
app/services/layers/
  toolLayers.js                     // { layer1:[], layer2:[], layer3:[] } + origin map (commented)
  gateTools.js                      // filters which tools the LLM sees
app/routes/
  admin.tickets.jsx                 // (Phase C) merchant view of SupportTickets
  (existing chat.jsx, api.tryon.*, auth.*, ...)
```

**Registration logic:**
```
Layer1 + Layer2  → exposed to the LLM (Layer 2 keeps auth_required → popup flow, strategy (a))
Layer3 (handoff) → exposed but only creates SupportTickets (never auto-acts)
Layer3 (request_return MCP) → EXCLUDED so the LLM cannot auto-trigger returns
```

---

## 4. SQLite schema additions

```prisma
model SupportTicket {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  type           String       // return | refund | cancel_order | modify_order | warranty | callback | escalation
  status         String       @default("open") // open | in_progress | resolved | closed
  summary        String
  details        String?      // JSON payload
  customerName   String?
  customerEmail  String?
  orderRef       String?
  callTime       DateTime?    // schedule_callback
  contactPhone   String?      // schedule_callback
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  @@index([conversationId])
  @@index([status])
}

model ShopMeta {              // cache for get_store_info
  id        String   @id      // shop domain
  name      String?
  email     String?
  phone     String?
  currency  String?
  locale    String?
  address   String?           // JSON
  updatedAt DateTime  @updatedAt
}
```

**Storage rule:** cart/orders/credit → live fetch, not stored; try-on → disk + SQLite refs; tickets + shop info → SQLite.

---

## 5. Build phases

| Phase | Scope |
|-------|-------|
| **A — Basic (in progress)** | `toolLayers` + `gateTools`; stock on product cards; anonymous cart wrappers; `get_store_info` wrapper; `SupportTicket` schema + `escalate_to_human`/`create_support_ticket` + `human_support` SSE; prompt updates |
| **B — L2 wrappers** | `get_checkout_url` → Checkout button; `apply_discount_code`; `get_customer_profile` (name/email); `get_shipping_estimate`; `get_featured_or_new_products` |
| **C — L3 full** | `request_after_sale_assistance` (combined), `schedule_callback`, merchant ticket view (`admin.tickets.jsx`) |
| **D — L2 advanced (wire later)** | `get_order_history`, `get_order_details`, `track_shipment`, `get_wishlist`/`add_to_wishlist` |

**Wrapping strategy (approved):** all custom L2/L3 tools return realistic wrapper responses and persist tickets now; the real Shopify Admin/Customer APIs are wired in Phase D / later.
