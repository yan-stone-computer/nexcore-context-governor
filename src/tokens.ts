import type { ChatMessage, ContentPart } from "./common.ts";

/**
 * Conservative provider-independent estimate. It is deterministic and works
 * offline, but callers may replace it with provider-reported usage when exact
 * billing matters.
 */
export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 2);
}

export const IMAGE_TOKENS = 1600;

export function messageTokens(message: ChatMessage): number {
  if (!Array.isArray(message.content)) {
    return estimateTokens(JSON.stringify(message) || "");
  }
  const parts = message.content as ContentPart[];
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = parts.filter((part) => part.type === "image_url").length;
  return (
    estimateTokens(
      JSON.stringify({ role: message.role, tool_calls: message.tool_calls }),
    ) +
    estimateTokens(text) +
    images * IMAGE_TOKENS
  );
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}
