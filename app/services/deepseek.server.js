import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

const deepseekClient = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const getSystemPrompt = (promptType) => {
  return (
    systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
  );
};

const MAX_TOOL_LOOP_ITERATIONS = 5;

const buildApiPayload = (chatMessages, tools) => {
  const apiPayload = {
    model: AppConfig.api.defaultModel || "deepseek-v4-flash",
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
