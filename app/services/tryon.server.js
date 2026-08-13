import {
  createImageEditProvider,
  createImageTo3dProvider,
} from "./providers/index";
import AppConfig from "./config.server";

/**
 * High-level try-on orchestration used by HTTP routes and LLM tool handlers.
 */

export async function run2dTryon({
  personImage,
  productImage,
  prompt,
  productTitle,
  placement,
}) {
  const provider = createImageEditProvider();
  const result = await provider.editImage({
    personImage,
    productImage,
    prompt,
    placement,
  });

  return {
    ...result,
    absoluteImageUrl: toAbsoluteUrl(result.imageUrl),
    productTitle: productTitle || null,
    placement: placement || null,
    message: `2D try-on complete${productTitle ? ` for ${productTitle}` : ""}.`,
  };
}

export async function run3dTryon({ image }) {
  const provider = createImageTo3dProvider();
  const result = await provider.generate3d({ image });

  return {
    ...result,
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
export async function handleTryonToolCall(toolName, toolArgs) {
  if (toolName === "tryon_2d") {
    const result = await run2dTryon({
      personImage: toolArgs.person_image_url,
      productImage: toolArgs.product_image_url,
      prompt: toolArgs.prompt,
      productTitle: toolArgs.product_title,
      placement: toolArgs.placement,
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
    });
    return {
      ok: true,
      type: "tryon_3d",
      glb_url: result.absoluteGlbUrl || result.glbUrl,
      preview_video_url: result.absolutePreviewVideoUrl || result.previewVideoUrl,
      viewer_url: result.viewerUrl,
      id: result.id,
      message: result.message,
    };
  }

  return { ok: false, error: `Unknown tryon tool: ${toolName}` };
}

export function isTryonTool(name) {
  return name === "tryon_2d" || name === "tryon_3d";
}

function toAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = AppConfig.tryon.appUrl;
  return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl}`;
}

export default {
  run2dTryon,
  run3dTryon,
  handleTryonToolCall,
  isTryonTool,
};
