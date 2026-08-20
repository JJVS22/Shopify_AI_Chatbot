export const AppConfig = {
  api: {
    defaultModel: "deepseek-chat",
    maxTokens: 512,
    defaultPromptType: "standardAssistant",
  },

  errorMessages: {
    missingMessage: "Message is required",
    apiUnsupported:
      "This endpoint only supports server-sent events (SSE) requests or history requests.",
    authFailed: "Authentication failed with DeepSeek API",
    apiKeyError: "Please check your DeepSeek API key in environment variables",
    rateLimitExceeded: "DeepSeek rate limit exceeded",
    rateLimitDetails: "Please try again later",
    genericError: "Failed to get response from DeepSeek",
  },

  tools: {
    productSearchName: "search_catalog",
    maxProductsToDisplay: 12,
  },

  providers: {
    llm: process.env.LLM_PROVIDER || "deepseek",
    imageEdit: process.env.IMAGE_EDIT_PROVIDER || "replicate-p-image-edit",
    imageTo3d: process.env.IMAGE_TO_3D_PROVIDER || "replicate-trellis",
  },

  replicate: {
    imageEditModel:
      process.env.REPLICATE_IMAGE_EDIT_MODEL || "prunaai/p-image-edit",
    imageTo3dModel:
      process.env.REPLICATE_IMAGE_TO_3D_MODEL ||
      "firtoz/trellis:e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c",
  },

  tryon: {
    resultsDir: process.env.TRYON_RESULTS_DIR || "storage/tryon-results",
    publicBasePath: "/api/tryon/results",
    appUrl: (process.env.APP_URL || "https://localhost:3458").replace(/\/$/, ""),
  },
};

export default AppConfig;
