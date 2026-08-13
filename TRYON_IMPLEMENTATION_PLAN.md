# Virtual Try-On Implementation Plan

**Status:** Not started  
**Last updated:** 2025-08-10  
**Assumptions:** Solo developer + AI assist, demo-grade output (not photoreal AI VTON)

---

## Summary

| Phase | Calendar (focused days) | Hours (solo + AI) | Confidence |
|-------|-------------------------|-------------------|------------|
| Phase 1 — 3D MVP + chat link | 4–6 days | 28–40 h | High |
| Phase 2 — 2D photo + live camera | 5–8 days | 36–52 h | Medium |
| Phase 3 — polish / prod / optional VTON | 3–5 days | 20–32 h | Medium |
| **Total (all 3)** | **12–19 days** | **84–124 h** | — |

**Buffer:** +20–30% for Shopify tunnel/CORS, mobile Safari camera quirks, and product image edge cases.

**Part-time (e.g. ~3 h/day):**  
Phase 1 ≈ 2–3 weeks &nbsp;|&nbsp; Phase 2 ≈ 2.5–4 weeks &nbsp;|&nbsp; Phase 3 ≈ 1.5–2.5 weeks

---

## Feature list

| Mode | Summary | Phase |
|------|---------|-------|
| 3D viewer | Procedural mannequin (M/F), face photo, snowboard + demo garments, 360° orbit | 1 |
| 2D photo tryout | Upload photo, MediaPipe pose detection, warped garment overlay on body | 2 |
| Live camera tryout | Real-time camera mirror, front/back camera, continuous pose + overlay | 2 |

---

## Architecture

```
Chat bubble (existing SSE)
  │
  ├── product_results  →  product cards (image, title, price, Add to Cart)
  └── tryon_link       →  "Try it on" button
         │
         ▼
/tryon?ids=9096566079665,...&gender=male&mode=3d
  (React Router route served on same app tunnel host, CORS-friendly)
         │
         ├── Tab: 3D    → Three.js scene + procedural models + face texture
         ├── Tab: Photo → MediaPipe + Canvas 2D warp overlay
         └── Tab: Live  → getUserMedia + real-time MediaPipe overlay
```

### Technology stack

| Component | Library | How to get it | Phase |
|-----------|---------|--------------|-------|
| 3D rendering | Three.js (WebGL) | `npm install three` | 1 |
| 360° controls | OrbitControls | Bundled with Three.js examples | 1 |
| 3D human model | Procedural (CylinderGeometry + SphereGeometry) | No external files | 1 |
| 3D snowboard | Procedural (ExtrudeGeometry) | No external files | 1 |
| 2D body pose detection | MediaPipe Tasks Vision (Pose Landmarker) | CDN or npm | 2 |
| Person segmentation | MediaPipe Selfie Segmentation | CDN or npm | 2 |
| Live camera | `navigator.mediaDevices.getUserMedia()` | Browser built-in | 2 |
| Image warping | Canvas 2D `drawImage()` with transforms | Browser built-in | 2 |
| Face texture on head | `THREE.TextureLoader` + standard image upload | Browser built-in | 1 |

**0 external APIs. 0 paid services.** Everything is browser-native or open-source CDN.

---

## File map

### New files

| Path | Role | Phase |
|------|------|-------|
| `app/routes/tryon.jsx` | Tryout page route: loader + UI shell + mode tabs | 1 |
| `app/routes/api.tryon.products.jsx` | (Optional) Resolve product IDs → title/price/image | 1 |
| `app/services/tryon-builder.server.js` | Build absolute tryon URL from product IDs + gender | 1 |
| `app/tryon/viewer-3d.client.js` | Three.js scene: mannequin, face, snowboard, demo garments | 1 |
| `app/tryon/demo-assets.js` | Demo T-shirt + trousers textures/metadata (not real shop products) | 1 |
| `app/tryon/tryon.css` | Viewer styles: fullscreen canvas, tabs, upload button | 1 |
| `app/tryon/viewer-2d.client.js` | Photo upload + MediaPipe pose + canvas warp overlay | 2 |
| `app/tryon/viewer-live.client.js` | Camera + real-time MediaPipe + overlay loop | 2 |

