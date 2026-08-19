import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

const deepseekClient = new OpenAI({
  baseURL: process.env.OPENCODE_GO_API_BASE_URL || "https://opencode.ai/zen/go/v1",
  apiKey: process.env.OPENCODE_GO_API_KEY,
});

/**
 * Resolve the system prompt content for a prompt type, falling back to the
 * default prompt type when the requested one is missing.
 */
const getSystemPrompt = (promptType) => {
  return (
    systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
  );
};

const MAX_TOOL_LOOP_ITERATIONS = 5;

/**
 * Build the OpenAI-compatible API payload. When tools are present, tool calling
 * is enabled and reasoning/thinking is disabled (tool calls and reasoning
 * tokens are incompatible); otherwise deep thinking is enabled.
 */
const buildApiPayload = (chatMessages, tools) => {
  const apiPayload = {
    model: AppConfig.api.defaultModel || "mimo-v2.5",
    messages: chatMessages,
    max_tokens: 1000,
  };

  if (tools && tools.length > 0) {
    apiPayload.tools = tools;
    apiPayload.tool_choice = "auto";
    apiPayload.thinking = { type: "disabled" };
  } else {
    apiPayload.thinking = { type: "enabled" };
    apiPayload.reasoning_effort = "low";
  }

  return apiPayload;
};

/**
 * Send a single (non-streaming) completion request and return the assistant
 * message, injecting store context into the system prompt when available.
 */
const getCompletion = async ({ messages, promptType, tools, storeContext }) => {
  const systemInstruction = getSystemPrompt(promptType);

  const systemContent = storeContext
    ? `${systemInstruction}\n\n## Store context\n${storeContext}`
    : systemInstruction;

  const chatMessages = [
    { role: "system", content: systemContent },
    ...messages,
  ];

  const apiPayload = buildApiPayload(chatMessages, tools);

  console.log(`[DeepSeek] Calling API with ${tools?.length || 0} tools, ${chatMessages.length} messages`);

  const completion = await deepseekClient.chat.completions.create(apiPayload);

  const message = completion.choices[0]?.message;

  if (message?.tool_calls?.length) {
    console.log(`[DeepSeek] Response contains ${message.tool_calls.length} tool call(s):`,
      message.tool_calls.map(tc => tc.function.name).join(', '));
  } else {
    console.log(`[DeepSeek] Response is text-only (no tool calls), content length: ${message?.content?.length || 0}`);
  }

  return message;
};

/**
 * Streaming facade. The underlying DeepSeek client is non-streaming, so this
 * emits the full completion as a single text/message event, matching the shape
 * expected by the shared streaming handlers.
 */
const streamConversation = async (
  { messages, promptType, tools, storeContext },
  streamHandlers
) => {
  const result = await getCompletion({ messages, promptType, tools, storeContext });

  if (streamHandlers?.onText && result?.content) {
    streamHandlers.onText(result.content);
  }

  if (streamHandlers?.onMessage && result) {
    streamHandlers.onMessage(result);
  }

  return result;
};

export function createDeepseekService() {
  return {
    streamConversation,
    getCompletion,
    getSystemPrompt,
    MAX_TOOL_LOOP_ITERATIONS,
  };
}

export default {
  createDeepseekService,
};
