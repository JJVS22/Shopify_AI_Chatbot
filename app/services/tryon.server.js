import {
  createImageEditProvider,
  createImageTo3dProvider,
} from "./providers/index";
import AppConfig from "./config.server";
import {
  saveTryonResultRecord,
  getTryOnResultByPublicUrl,
  getLatestUploadedImage,
} from "../db.server";
import {
  resolveTryonResultFile,
  contentTypeForFilename,
} from "./providers/storage.server";

/**
 * High-level try-on orchestration used by HTTP routes and LLM tool handlers.
 */

/**
 * Run a 2D virtual try-on via the configured image-edit provider.
 * Persists a result record (when a conversationId is given) and returns an
 * enriched result with an absolute image URL and a human-readable message.
 */
export async function run2dTryon({
  personImage,
  productImage,
  prompt,
  productTitle,
  placement,
  bodyPart,
  originalProductTitle,
  conversationId,
}) {
  const provider = createImageEditProvider();

  // Server-side body-region classification of the product NAME. This is the
  // safety net that tells the image-edit model what the item actually is, even
  // when the LLM mislabels the placement or body part (e.g. a tote bag reported
  // as "wearing").
  const autoRegion = classifyBodyRegion(productTitle);

  // When pairing a second item onto an already-edited photo, build a prompt that
  // names both items and instructs natural layering so the first item is kept.
  let effectivePrompt = prompt;
  let effectivePlacement = placement;
  if (placement === "pairing" && originalProductTitle && productTitle) {
    effectivePrompt = buildPairingPrompt(originalProductTitle, productTitle);
  } else if (autoRegion === "hand_carried") {
    // Bags / backpacks / purses / sports gear are HELD or CARRIED, never worn
    // like a garment. Force "holding" even if the LLM chose "wearing" so the
    // model does not drape the bag over the torso like a vest or replace the
    // person with it.
    effectivePlacement = "holding";
    effectivePrompt = buildHoldingPrompt(productTitle, prompt, true);
  } else if (!placement || placement === "wearing") {
    // Region-aware prompt: classify the product's body part (upper body / lower
    // body / full body / head / arms / legs / foot) from its name and tell the
    // model exactly where to put it — while keeping the person fully in frame.
    effectivePrompt = buildWearingPrompt(
      productTitle,
      bodyPart || autoRegion,
      prompt
    );
  } else if (placement === "holding") {
    // LLM already chose "holding" — still name the product so the model knows
    // exactly what is being held.
    effectivePrompt = buildHoldingPrompt(productTitle, prompt, false);
  }
  // placement === "next_to" (or anything else) keeps the LLM prompt or falls
  // back to the provider's default; the product name is still injected there.

  const result = await provider.editImage({
    personImage,
    productImage,
    prompt: effectivePrompt,
    placement: effectivePlacement || placement,
    options: { productTitle },
  });

  if (conversationId && result.relativePath) {
    try {
      await saveTryonResultRecord({
        conversationId,
        type: "2d",
        artifact: result.artifact || "image",
        fileName: result.fileName,
        filePath: result.relativePath,
        publicUrl: result.publicUrl || result.imageUrl,
        productTitle: productTitle || null,
        placement: effectivePlacement || null,
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      console.error("[Tryon] Failed to record 2D result in DB:", err.message);
    }
  }

  return {
    ...result,
    absoluteImageUrl: toAbsoluteUrl(result.imageUrl),
    productTitle: productTitle || null,
    placement: effectivePlacement || null,
    message: `2D try-on complete${productTitle ? ` for ${productTitle}` : ""}.`,
  };
}

/**
 * Run image-to-3D generation via the configured provider. Persists the GLB and
 * preview video artifacts (when a conversationId is given) and links the 3D
 * result back to its 2D source when the input image is a prior try-on URL.
 */
export async function run3dTryon({ image, conversationId }) {
  const provider = createImageTo3dProvider();
  const result = await provider.generate3d({ image });

  let sourceResultId = null;
  let sourceProductTitle = null;
  if (conversationId && image && typeof image === "string") {
    try {
      const src = await getTryOnResultByPublicUrl(image);
      sourceResultId = src?.id || null;
      sourceProductTitle = src?.productTitle || null;
    } catch {
      sourceResultId = null;
      sourceProductTitle = null;
    }
  }

  const common = {
    conversationId,
    sourceResultId,
    provider: result.provider,
    model: result.model,
  };

  if (conversationId && result.glbRelativePath) {
    try {
      await saveTryonResultRecord({
        ...common,
        type: "3d",
        artifact: result.glbArtifact || "model_file",
        fileName: result.glbFileName,
        filePath: result.glbRelativePath,
        publicUrl: result.glbUrl,
      });
    } catch (err) {
      console.error("[Tryon] Failed to record GLB in DB:", err.message);
    }
  }

  if (conversationId && result.videoRelativePath) {
    try {
      await saveTryonResultRecord({
        ...common,
        type: "3d",
        artifact: result.videoArtifact || "color_video",
        fileName: result.videoFileName,
        filePath: result.videoRelativePath,
        publicUrl: result.previewVideoUrl,
      });
    } catch (err) {
      console.error("[Tryon] Failed to record preview video in DB:", err.message);
    }
  }

  return {
    ...result,
    productTitle: sourceProductTitle,
    absoluteGlbUrl: toAbsoluteUrl(result.glbUrl),
    absolutePreviewVideoUrl: toAbsoluteUrl(result.previewVideoUrl),
    viewerUrl: result.glbUrl
      ? toAbsoluteUrl(
          `/tryon/viewer?glb=${encodeURIComponent(result.glbUrl)}`
        )
      : null,
    message: "3D model generated. Open the viewer link for 360° viewing.",
  };
}

/**
 * Handle LLM tool calls for tryon_2d / tryon_3d.
 * Returns a plain object suitable as tool result content (JSON stringified by caller).
 */
export async function handleTryonToolCall(toolName, toolArgs, conversationId) {
  if (toolName === "tryon_2d") {
    // If the LLM didn't pass a person photo, fall back to the photo the customer
    // uploaded with their message (sent via the upload icon in the chat).
    let personImage = toolArgs.person_image_url;
    if (!personImage && conversationId) {
      const uploaded = await getLatestUploadedImage(conversationId);
      if (uploaded) {
        personImage = await uploadedImageToDataUrl(uploaded) || uploaded;
        console.log("[Tryon] Using customer-uploaded photo for 2D try-on");
      }
    }

    const result = await run2dTryon({
      personImage,
      productImage: toolArgs.product_image_url,
      prompt: toolArgs.prompt,
      productTitle: toolArgs.product_title,
      placement: toolArgs.placement,
      // The LLM classifies the product's body part; fall back to deriving it
      // from the product name server-side.
      bodyPart: toolArgs.body_part || null,
      conversationId,
    });
    return {
      ok: true,
      type: "tryon_2d",
      image_url: result.absoluteImageUrl || result.imageUrl,
      local_path: result.localPath,
      id: result.id,
      product_title: result.productTitle,
      placement: result.placement,
      message: result.message,
    };
  }

  if (toolName === "tryon_3d") {
    const result = await run3dTryon({
      image: toolArgs.image_url,
      conversationId,
    });
    return {
      ok: true,
      type: "tryon_3d",
      glb_url: result.absoluteGlbUrl || result.glbUrl,
      preview_video_url: result.absolutePreviewVideoUrl || result.previewVideoUrl,
      viewer_url: result.viewerUrl,
      id: result.id,
      product_title: result.productTitle || null,
      message: result.message,
    };
  }

  return { ok: false, error: `Unknown tryon tool: ${toolName}` };
}

/**
 * Returns true when the given tool name is one of the built-in try-on tools.
 */
export function isTryonTool(name) {
  return name === "tryon_2d" || name === "tryon_3d";
}

export { classifyBodyRegion };

/**
 * Convert a relative public path (e.g. /api/tryon/results/...) into an absolute
 * URL using the configured app URL; passes through existing absolute URLs.
 */
function toAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = AppConfig.tryon.appUrl;
  return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl}`;
}

/**
 * Keyword lists used to infer the correct layering order between two garments.
 */
const OUTER_LAYERS = [
  "vest", "jacket", "coat", "blazer", "cardigan", "hoodie", "sweater",
  "sweatshirt", "parka", "puffer", "windbreaker", "overcoat", "shacket",
  "blouson", "bomber", "trench",
];

const INNER_LAYERS = [
  "t-shirt", "t shirt", "tshirt", "shirt", "tee", "top", "tank",
  "undershirt", "blouse", "polo", "henley", "base layer", "baselayer",
  "camisole", "vest top",
];

/**
 * Which part of the body a product is worn on. Used to build a precise 2D
 * try-on prompt so the image-edit model places the item correctly (and does
 * not crop out the person or redesign the garment).
 */
const BODY_REGION_PHRASES = [
  { region: "foot", words: ["high top", "ankle boot", "hiking boot", "running shoe", "soccer cleat", "flip flop", "flip-flop"] },
  { region: "upper_body", words: ["short sleeve", "long sleeve", "crop top", "tank top", "t-shirt", "t shirt", "dress shirt", "polo shirt", "sleeveless top", "zip hoodie", "zip-up", "zip up", "work shirt", "waist coat", "waistcoat", "button down", "button-down", "tee shirt"] },
  { region: "lower_body", words: ["sweat pant", "sweatpant", "jean short", "jeans short", "basketball short", "gym short", "running short", "high waist", "high-waist", "high rise", "high-rise", "low rise", "low-rise"] },
  { region: "full_body", words: ["one piece", "one-piece", "track suit", "tracksuit", "swim suit", "swimwear", "ball gown", "wedding dress", "night gown", "body suit", "bodysuit", "bikini", "bekini"] },
  { region: "head", words: ["baseball cap", "sun hat", "bucket hat", "beanie", "earmuff", "fedora"] },
  { region: "legs", words: ["knee high", "knee-high", "thigh high", "thigh-high", "leg warmer", "legwarmer", "ankle sock", "crew sock", "knee sock"] },
  { region: "arms", words: ["arm warmer", "armwarmer", "wrist band", "wristband", "elbow pad", "arm sleeve", "fingerless glove", "glove"] },
  { region: "hand_carried", words: ["tote bag", "hand bag", "shoulder bag", "cross body bag", "crossbody bag", "messenger bag", "duffel bag", "duffle bag", "gym bag", "laptop bag", "bum bag", "fanny pack", "waist bag", "waist pack", "belt bag", "snow skis", "ski poles", "tennis racket", "badminton racket", "baseball bat", "cricket bat", "skate board"] },
];

const BODY_REGION_WORDS = {
  head: ["hat", "cap", "beanie", "beret", "headband", "headpiece", "headdress", "crown", "bandana", "bandanna", "helmet", "visor", "sunglasses", "glasses", "goggles", "tiara", "headscarf", "hairband", "hair clip", "hairpin"],
  arms: ["gloves", "mitten", "mittens", "wristband", "armwarmer"],
  foot: ["shoes", "sneaker", "sneakers", "trainers", "trainer", "boots", "boot", "sandals", "sandal", "slippers", "slipper", "heels", "heel", "pumps", "pump", "loafers", "loafer", "mules", "mule", "clogs", "clog", "footwear", "cleats", "cleat", "yeezy"],
  legs: ["socks", "sock", "tights", "stocking", "stockings", "hose", "garter", "knee pad", "kneepad"],
  lower_body: ["pants", "pant", "trousers", "trouser", "jeans", "jean", "shorts", "short", "skirt", "leggings", "legging", "joggers", "jogger", "sweatpants", "sweatpants", "culottes", "culotte", "briefs", "brief", "boxers", "boxer", "underwear", "trunks", "trunk", "skort", "dungarees", "dungaree", "bottoms", "waist"],
  upper_body: ["shirt", "tee", "tops", "top", "tank", "blouse", "polo", "henley", "sweater", "sweatshirt", "hoodie", "jacket", "coat", "blazer", "cardigan", "vest", "parka", "puffer", "windbreaker", "jersey", "jumper", "pullover", "camisole", "kimono", "gilet", "waistcoat", "tunic", "singlet", "bra", "tuxedo", "tux", "chest", "torso", "bodice"],
  full_body: ["dress", "gown", "romper", "jumpsuit", "overall", "overalls", "coverall", "onesie", "swimsuit", "swimwear", "tracksuit", "suit", "costume", "outfit", "uniform", "playsuit"],
  hand_carried: [" bag", "tote", "handbag", "backpack", "back pack", "satchel", "purse", "clutch", "briefcase", "luggage", "suitcase", "duffel", "duffle", "carryall", "holdall", "snowboard", "surfboard", "skateboard", "crossbody", "cross-body", "skis", "racket", "racquet", "basketball", "football", "soccer ball", "volleyball", "baseball", "cricket", "skipping rope"],
};

/**
 * Classify which body region a product belongs to based on its name/type.
 * Multi-word phrases are matched first (more specific), then single words.
 * Garment regions win over `hand_carried` so words shared with clothing names
 * (e.g. "baggy jeans") are never misread as a bag.
 * @param {string} productTitle
 * @returns {string|null} one of: head, upper_body, lower_body, full_body,
 *   arms, legs, foot, hand_carried — or null when nothing matches.
 */
function classifyBodyRegion(productTitle) {
  const title = String(productTitle || "").toLowerCase();
  if (!title.trim()) return null;

  for (const { region, words } of BODY_REGION_PHRASES) {
    for (const w of words) {
      if (title.includes(w)) return region;
    }
  }
  for (const region of Object.keys(BODY_REGION_WORDS)) {
    for (const w of BODY_REGION_WORDS[region]) {
      if (title.includes(w)) {
        // "bag" should not fire on words like "baggy" / "baguette".
        if (region === "hand_carried" && w === " bag" && /baggy|baggie|baguette/.test(title)) {
          continue;
        }
        return region;
      }
    }
  }
  return null;
}

/**
 * Precise, region-aware prompts for the 2D try-on model. Each one first tells
 * the model to detect the person's body parts (head, arms, chest, waist, legs,
 * feet), then states exactly which part to dress, requires the person to stay
 * fully in frame, and requires the garment to stay exactly as shown in the
 * product image.
 */
const BODY_DETECTION =
  "STEP 1 — DETECT THE PERSON: look at image 1 (the person) and locate their body parts: head, face, shoulders, chest, waist, arms, hands, legs, knees, and feet. " +
  "STEP 2 — DETECT THE PRODUCT: look at image 2 (the product) and identify the single product/garment (ignore its background, any model/mannequin wearing it, and any other objects). ";

const KEEP_PERSON_IN_FRAME =
  "KEEP the person fully in the frame from head to toe — never crop, zoom in, cut off, remove, or replace the person; their face, identity, body shape, pose, hands, and background stay exactly unchanged. ";

const KEEP_GARMENT =
  "Keep the product's design, color, pattern, logo, and details exactly as shown in image 2 — do NOT redesign, recolor, or replace it. ";

// Tells the model to swap out whatever the person is already wearing in that
// area for the product — this is what fixes items like shorts where the model
// would otherwise leave the person in their original pants/shorts.
const REPLACE_EXISTING_UPPER =
  "REPLACE the person's current upper-body clothing (whatever shirt, t-shirt, top, jacket, sweater, hoodie, or vest they are currently wearing) with THIS product — the person must be shown wearing the new garment from image 2, not their old one. ";
const REPLACE_EXISTING_LOWER =
  "REPLACE the person's current lower-body clothing (whatever pants, trousers, jeans, shorts, skirt, or leggings they are currently wearing) with THIS product — the person must be shown wearing the new garment from image 2, NOT their old one. Even if the current clothing looks similar to the product, it must be swapped for the product. ";
const REPLACE_EXISTING_FULL =
  "REPLACE the person's current outfit with THIS product — the person must be shown wearing the new garment from image 2, NOT their old clothes. ";

const REGION_PROMPTS = {
  head:
    BODY_DETECTION +
    "The product belongs on the person's HEAD (e.g. a hat, cap, or beanie sits on TOP of the head, above the face and between the ears). " +
    "Place ONLY that product on the person's head at the correct angle, matching their natural pose. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit and lighting.",
  upper_body:
    BODY_DETECTION +
    "The product is an UPPER-BODY garment (e.g. shirt, t-shirt, jacket, sweater, hoodie). " +
    REPLACE_EXISTING_UPPER +
    "Dress the person with it so it covers the CHEST and torso, the sleeves go onto the arms, and the hem ends at the WAIST — it must NOT extend below the hips or cover the legs. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit, draping, lighting, and shadows.",
  arms:
    BODY_DETECTION +
    "The product belongs on the person's ARMS and HANDS (e.g. gloves on the hands, arm warmers on the forearms). " +
    "Place it on BOTH arms/hands correctly (left glove on the left hand, right glove on the right hand), following their pose. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit and lighting.",
  lower_body:
    BODY_DETECTION +
    "The product is a LOWER-BODY garment (e.g. pants, jeans, shorts, skirt, leggings). " +
    REPLACE_EXISTING_LOWER +
    "It must start at the WAIST and cover the hips and LEGS — it must NOT cover the chest or upper body. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit, draping, lighting, and shadows.",
  legs:
    BODY_DETECTION +
    "The product belongs on the person's LEGS below the knee (e.g. socks, tights, stockings covering the calves and ankles). " +
    "Place it on BOTH legs correctly (left sock on the left leg, right sock on the right leg), following their pose. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit and lighting.",
  foot:
    BODY_DETECTION +
    "The product is FOOTWEAR for the person's FEET (e.g. shoes, sneakers, boots, sandals). " +
    "Put the left shoe on the person's left FOOT and the right shoe on the right FOOT, aligned with the floor and their natural stance. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit, materials, lighting, and shadows.",
  full_body:
    BODY_DETECTION +
    "The product is a FULL-BODY garment (e.g. dress, gown, jumpsuit, one-piece, romper). " +
    REPLACE_EXISTING_FULL +
    "Dress the person in it so it covers the CHEST/torso and extends down over the WAIST to the LEGS as one piece. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic fit, draping, lighting, and shadows.",
  hand_carried:
    BODY_DETECTION +
    "The product is an ACCESSORY the person CARRIES or HOLDS — e.g. a bag, tote, handbag, backpack, purse, or sports equipment (like a snowboard). " +
    "It is NOT clothing: it must NEVER be worn over the chest/torso like a garment or a vest, and it must NEVER replace the person, their clothes, or their body. " +
    "Show the person in image 1 holding the product in one or both hands, or carrying it over one shoulder, following their natural pose and stance. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic scale, materials, lighting, and shadows.",
};

const GENERIC_WEARING_PROMPT =
  BODY_DETECTION +
  "Match the product to the correct body part of the person (head, arms, chest, waist, legs, or feet) based on what the product is, and place it there following their natural pose. " +
  KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
  "Realistic fit, draping, lighting, and shadows.";

/**
 * Build the prompt for a "wearing" 2D try-on, using the body region of the
 * product (classified from the product name) so the model places the item
 * accurately. A custom prompt from the LLM is appended as extra detail when
 * provided, but the region guidance always stays.
 * @param {string|null} productTitle
 * @param {string|null} bodyPart - classified region; auto-detected when null
 * @param {string|null} customPrompt - optional LLM-provided override
 * @returns {string}
 */
function buildWearingPrompt(productTitle, bodyPart, customPrompt) {
  const region = bodyPart || classifyBodyRegion(productTitle) || "generic";
  const regionPrompt = REGION_PROMPTS[region] || GENERIC_WEARING_PROMPT;
  const titleIntro = productTitle
    ? `Image 1 is a person; image 2 is the product to be worn (${productTitle}). `
    : `Image 1 is a person; image 2 is the product to be worn. `;
  const custom = customPrompt ? ` Additional instruction from the assistant: ${customPrompt}` : "";
  return titleIntro + regionPrompt + custom;
}

/**
 * Build a prompt for items that are HELD or CARRIED (bags, accessories, sports
 * gear, etc.). The product name is always included so the image-edit model
 * knows exactly what it is. When `forceCarry` is true the model is explicitly
 * told the item is NOT clothing and must never be worn on the body — this
 * prevents a tote bag being draped over the torso like a vest or replacing the
 * person entirely.
 * @param {string|null} productTitle
 * @param {string|null} customPrompt - optional LLM-provided override
 * @param {boolean} forceCarry - emphasize the item is not clothing
 * @returns {string}
 */
function buildHoldingPrompt(productTitle, customPrompt, forceCarry) {
  const intro = productTitle
    ? `Image 1 is a person; image 2 is the item to be held/carried (${productTitle}). `
    : `Image 1 is a person; image 2 is the item to be held/carried. `;
  const notClothing = forceCarry
    ? "The item in image 2 is NOT a piece of clothing — it is an accessory or object the person holds or carries (e.g. a bag, tote, handbag, backpack, or sports equipment). It must NEVER be worn over the torso, chest, or shoulders like a garment or a vest, and it must NEVER replace the person or their clothes. "
    : "";
  const custom = customPrompt ? ` Additional instruction from the assistant: ${customPrompt}` : "";
  return (
    intro +
    "Extract ONLY the item from image 2, ignoring its background, any model, mannequin, or other objects. " +
    notClothing +
    "Show the person in image 1 holding the item naturally in one or both hands, or carrying it over one shoulder, following their existing pose and stance. " +
    KEEP_PERSON_IN_FRAME + KEEP_GARMENT +
    "Realistic scale, materials, lighting, and shadows." +
    custom
  );
}

/**
 * Decide whether the added item goes under or over the original item.
 * Returns "under", "over", or "alongside" (different body regions).
 */
function inferLayerOrder(originalTitle, addedTitle) {
  const original = (originalTitle || "").toLowerCase();
  const added = (addedTitle || "").toLowerCase();
  const oOuter = OUTER_LAYERS.some((k) => original.includes(k));
  const oInner = INNER_LAYERS.some((k) => original.includes(k));
  const aOuter = OUTER_LAYERS.some((k) => added.includes(k));
  const aInner = INNER_LAYERS.some((k) => added.includes(k));

  if (oOuter && aInner) return "under"; // e.g. vest + t-shirt
  if (oInner && aOuter) return "over";  // e.g. t-shirt + jacket
  return "alongside"; // e.g. pants + shirt (different regions)
}

/**
 * Build a pairing prompt that names both the already-worn item and the item
 * being added, and instructs the model to keep the original item while layering
 * the new one in the correct order.
 */
function buildPairingPrompt(originalTitle, addedTitle) {
  const order = inferLayerOrder(originalTitle, addedTitle);

  const base =
    `Image 1 is a person who is already wearing a ${originalTitle}. ` +
    `Now add the ${addedTitle} from image 2 so the person is wearing BOTH items together at the same time. ` +
    `KEEP the ${originalTitle} exactly as it is — do NOT remove, replace, cover, or hide it. ` +
    `Keep the person's face, pose, and background unchanged. Realistic fabric fit, lighting, and shadows.`;

  // When the added item is a bag / accessory / handheld object, don't try to
  // layer it like a garment — tell the model to hold or carry it instead.
  if (classifyBodyRegion(addedTitle) === "hand_carried") {
    return (
      base +
      ` The ${addedTitle} is an accessory/object, NOT clothing — do NOT wear it over the body. ` +
      `Show the person holding or carrying the ${addedTitle} in their hand or over one shoulder, ` +
      `next to the existing look, keeping the ${originalTitle} unchanged.`
    );
  }

  if (order === "under") {
    return (
      base +
      ` Put the ${addedTitle} UNDERNEATH the ${originalTitle} so the ${originalTitle} remains fully visible on top; ` +
      `only a small part of the ${addedTitle} (e.g. neckline, hem, or sleeves) should peek out from under the ${originalTitle}.`
    );
  }

  if (order === "over") {
    return (
      base +
      ` Layer the ${addedTitle} OVER the ${originalTitle} so the ${originalTitle} still shows underneath.`
    );
  }

  return (
    base +
    ` Add the ${addedTitle} on a different part of the body from the ${originalTitle} (they do not overlap), ` +
    `so both items are clearly visible together.`
  );
}

/**
 * Convert one of our stored uploaded images (public URL) into a base64 data URL
 * by reading the file from disk. This lets Replicate receive the image as an
 * upload instead of trying to fetch our (possibly localhost) URL.
 */
async function uploadedImageToDataUrl(publicUrl) {
  try {
    const pathname = new URL(publicUrl).pathname; // /api/tryon/results/2d/<file>
    const parts = pathname.split("/").filter(Boolean); // [api, tryon, results, 2d, file]
    const kind = parts[parts.length - 2];
    const filename = parts[parts.length - 1];
    const absolutePath = resolveTryonResultFile(kind, filename);
    if (!absolutePath) return null;
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(absolutePath);
    const mime = contentTypeForFilename(filename);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn("[Tryon] Could not convert uploaded image to data URL:", err.message);
    return null;
  }
}

export default {
  run2dTryon,
  run3dTryon,
  handleTryonToolCall,
  isTryonTool,
  classifyBodyRegion,
};
