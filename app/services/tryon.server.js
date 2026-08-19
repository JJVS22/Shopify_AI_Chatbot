import {
  createImageEditProvider,
  createImageTo3dProvider,
} from "./providers/index";
import AppConfig from "./config.server";
import {
  saveTryonResultRecord,
  getTryOnResultByPublicUrl,
} from "../db.server";

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
  originalProductTitle,
  conversationId,
}) {
  const provider = createImageEditProvider();

  // When pairing a second item onto an already-edited photo, build a prompt that
  // names both items and instructs natural layering so the first item is kept.
  let effectivePrompt = prompt;
  if (placement === "pairing" && originalProductTitle && productTitle) {
    effectivePrompt = buildPairingPrompt(originalProductTitle, productTitle);
  }

  const result = await provider.editImage({
    personImage,
    productImage,
    prompt: effectivePrompt,
    placement,
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
        placement: placement || null,
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
    placement: placement || null,
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
    const result = await run2dTryon({
      personImage: toolArgs.person_image_url,
      productImage: toolArgs.product_image_url,
      prompt: toolArgs.prompt,
      productTitle: toolArgs.product_title,
      placement: toolArgs.placement,
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
 * Build a pairing prompt that names both the already-worn item and the item
 * being added, and instructs the model to layer them naturally while keeping
 * the original item visible.
 */
function buildPairingPrompt(originalTitle, addedTitle) {
  return (
    `The first image shows a person who is already wearing a ${originalTitle}. ` +
    `Add the ${addedTitle} from the second image so the person is wearing BOTH items together at the same time. ` +
    `KEEP the ${originalTitle} exactly as it is — do NOT remove, replace, cover, or hide it. ` +
    `Layer them in a natural order: if the ${addedTitle} is normally worn UNDER the ${originalTitle} ` +
    `(for example a t-shirt under a vest or a shirt under a jacket), put it underneath so the ${originalTitle} stays visible on top; ` +
    `if it is normally worn OVER the ${originalTitle}, layer it on top. ` +
    `Keep the person's face, pose, and background unchanged. Realistic fabric fit, lighting, and shadows.`
  );
}

export default {
  run2dTryon,
  run3dTryon,
  handleTryonToolCall,
  isTryonTool,
};
