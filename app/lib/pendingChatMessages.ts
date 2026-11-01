import type { FileInfo } from "../components/chat/FilePreviewList";
import type { Message } from "../components/chat/MessageContent";

export type ChatSendScope = { userId: string; threadId: string };
export type PendingChatMessage = ChatSendScope & {
  id: string;
  text: string;
  files: FileInfo[];
  createdAt: number;
  status: "sending" | "confirmed" | "failed";
  uploadedFileIndexes: number[];
  messageId?: string;
};
type SavedMessage = { id?: string; clientMessageId?: string };
const EMPTY: PendingChatMessage[] = [];

export function belongsToChat(message: ChatSendScope, scope: ChatSendScope) {
  return message.userId === scope.userId && message.threadId === scope.threadId;
}

function isSaved(message: PendingChatMessage, saved: SavedMessage[]) {
  return saved.some(row => row.clientMessageId === message.id ||
    (message.messageId !== undefined && row.id === message.messageId));
}

export function visiblePendingMessages(messages: PendingChatMessage[], scope: ChatSendScope, saved: SavedMessage[]) {
  return messages.filter(message => belongsToChat(message, scope) && !isSaved(message, saved));
}

// Browser memory only. Survives ChatInterface remounts when switching chats;
// scoped by both the authenticated user and thread. No file bytes are persisted.
export class PendingChatMessages {
  private messages: PendingChatMessage[] = EMPTY;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.messages;
  getServerSnapshot = () => EMPTY;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(messages: PendingChatMessage[]) {
    this.messages = messages;
    this.listeners.forEach(listener => listener());
  }
  start(scope: ChatSendScope, text: string, files: FileInfo[]) {
    if (this.messages.some(message => belongsToChat(message, scope))) return null;
    const message: PendingChatMessage = {
      ...scope, id: crypto.randomUUID(), text, files: [...files],
      createdAt: Date.now(), status: "sending", uploadedFileIndexes: [],
    };
    this.update([...this.messages, message]);
    return message;
  }
  confirm(id: string, messageId: string) {
    this.update(this.messages.map(message => message.id === id
      ? {
          ...message, status: "confirmed", messageId,
          // Once saved, only image previews are needed for the brief query handoff.
          files: message.files.map(file => ({
            ...file, base64: file.isImage ? file.base64 : "",
            extractedImages: undefined, extractedMarkdown: undefined,
          })),
        } : message));
  }
  markFileUploaded(id: string, index: number) {
    const message = this.messages.find(row => row.id === id);
    if (!message || message.status !== "sending" || index < 0 || index >= message.files.length ||
      message.uploadedFileIndexes.includes(index)) return;
    this.update(this.messages.map(row => row.id === id
      ? { ...row, uploadedFileIndexes: [...row.uploadedFileIndexes, index] } : row));
  }
  fail(id: string) {
    this.update(this.messages.map(message => message.id === id
      ? { ...message, status: "failed" } : message));
  }
  retry(id: string, scope: ChatSendScope) {
    const message = this.messages.find(row => row.id === id && belongsToChat(row, scope) && row.status === "failed");
    if (!message) return null;
    const retry: PendingChatMessage = { ...message, status: "sending", uploadedFileIndexes: [] };
    this.update(this.messages.map(row => row.id === id ? retry : row));
    return retry;
  }
  dismiss(id: string, scope: ChatSendScope) {
    this.update(this.messages.filter(row => !(row.id === id && belongsToChat(row, scope) && row.status === "failed")));
  }
  acknowledge(scope: ChatSendScope, saved: SavedMessage[]) {
    const remaining = this.messages.filter(message => !belongsToChat(message, scope) || !isSaved(message, saved));
    if (remaining.length !== this.messages.length) this.update(remaining);
  }
}

export const pendingChatMessages = new PendingChatMessages();

export function localChatMessage(message: PendingChatMessage): Message {
  return {
    key: message.id, role: "user", content: message.text,
    _creationTime: message.createdAt, localSendId: message.id,
    localAttachments: message.files.map((file, index) => ({
      name: file.name, mimeType: file.type,
      previewUrl: file.isImage ? file.base64 : undefined,
      isUploading: message.status === "sending" && !message.uploadedFileIndexes.includes(index),
    })),
    sendFailed: message.status === "failed",
  };
}