### Edited files

| Path | Change | Phase |
|------|--------|-------|
| `app/routes/chat.jsx` | After `product_results`, emit `tryon_link` SSE event with product IDs | 1 |
| `extensions/chat-bubble/assets/chat.js` | Handle `tryon_link` SSE event → render "Try it on" button; fix hardcoded host | 1 |
| `extensions/chat-bubble/assets/chat.css` | Style for tryon link button | 1 |
| `app/prompts/prompts.json` | Add instruction: offer 3D try-on after product recommendations | 1 |
| `package.json` | Add `three` dependency | 1 |
| `app/services/config.server.js` | Add tryon config (app host URL base) | 1 |

### Dependencies not in package.json yet

| Package | Phase | Notes |
|---------|-------|-------|
| `three` | 1 | 3D rendering engine |
| MediaPipe Tasks Vision | 2 | Can use CDN `<script>` tag, no npm required |

---

## Phase 1 — 3D MVP + chat entry (28–40 h)

**Goal:** Customer gets product cards → clicks "Try it on" → 3D mannequin (M/F), face upload, snowboard from real product, demo T-shirt/trousers, 360° view.

### Work packages

| # | Task | Hours | Deliverable |
|---|------|------:|-------------|
| 1.1 | Route + shell (`app/routes/tryon.jsx`), query params (`ids`, `gender`, `mode`) | 3–4 | Page loads on app host |
| 1.2 | Product resolve (GID → title/price/image); CORS compatible with `/chat` | 3–5 | Reliable product payload |
| 1.3 | `tryon-builder.server.js` + `tryon_link` SSE event in `chat.jsx` | 2–3 | Backend emits tryon URL |
| 1.4 | Chat UI: handle `tryon_link`, button, styles; fix hardcoded host | 3–4 | Working CTA from chat bubble |
| 1.5 | Three.js scene: camera, lights, OrbitControls, ground plane | 3–4 | 360° empty scene renders |
| 1.6 | Procedural male/female mannequin + gender toggle | 4–6 | M/F body switch |
| 1.7 | Face upload → head texture (FileReader → TextureLoader → sphere material) | 2–3 | Selfie on head |
| 1.8 | Snowboard from product image + demo T-shirt/trousers (labeled "Demo") | 5–7 | Wearables on body |
| 1.9 | Prompt tweak + end-to-end test on dev shop | 3–4 | Happy path works |

### Phase 1 exit criteria

- [ ] Link from chat opens tryon with selected product ID(s)
- [ ] Male/female toggle switches body geometry
- [ ] Face photo maps to head mesh
- [ ] Real snowboard product textured on 3D board
- [ ] Demo T-shirt + trousers clearly marked "Demo garment"
- [ ] Drag/zoom 360° works on desktop; basic mobile usable
- [ ] Load time < 5s on desktop

### Phase 1 risks

| Risk | Mitigation |
|------|------------|
| Product GID in URLs | Use numeric IDs extracted from GID; encode properly |
| Tryon page on tunnel host | Reuse same app host pattern as `/chat` |
| Three.js bundle size | Client-only load with Vite chunking; lazy import |
| Snowboard texture from product image | Use same `image_url` extraction chain from `tool.server.js` |

---

## Phase 2 — 2D photo + live camera (36–52 h)

**Goal:** Same tryon page, tabs for Photo and Live modes; pose-based clothing overlay (AR overlay demo, not fabric simulation).

### Work packages

| # | Task | Hours | Deliverable |
|---|------|------:|-------------|
| 2.1 | Shared MediaPipe pose helper (load model, get landmarks) | 4–6 | Reusable pose detection module |
| 2.2 | Photo upload UI + canvas rendering pipeline | 3–4 | Photo displayed on canvas |
| 2.3 | 2D warp/overlay: garment images onto detected torso/legs | 8–12 | Paper-doll tryout result |
| 2.4 | Live: `getUserMedia`, front/back camera toggle, permission UX | 4–6 | Camera stream visible |
| 2.5 | Live: real-time pose + overlay loop (target 15–30 fps) | 8–12 | Mirror-like overlay display |
| 2.6 | Screenshot/save frame as image | 2–3 | Export button |
| 2.7 | Mobile Safari / HTTPS / orientation testing | 4–6 | Works on phone |
| 2.8 | Tab UX polish + loading/error states | 3–4 | Stable multi-mode UI |

