import { Buffer } from "node:buffer";
import AppConfig from "../../config.server";
import {
  getReplicateClient,
  materializeReplicateFile,
  downloadToBuffer,
  toReplicateFile,
} from "../replicate.server";
import { saveTryonResult } from "../storage.server";

/**
 * Placement-aware default prompts for 2D try-on.
 */
const PLACEMENT_PROMPTS = {
  holding:
    "Extract ONLY the single product from the second image, ignoring the background, any model, mannequin, or other objects in that image. Show the person in the first image holding that product naturally in their hands, as if they are holding it. Keep the person's identity, face, pose, and background unchanged. Realistic lighting and shadows.",
  wearing:
    "Extract ONLY the garment/clothing shown in the second image — ignore and remove the background, any model/mannequin wearing it, and any other objects in that image. Dress the person in the first image with that single garment, placing it on the matching body part of the person (e.g. a top/torso on the upper body, pants on the legs, shoes on the feet) and following the person's natural pose. Do NOT add any extra clothing, accessories, or items that are not in the second image. Keep the person's face, body shape, pose, and background unchanged. Fit the garment to the person naturally and realistically; do not alter the garment itself. Realistic fabric fit, draping, and lighting.",
  pairing:
    "Complete the outfit in the first image by ADDING the product from the second image. The first image is an edited photo of a person who is already wearing another item — KEEP every existing clothing, accessory, and item already present in the first image exactly as it is. Do NOT remove, replace, cover, or alter anything already worn. Extract ONLY the product from the second image (ignore its background, model, or mannequin) and add it naturally alongside the existing items (e.g. add a top to existing pants, layer a jacket over an existing outfit, or add a bag/shoes to an existing look). Place it on the appropriate body part of the person. Keep the person's face, pose, and background unchanged. Realistic fabric fit, lighting, and shadows.",
  next_to:
    "Extract ONLY the product from the second image (ignore its background, model, or mannequin) and place it next to the person in the first image, standing beside them. Keep the person's identity, pose, and background unchanged. Realistic lighting and shadows.",
};

const FALLBACK_PROMPT =
  "Extract ONLY the garment or product from the second image — ignore and remove the background, any model/mannequin, and any other objects in that image. Combine it with the person from the first image in a natural, realistic way, placing the garment on the matching body part of the person. Keep the person's identity, face, pose, and background unchanged. Realistic lighting, shadows, and scale.";

/**
 * 2D virtual try-on via Replicate prunaai/p-image-edit (swappable).
 *
 * Contract:
 *   editImage({ personImage, productImage, prompt?, placement?, options? })
 *   → { imageUrl, localPath, id, provider, raw }
 */
