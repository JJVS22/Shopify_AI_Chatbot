import AppConfig from "../config.server";
import { createDeepseekService } from "../deepseek.server";
import { createPImageEditAdapter } from "./imageEdit/replicate-p-image-edit.adapter";
import { createTrellisAdapter } from "./imageTo3d/replicate-trellis.adapter";

/**
 * LLM provider factory — swap via LLM_PROVIDER env.
 */
export function createLlmProvider() {
  const name = AppConfig.providers.llm;
  switch (name) {
    case "deepseek":
    default: {
      const svc = createDeepseekService();
      return {
        name: "deepseek",
        getCompletion: svc.getCompletion,
        streamConversation: svc.streamConversation,
        getSystemPrompt: svc.getSystemPrompt,
        MAX_TOOL_LOOP_ITERATIONS: svc.MAX_TOOL_LOOP_ITERATIONS,
      };
    }
  }
}

/**
 * 2D image-edit / try-on provider factory.
 * IMAGE_EDIT_PROVIDER=replicate-p-image-edit
 */
export function createImageEditProvider() {
  const name = AppConfig.providers.imageEdit;
  switch (name) {
    case "replicate-p-image-edit":
    default:
      return createPImageEditAdapter();
  }
}

/**
 * Image → 3D provider factory.
 * IMAGE_TO_3D_PROVIDER=replicate-trellis
 */
export function createImageTo3dProvider() {
  const name = AppConfig.providers.imageTo3d;
  switch (name) {
    case "replicate-trellis":
    default:
      return createTrellisAdapter();
  }
}

/**
 * OpenAI-format tool definitions for try-on so the LLM can call them.
 */
export function getTryonOpenAiTools() {
  return [
    {
      type: "function",
      function: {
        name: "tryon_2d",
        description:
          "Run a 2D virtual try-on: compose a store product with a person photo. IMPORTANT: before calling this tool, confirm the desired placement with the customer (e.g. 'holding' the product, 'wearing' it, or 'next to' them) and only call once they confirm. If the customer already uploaded a photo (via the chat's image icon), you can OMIT person_image_url — it will be used automatically. Otherwise require a public URL of the customer's photo and a product image URL from the catalog. For 'wearing', the product image is placed on the exact matching body part of the person.",
        parameters: {
          type: "object",
          properties: {
            person_image_url: {
              type: "string",
              description:
                "HTTPS URL of the customer's photo. OPTIONAL if the customer already uploaded a photo in the chat. For 'wearing', a clear photo showing the relevant body part works best (e.g. a full-body photo for pants/dresses/shoes; an upper-body photo is fine for tops).",
            },
            product_image_url: {
              type: "string",
              description: "HTTPS URL of the product image from the shop catalog.",
            },
            product_title: {
              type: "string",
              description: "Product title — used to classify the body part for accurate try-on.",
            },
            placement: {
              type: "string",
              enum: ["wearing", "holding", "next_to"],
              description:
                "Where the product should appear relative to the person. 'wearing' for clothing/accessories, 'holding' for handheld items like snowboards, 'next_to' to place it beside them.",
            },
            body_part: {
              type: "string",
              enum: ["head", "upper_body", "lower_body", "full_body", "arms", "legs", "foot"],
              description:
                "REQUIRED for 'wearing'. Classify which part of the body the product belongs to, using the product NAME as reference: shoes/sneakers/boots/sandals → foot; pants/jeans/shorts/skirt/leggings → lower_body; shirt/tee/top/jacket/sweater/hoodie/coat/vest → upper_body; dress/gown/jumpsuit/one-piece/swimsuit → full_body; hat/cap/beanie → head; gloves/mittens/arm warmers → arms; socks/tights/stockings → legs. When unsure, pick the most likely region and explain the reasoning to the customer.",
            },
            prompt: {
              type: "string",
              description:
                "Optional editing instruction override. Keep it consistent with the product's body part (e.g. for shoes: put them on the feet; for pants: wear them on the legs).",
            },
          },
          required: ["product_image_url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tryon_3d",
        description:
          "Generate a 3D model (GLB) from an image using the image-to-3D model. Prefer the image URL from a completed 2D try-on result; otherwise a product or person image URL. Confirm with the user before calling (uses AI tokens).",
        parameters: {
          type: "object",
          properties: {
            image_url: {
              type: "string",
              description: "HTTPS URL of the source image (ideally a 2D try-on result).",
            },
          },
          required: ["image_url"],
        },
      },
    },
  ];
}

export default {
  createLlmProvider,
  createImageEditProvider,
  createImageTo3dProvider,
  getTryonOpenAiTools,
};
