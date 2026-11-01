type ChatMessageState = {
  role: string;
  status?: string;
  text?: string;
  parts?: readonly unknown[];
};

function hasVisibleContent(message: ChatMessageState) {
  return Boolean(message.text) || Boolean(message.parts?.some(part =>
    part !== null && typeof part === "object" &&
    (("text" in part && part.text) || ("url" in part && part.url)),
  ));
}

// One visual wait spans local uploads, server confirmation and model startup.
// An older error must not interrupt the indicator for the new user message.
export function showChatWaitingIndicator(
  messages: readonly ChatMessageState[],
  pending: readonly { status: "sending" | "confirmed" | "failed" }[],
) {
  if (messages.some(message => message.role === "assistant" && message.status === "streaming" && hasVisibleContent(message))) return false;
  if (pending.some(message => message.status === "failed")) return false;
  if (pending.some(message => message.status === "sending" || message.status === "confirmed")) return true;
  const last = messages.at(-1);
  if (last?.role === "user") return true;
  return last?.role === "assistant" && (last.status === "pending" || last.status === "streaming") &&
    !hasVisibleContent(last);
}