export function createPImageEditAdapter() {
  const model = AppConfig.replicate.imageEditModel;

  const editImage = async ({
    personImage,
    productImage,
    prompt,
    placement,
    options = {},
  }) => {
    if (!personImage) throw new Error("personImage is required for 2D try-on");
    if (!productImage) throw new Error("productImage is required for 2D try-on");

    const replicate = getReplicateClient();

    const defaultPrompt =
      prompt ||
      PLACEMENT_PROMPTS[placement] ||
      PLACEMENT_PROMPTS.wearing ||
      FALLBACK_PROMPT;

    // Replicate cannot fetch data: URLs — convert to Blobs so the SDK uploads them.
    const personInput = toReplicateFile(personImage);
    const productInput = toReplicateFile(productImage);

    // Try multiple likely input schemas in order. Schema-validation failures
    // are cheap/free (the model does not run), so retrying is safe.
    const schemaAttempts = [
      {
        images: [personInput, productInput],
        prompt: defaultPrompt,
        aspect_ratio: options.aspect_ratio || "match_input_image",
      },
      {
        images: [personInput, productInput],
        prompt: defaultPrompt,
      },
      {
        image: personInput,
        image_2: productInput,
        prompt: defaultPrompt,
      },
      {
        image: personInput,
        reference_image: productInput,
        prompt: defaultPrompt,
      },
    ];

    let output = null;
    let lastError = null;

    for (const input of schemaAttempts) {
      try {
        console.log(`[ImageEdit] Trying schema [${Object.keys(input).join(", ")}]`);
        output = await replicate.run(model, { input });
        console.log(`[ImageEdit] Success with schema [${Object.keys(input).join(", ")}]`);
        console.log(`[ImageEdit] Raw output: ${summarizeOutput(output)}`);
        break;
      } catch (err) {
        lastError = err;
        console.warn(
          `[ImageEdit] Schema [${Object.keys(input).join(", ")}] failed: ${err.message}`
        );
      }
    }

    if (!output) {
      const detail = lastError?.detail || lastError?.data || lastError?.response;
      throw new Error(
        `2D try-on model (${model}) rejected all input schemas. Last error: ${lastError?.message || "unknown"}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`
      );
    }

    const fileValue = pickImageOutput(output);
    const materialized = await materializeReplicateFile(fileValue);
    const buffer = await downloadToBuffer(materialized);

    if (!buffer) {
      throw new Error(
        `2D try-on model returned no image data. Output: ${summarizeOutput(output)}`
      );
    }

    const saved = await saveTryonResult("2d", buffer, "jpg", {
      provider: "replicate-p-image-edit",
      model,
      placement: placement || "wearing",
      prompt: defaultPrompt,
      personImage: typeof personImage === "string" ? personImage.slice(0, 200) : "[upload]",
      productImage: typeof productImage === "string" ? productImage : "[upload]",
      replicateOutputSummary: summarizeOutput(output),
    });

    return {
      id: saved.id,
      imageUrl: saved.publicUrl,
      localPath: saved.absolutePath,
      relativePath: saved.relativePath,
      fileName: saved.fileName,
      artifact: "image",
      provider: "replicate-p-image-edit",
      model,
      raw: output,
    };
  };

  return {
    name: "replicate-p-image-edit",
    editImage,
  };
}

/**
 * Recursively find the first image/file value in the model output.
 * Handles strings, URL objects, Buffers, Blobs/FileOutput (has .url()/.blob()/etc),
 * arrays, and nested objects with common keys.
 */
function pickImageOutput(output) {
  return findImageValue(output, 0);
}

/**
 * Heuristic: does this value look like an image/file output (URL, buffer,
 * Blob, FileOutput, etc.)?
 */
function isFileLike(v) {
  if (v instanceof URL) return true;
  if (Buffer.isBuffer(v)) return true;
  if (v instanceof Uint8Array) return true;
  if (v instanceof Blob || v instanceof File) return true;
  if (typeof v === "string") {
    return /^(https?:\/\/|data:image\/|blob:)/i.test(v) ||
      /\.(jpe?g|png|webp|gif|bmp|glb|mp4)(\?|$)/i.test(v);
  }
  if (typeof v === "object" && v) {
    return (
      typeof v.url === "function" ||
      typeof v.arrayBuffer === "function" ||
      typeof v.blob === "function" ||
      typeof v.href === "string" ||
      (v.url && typeof v.url === "string")
    );
  }
  return false;
}

/**
 * Depth-limited recursive search for the first file-like value in the model
 * output, checking priority keys before falling back to a full scan.
 */
function findImageValue(value, depth) {
  if (depth > 6 || value == null) return null;
  if (isFileLike(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const priorityKeys = [
      "image", "images", "output", "outputs", "result", "results",
      "url", "urls", "data", "file", "files", "model_file", "output_url",
    ];
    for (const key of priorityKeys) {
      if (value[key] != null) {
        const found = findImageValue(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const v of Object.values(value)) {
      const found = findImageValue(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Compact, log-safe summary of the raw model output.
 */
function summarizeOutput(output) {
  if (!output) return null;
  if (typeof output === "string") return output.slice(0, 300);
  if (Array.isArray(output)) return `array(len=${output.length})`;
  if (typeof output === "object") {
    try {
      return JSON.stringify(output).slice(0, 300);
    } catch {
      return Object.keys(output).join(",");
    }
  }
  return String(output).slice(0, 100);
}

export default { createPImageEditAdapter };
