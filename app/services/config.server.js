// app/services/config.server.js (or wherever this lives)

export const AppConfig = {
  // API Configuration
  api: {
    // Use a valid DeepSeek model instead of Claude
    defaultModel: "deepseek-v4-flash", // or "deepseek-v4-pro"
    maxTokens: 512, // start lower; you can increase later
    defaultPromptType: "standardAssistant",
  },

  // Error Message Templates
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

  // Tool Configuration
  tools: {
    productSearchName: "search_shop_catalog",
    maxProductsToDisplay: 3,
  },
};

export default AppConfig;