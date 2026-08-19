import fs from "node:fs/promises";
import AppConfig from "../../config.server";
import {
  getReplicateClient,
  materializeReplicateFile,
  downloadToBuffer,
  toReplicateFile,
} from "../replicate.server";
import { saveTryonResult } from "../storage.server";
import {
  resolveTryonResultFile,
  contentTypeForFilename,
} from "../storage.server";

/**
 * Replicate runs in the cloud and cannot reach localhost/local files.
 * Convert any /api/tryon/results/{kind}/{file} reference into a base64 data URL.
 */
async function resolveLocalImageToDataUrl(image) {
  if (!image || typeof image !== "string") return image;

  const m = image.match(/\/api\/tryon\/results\/(2d|3d)\/([^/?#]+)/);
  if (!m) return image;

  const kind = m[1];
  const filename = m[2];
  const filePath = resolveTryonResultFile(kind, filename);
  if (!filePath) return image;

  try {
    const buf = await fs.readFile(filePath);
    const mime = contentTypeForFilename(filename);
    console.log(`[ImageTo3d] Converted local image to data URL (${kind}/${filename})`);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn("[ImageTo3d] Failed to read local source image:", err.message);
    return image;
  }
}

/**
 * Image → 3D via Replicate firtoz/trellis (swappable).
 * Matches my-replicate-app/3D_tryout_test.js input shape.
 *
 * Contract:
 *   generate3d({ image, options? })
 *   → { glbUrl, previewVideoUrl?, localGlbPath, id, provider, raw }
 */
export function createTrellisAdapter() {
  const model = AppConfig.replicate.imageTo3dModel;

  const generate3d = async ({ image, options = {} }) => {
    if (!image) throw new Error("image is required for 3D generation");

    const replicate = getReplicateClient();

    const sourceImages = Array.isArray(image) ? image : [image];
    const resolvedImages = [];
    for (const src of sourceImages) {
      const resolved = await resolveLocalImageToDataUrl(src);
      resolvedImages.push(toReplicateFile(resolved));
    }

    const input = {
      seed: options.seed ?? 0,
      images: resolvedImages,
      texture_size: options.texture_size ?? 2048,
      mesh_simplify: options.mesh_simplify ?? 0.9,
      generate_color: options.generate_color ?? true,
      generate_model: options.generate_model ?? true,
      randomize_seed: options.randomize_seed ?? true,
      generate_normal: options.generate_normal ?? false,
      save_gaussian_ply: options.save_gaussian_ply ?? false,
      ss_sampling_steps: options.ss_sampling_steps ?? 38,
      slat_sampling_steps: options.slat_sampling_steps ?? 12,
      return_no_background: options.return_no_background ?? false,
      ss_guidance_strength: options.ss_guidance_strength ?? 7.5,
      slat_guidance_strength: options.slat_guidance_strength ?? 3,
      ...options.extraInput,
    };

    console.log(`[ImageTo3d] Running ${model}`);

    const output = await replicate.run(model, { input });

    const result = {
      id: null,
      glbUrl: null,
      previewVideoUrl: null,
      localGlbPath: null,
      provider: "replicate-trellis",
      model,
      raw: output,
    };

    if (output?.model_file) {
      const mat = await materializeReplicateFile(output.model_file);
      const buf = await downloadToBuffer(mat);
      if (buf) {
        const saved = await saveTryonResult("3d", buf, "glb", {
          provider: "replicate-trellis",
          model,
          sourceImage: typeof image === "string" ? image : "[upload]",
          artifact: "model_file",
        });
        result.id = saved.id;
        result.glbUrl = saved.publicUrl;
        result.localGlbPath = saved.absolutePath;
        result.glbRelativePath = saved.relativePath;
        result.glbFileName = saved.fileName;
        result.glbArtifact = "model_file";
      }
    }

    if (output?.color_video) {
      const mat = await materializeReplicateFile(output.color_video);
      const buf = await downloadToBuffer(mat);
      if (buf) {
        const saved = await saveTryonResult("3d", buf, "mp4", {
          provider: "replicate-trellis",
          model,
          sourceImage: typeof image === "string" ? image : "[upload]",
          artifact: "color_video",
          relatedGlbId: result.id,
        });
        result.previewVideoUrl = saved.publicUrl;
        result.videoRelativePath = saved.relativePath;
        result.videoFileName = saved.fileName;
        result.videoArtifact = "color_video";
        if (!result.id) result.id = saved.id;
      }
    }

    if (!result.glbUrl && !result.previewVideoUrl) {
      throw new Error("3D model returned no model_file or color_video");
    }

    return result;
  };

  return {
    name: "replicate-trellis",
    generate3d,
  };
}

export default { createTrellisAdapter };