### Important note on 2D/Live quality

These modes use **pose-based image overlay** — the garment image is warped (skew/perspective/scale) and drawn over the detected body region on each frame. This is **not** fabric simulation, cloth physics, or AI garment swapping.

A true photorealistic virtual try-on (VTON) requires deep learning models (e.g. VITON-HD, DCI-VTON) running on GPU — this would be a separate ML service and is out of scope for this plan.

### Phase 2 exit criteria

- [ ] Photo tryout: upload photo → clothing overlay on detected body region
- [ ] Live tryout: front/back camera, continuous overlay at usable FPS
- [ ] Clear UX copy: "Demo AR overlay — not photoreal garment simulation"
- [ ] Works on at least one desktop browser + one mobile browser over HTTPS/tunnel

### Phase 2 risks

| Risk | Mitigation |
|------|------------|
| MediaPipe load time (>3s) | Show loading state; warm up model early |
| Pose accuracy on partial body | Fallback: if landmarks missing, show static overlay at center |
| Camera permission denied | Graceful message + fallback to Photo mode |
| CPU heat on mobile | Lower overlay FPS (15fps); reduce canvas resolution |
| Mobile Safari `getUserMedia` quirks | Test on iOS early; check `playsinline` and `facingMode` |

---

## Phase 3 — polish / production / optional (20–32 h)

### Work packages

| # | Task | Hours | Deliverable |
|---|------|------:|-------------|
| 3.1 | Env-based app URL (remove hardcoded `https://localhost:3458` in `chat.js`) | 2–4 | Production-safe URLs |
| 3.2 | Loading skeletons, empty states, better error handling | 3–4 | Polished UX |
| 3.3 | Performance: lazy load Three/MediaPipe, code-split per mode tab | 4–6 | Acceptable load time |
| 3.4 | Analytics/logging for tryon opens and mode selection | 2–3 | Usage tracking |
| 3.5 | Optional: external VTON API spike (if photorealism required later) | 8–16 | Decision doc |

### Phase 3 exit criteria

- [ ] App uses environment-based URL, no localhost hardcoding
- [ ] Tryon page loads in acceptable time (code-split)
- [ ] Documented limits and known issues
- [ ] Optional: VTON API evaluation completed with recommendation

---

## Suggested calendar (solo + AI, focused)

```
Week 1     Phase 1.1–1.6  (route, product resolve, chat link, Three scene, mannequin)
Week 2     Phase 1.7–1.9  (face upload, snowboard + garments, E2E test)
             → PHASE 1 DONE
Week 2–3   Phase 2.1–2.3  (MediaPipe shared module + photo tryout)
Week 3–4   Phase 2.4–2.8  (live camera + mobile testing + polish)
             → PHASE 2 DONE
Week 4–5   Phase 3        (production polish, URL fix, perf, optional VTON spike)
             → PHASE 3 DONE
```

---

## Success metrics (lightweight)

| Phase | Metric | Target |
|-------|--------|--------|
| 1 | Tryon open rate from chat | > 20% of product card impressions |
| 1 | 3D scene load time (desktop) | < 5s |
| 2 | Photo tryout success rate | > 80% (upload → overlay rendered) |
| 2 | Live session without crash | > 10s continuous |
| 3 | No localhost hardcoding in production | 100% env-based URLs |
| 3 | Lighthouse performance (tunnel) | Acceptable TTI |

---

## Out of scope (unless Phase 3 VTON)

- Photoreal garment swap / AI clothing generation
- Physics-based cloth simulation
- Full body scan / size recommendation
- Native mobile apps (iOS/Android)
- Multiplayer / shared tryon sessions
- Order placement from within tryon viewer
