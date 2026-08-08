// app/services/deepseek.server.js
import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

// Create DeepSeek client using OpenAI SDK
const deepseekClient = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

/**
 * Gets the system prompt content for a given prompt type
 * @param {string} promptType - The prompt type to retrieve
 * @returns {string} The system prompt content
 */
const getSystemPrompt = (promptType) => {
  return (
    systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
  );
};

/**
 * Simple conversation function (non-streaming) for DeepSeek.
 * Called by the chat route with conversation history and optional tools.
 */
const streamConversation = async (
  { messages, promptType = AppConfig.api.defaultPromptType, tools }, // tools not used yet
  streamHandlers
) => {
  const systemInstruction = getSystemPrompt(promptType);

  // Build chat messages: system + history from DB
  const chatMessages = [
    { role: "system", content: systemInstruction },
    ...messages,
  ];

  // Call DeepSeek via OpenAI SDK
  const completion = await deepseekClient.chat.completions.create({
    model: AppConfig.api.defaultModel || "deepseek-v4-flash",
    messages: chatMessages,
    thinking: { type: "enabled" },
    reasoning_effort: "low",
    stream: false,
    max_tokens: 1000,
  });

  const finalMessage = completion.choices[0]?.message;

  // Call handlers for compatibility with existing code
  if (streamHandlers && streamHandlers.onText && finalMessage?.content) {
    streamHandlers.onText(finalMessage.content);
  }
  if (streamHandlers && streamHandlers.onMessage) {
    streamHandlers.onMessage(finalMessage);
  }

  // Tool use is not implemented in this basic version.
  return finalMessage;
};

export function createDeepseekService(apiKey = process.env.DEEPSEEK_API_KEY) {
  // For now we reuse deepseekClient; apiKey parameter is unused but keeps same shape as Claude service.
  return {
    streamConversation,
    getSystemPrompt,
  };
}

export default {
  createDeepseekService,
};