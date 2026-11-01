import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessageList } from "../app/components/chat/ChatMessageList";
import type { FileInfo } from "../app/components/chat/FilePreviewList";
import {
  PendingChatMessages, localChatMessage, visiblePendingMessages,
} from "../app/lib/pendingChatMessages";
import { showChatWaitingIndicator } from "../app/lib/chatWaitingIndicator";

const scope = { userId: "user-a", threadId: "thread-a" };
function file(name: string, type = "application/pdf"): FileInfo {
  return { name, type, base64: `data:${type};base64,YQ==`, isImage: type.startsWith("image/"), isAudio: type.startsWith("audio/"), isDocument: !type.startsWith("image/") };
}
function markup(message: ReturnType<typeof localChatMessage>) {
  return renderToStaticMarkup(createElement(ChatMessageList, {
    messages: [message], currentThreadId: scope.threadId,
    isAgentThinking: false, isCreatingThread: false,
  }));
}

test("text and five original attachments render immediately without loading labels or extracted Word content", () => {
  const store = new PendingChatMessages();
  const files = [file("foto.png", "image/png"), file("brief.pdf"), file("otro.pdf"), file("voz.wav", "audio/wav"), {
    ...file("documento.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    extractedMarkdown: "private extracted text", extractedImages: [{ data: "YQ==", mimeType: "image/png" }],
  }];
  const pending = store.start(scope, "Mi mensaje inmediato", files)!;
  const html = markup(localChatMessage(pending));
  assert.match(html, /Mi mensaje inmediato/);
  for (const name of files.map(file => file.name)) assert.ok(html.includes(name));
  assert.match(html, /<img[^>]*src="data:image\/png;base64,YQ=="/);
  assert.doesNotMatch(html, />\s*(Subiendo|Enviando|Cargando)|animate-bounce|private extracted text|data:application\/pdf/);
  const textOnly = new PendingChatMessages().start(scope, "Solo texto", [])!;
  assert.match(markup(localChatMessage(textOnly)), /Solo texto/);
  assert.doesNotMatch(markup(localChatMessage(textOnly)), /Sin contenido/);
  const attachmentsOnly = new PendingChatMessages().start(scope, "", files)!;
  assert.ok(markup(localChatMessage(attachmentsOnly)).includes("brief.pdf"));
  assert.doesNotMatch(markup(localChatMessage(attachmentsOnly)), /Sin contenido/);
});

test("each send is isolated by user and chat and survives subscriber remounts without allowing double submits", () => {
  const store = new PendingChatMessages();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  const pending = store.start(scope, "Primero", [file("brief.pdf")])!;
  assert.equal(updates, 1);
  assert.equal(store.start(scope, "Duplicado", []), null);
  unsubscribe();
  store.confirm(pending.id, "saved-first");
  assert.equal(updates, 1);
  const remounted = store.getSnapshot();
  assert.equal(visiblePendingMessages(remounted, scope, []).length, 1);
  assert.equal(visiblePendingMessages(remounted, { ...scope, userId: "user-b" }, []).length, 0);
  assert.equal(visiblePendingMessages(remounted, { ...scope, threadId: "thread-b" }, []).length, 0);
  assert.ok(store.start({ ...scope, threadId: "thread-b" }, "Otro chat", []));
  store.acknowledge(scope, [{ id: "saved-first" }]);
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(store.getSnapshot()[0].threadId, "thread-b");
});

test("server query arriving before the mutation result replaces the local message exactly once by client id", () => {
  const store = new PendingChatMessages();
  const pending = store.start(scope, "Hola", [])!;
  const saved = [{ id: "server-id", clientMessageId: pending.id }];
  assert.equal(visiblePendingMessages(store.getSnapshot(), scope, saved).length, 0);
  store.acknowledge(scope, saved);
  store.confirm(pending.id, "server-id");
  assert.equal(store.getSnapshot().length, 0);
  assert.ok(store.start(scope, "Hola", []));
  // An older message with identical text must not hide the new send.
  assert.equal(visiblePendingMessages(store.getSnapshot(), scope, saved).length, 1);
});

test("mutation result arriving first keeps previews until the matching query is visible and releases file payloads", () => {
  const store = new PendingChatMessages();
  const pending = store.start(scope, "Archivos", [file("brief.pdf"), file("foto.png", "image/png")])!;
  store.confirm(pending.id, "saved-id");
  const snapshot = store.getSnapshot();
  assert.equal(visiblePendingMessages(snapshot, scope, []).length, 1);
  assert.equal(snapshot[0].files[0].base64, "");
  assert.equal(snapshot[0].files[1].base64, pending.files[1].base64);
  assert.equal(pending.files[0].base64, "data:application/pdf;base64,YQ==");
  assert.equal(visiblePendingMessages(snapshot, scope, [{ id: "unrelated" }]).length, 1);
  const saved = [{ id: "saved-id" }];
  assert.equal(visiblePendingMessages(snapshot, scope, saved).length, 0);
  store.acknowledge(scope, saved);
  assert.equal(store.getSnapshot().length, 0);
});

test("failed sends preserve text and all file bytes, allow one retry and show only an actionable error", () => {
  const store = new PendingChatMessages();
  const pending = store.start(scope, "Conservar este mensaje", [file("brief.pdf")])!;
  store.fail(pending.id);
  const failed = store.getSnapshot()[0];
  const html = markup(localChatMessage(failed));
  assert.match(html, /No se pudo enviar el mensaje/);
  assert.match(html, /Reintentar/);
  assert.match(html, /Conservar este mensaje/);
  assert.equal(failed.files[0].base64, pending.files[0].base64);
  assert.equal(store.retry(pending.id, { ...scope, userId: "other" }), null);
  const retry = store.retry(pending.id, scope)!;
  assert.equal(retry.id, pending.id);
  assert.equal(retry.files, pending.files);
  assert.equal(store.retry(pending.id, scope), null);
  assert.doesNotMatch(markup(localChatMessage(retry)), /No se pudo enviar|Reintentar|>\s*(Subiendo|Enviando)/);
  store.dismiss(pending.id, scope);
  assert.equal(store.getSnapshot().length, 1); // An in-flight send cannot be discarded.
  store.fail(pending.id);
  store.dismiss(pending.id, scope);
  assert.equal(store.getSnapshot().length, 0);
});

test("each attachment loses its subtle loader independently; failures stop loaders and retries reset them", () => {
  const store = new PendingChatMessages();
  const files = [file("foto.png", "image/png"), file("brief.pdf"), file("documento.docx")];
  const pending = store.start(scope, "Adjuntos", files)!;
  const loaderCount = () => (markup(localChatMessage(store.getSnapshot()[0])).match(/data-attachment-upload/g) ?? []).length;
  assert.equal(loaderCount(), 3);
  assert.match(markup(localChatMessage(pending)), /absolute inset-0 flex items-center justify-center/);
  assert.match(markup(localChatMessage(pending)), /ml-auto flex size-3.5 shrink-0/);
  assert.match(markup(localChatMessage(pending)), /opacity-45/);
  store.markFileUploaded(pending.id, 0);
  assert.equal(loaderCount(), 2);
  store.markFileUploaded(pending.id, 0);
  assert.equal(loaderCount(), 2);
  store.markFileUploaded(pending.id, 1);
  assert.equal(loaderCount(), 1);
  assert.equal(store.getSnapshot()[0].files, pending.files);
  store.fail(pending.id);
  assert.equal(loaderCount(), 0);
  store.retry(pending.id, scope);
  assert.equal(loaderCount(), 3);
  for (let index = 0; index < files.length; index++) store.markFileUploaded(pending.id, index);
  assert.equal(loaderCount(), 0);
  store.confirm(pending.id, "server-id");
  assert.equal(loaderCount(), 0);
});

test("the same waiting indicator spans uploads, confirmation, pending and empty streaming without a gap", () => {
  const store = new PendingChatMessages();
  const pending = store.start(scope, "Nuevo mensaje", [file("foto.png", "image/png")])!;
  const olderError = { id: "older-error", role: "assistant", status: "success", text: "⚠️ Error anterior", parts: [] };
  const savedUser = { role: "user", status: "success", text: "Nuevo mensaje", id: "server-id", clientMessageId: pending.id, parts: [] };
  const assistantPending = { id: "assistant-id", role: "assistant", status: "pending", text: "", parts: [] };
  const assistantStreaming = { ...assistantPending, status: "streaming" };
  const frames: Array<{ saved: typeof olderError[]; pending: ReturnType<typeof store.getSnapshot> }> = [];
  frames.push({ saved: [olderError], pending: store.getSnapshot() });
  store.markFileUploaded(pending.id, 0);
  frames.push({ saved: [olderError], pending: store.getSnapshot() });
  store.confirm(pending.id, "server-id");
  frames.push({ saved: [olderError], pending: store.getSnapshot() });
  const saved = [olderError, savedUser];
  frames.push({ saved, pending: visiblePendingMessages(store.getSnapshot(), scope, saved) });
  store.acknowledge(scope, saved);
  frames.push({ saved, pending: store.getSnapshot() });
  frames.push({ saved: [...saved, assistantPending], pending: [] });
  frames.push({ saved: [...saved, assistantStreaming], pending: [] });
  const ellipses = frames.map(frame => {
    assert.equal(showChatWaitingIndicator(frame.saved, frame.pending), true);
    const html = renderToStaticMarkup(createElement(ChatMessageList, {
      messages: [], currentThreadId: scope.threadId, isCreatingThread: false,
      isAgentThinking: showChatWaitingIndicator(frame.saved, frame.pending),
    }));
    assert.equal((html.match(/data-chat-waiting-indicator/g) ?? []).length, 1);
    return html.slice(html.indexOf("data-chat-waiting-indicator"));
  });
  assert.equal(new Set(ellipses).size, 1);
  assert.equal(showChatWaitingIndicator([...saved, { ...assistantStreaming, text: "Respuesta" }], []), false);
  assert.equal(showChatWaitingIndicator([...saved, { ...assistantPending, status: "success", text: "Respuesta" }], []), false);
  assert.equal(showChatWaitingIndicator([olderError], [{ status: "failed" }]), false);
});

test("confirmation keeps all five Word cards visible without exposing extracted text", () => {
  const text = "hacer un brief" + Array.from({ length: 5 }, (_, index) =>
    `\n\n--- Contenido extraído del documento "Brief ${index}.docx" ---\nprivate document contents ${index}\n--- Fin del documento ---`,
  ).join("");
  const html = markup({ key: "saved-word", role: "user", content: [{ type: "text", text }], _creationTime: 1 });
  assert.equal((html.match(/Documento DOCX/g) ?? []).length, 5);
  assert.match(html, /hacer un brief/);
  assert.doesNotMatch(html, /private document contents|Contenido extraído/);
});
