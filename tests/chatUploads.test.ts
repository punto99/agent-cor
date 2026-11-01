import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { getFile } from "@convex-dev/agent";
import { components } from "../convex/_generated/api";
import { registerUploadedFile } from "../convex/data/files";
import { sendMessage, listThreadMessages } from "../convex/messaging/chat";
import * as tasks from "../convex/data/tasks";
import * as trello from "../convex/data/trello";
import { trelloProvider } from "../convex/integrations/trelloProvider";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { assertChatModelFileBudget } from "../convex/lib/chatModelFileBudget";
import {
  CHAT_MAX_FILES, CHAT_MAX_FILE_SIZE_BYTES, CHAT_MAX_TOTAL_SIZE_BYTES,
  assertChatFileSizes, assertChatOriginalCount, base64ByteLength, selectedChatFileSizes,
} from "../config/chatUploads";

function fixture() {
  let counter = 0;
  const rows = new Map<string, any>();
  const blobs = new Map<string, Blob>();
  const metadata = new Map<string, any>();
  const agentFiles = new Map<string, any>();
  const deleted: string[] = [], scheduled: any[] = [];
  const put = (table: string, row: any) => { rows.set(row._id, { _table: table, _creationTime: 1, ...row }); };
  put("chatThreads", { _id: "chat", threadId: "thread", userId: "user" });
  put("taskDrafts", { _id: "draft", threadId: "thread", userId: "user", status: "created", taskId: "task" });
  put("tasks", { _id: "task", threadId: "thread", taskDraftId: "draft", source: "internal", createdBy: "user", title: "Brief", description: "Brief", status: "nueva", corClientId: 197246, corProjectId: 10, corTaskId: "123", corSyncStatus: "synced", trelloCardId: "card" });
  const list = (table: string) => [...rows.values()].filter(row => row._table === table);
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "user|session" }) },
    db: {
      get: async (id: string) => rows.get(id) ?? null,
      normalizeId: (_: string, id: string) => id,
      system: { get: async (_: string, id: string) => metadata.get(id) ?? null },
      insert: async (table: string, row: any) => { const id = `row-${++counter}`; put(table, { ...row, _id: id }); return id; },
      patch: async (id: string, patch: any) => Object.assign(rows.get(id), patch),
      query: (table: string) => {
        const filters: any[] = [];
        const builder: any = { eq: (key: string, value: any) => { filters.push((row: any) => row[key] === value); return builder; } };
        const result = () => list(table).filter(row => filters.every(filter => filter(row)));
        const query: any = { withIndex: (_: string, build: any) => { build(builder); return query; }, collect: async () => result(), first: async () => result()[0] ?? null, unique: async () => { assert.ok(result().length <= 1); return result()[0] ?? null; } };
        return query;
      },
    },
    storage: {
      getMetadata: async (id: string) => metadata.get(id) ?? null,
      getUrl: async (id: string) => blobs.has(id) ? `https://files.example/${id}` : null,
      get: async (id: string) => blobs.get(id) ?? null,
      store: async () => { throw new Error("Registration must not copy file bytes"); },
      delete: async (id: string) => { deleted.push(id); blobs.delete(id); metadata.delete(id); },
    },
    scheduler: { runAfter: async (...args: any[]) => { scheduled.push(args); } },
  };
  ctx.runQuery = async (ref: any, args: any) => {
    if (args.fileId) return agentFiles.get(args.fileId) ?? null;
    if (args.paginationOpts) return { page: list("agentMessages").filter(row => row.threadId === args.threadId), isDone: true, continueCursor: "" };
    const name = getFunctionName(ref).split(":")[1];
    return (tasks as any)[name]._handler(ctx, args);
  };
  ctx.runMutation = async (ref: any, args: any) => {
    if (args.hash) {
      const existing = [...agentFiles.values()].find(file => file.hash === args.hash && file.filename === args.filename);
      if (existing) return { fileId: existing.fileId, storageId: existing.storageId };
      if (!args.storageId) return null;
      const fileId = `file-${++counter}`;
      agentFiles.set(fileId, { ...args, fileId });
      return { fileId, storageId: args.storageId };
    }
    if (args.messages) {
      return { messages: args.messages.map((message: any) => {
        const row = { ...message, _id: `message-${++counter}`, threadId: args.threadId, status: "success", order: counter, stepOrder: 0, tool: false };
        put("agentMessages", row);
        return row;
      }) };
    }
    const name = getFunctionName(ref).split(":")[1];
    return (tasks as any)[name]._handler(ctx, args);
  };
  const upload = async (name: string, type = "application/pdf", content = name) => {
    const id = `storage-${++counter}`;
    const blob = new Blob([content], { type });
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const hash = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    blobs.set(id, blob); metadata.set(id, { sha256: hash, size: blob.size, contentType: type });
    const result = await (registerUploadedFile as any)._handler(ctx, { storageId: id, filename: name, mimeType: type });
    return { ...result, inputStorageId: id };
  };
  const send = (ids: string[], attachmentFileIds?: string[], clientMessageId?: string) => (sendMessage as any)._handler(ctx, { threadId: "thread", prompt: "Revisá estos archivos", fileIds: ids, attachmentFileIds, clientMessageId });
  return { ctx, rows, blobs, metadata, agentFiles, deleted, scheduled, list, upload, send };
}

test("shared chat policy accepts five originals and enforces exact per-file/combined boundaries", () => {
  assert.equal(CHAT_MAX_FILES, 5);
  assert.doesNotThrow(() => assertChatOriginalCount(5));
  assert.throws(() => assertChatOriginalCount(6), /5 archivos/);
  assert.doesNotThrow(() => assertChatFileSizes([{ size: CHAT_MAX_FILE_SIZE_BYTES }, { size: CHAT_MAX_TOTAL_SIZE_BYTES - CHAT_MAX_FILE_SIZE_BYTES }]));
  assert.throws(() => assertChatFileSizes([{ size: CHAT_MAX_FILE_SIZE_BYTES + 1 }]), /20 MiB/);
  assert.throws(() => assertChatFileSizes([{ size: 20_000_000 }, { size: 20_000_000 }, { size: 1 }]), /40 MB/);
  assert.throws(() => assertChatFileSizes([{ size: 0 }]), /contenido/);
  for (const text of ["a", "ab", "abc"]) assert.equal(base64ByteLength(`data:image/png;base64,${btoa(text)}`), text.length);
  assert.deepEqual(selectedChatFileSizes([{ base64: "data:image/png;base64,YQ==", extractedImages: [{ data: "YWI=" }] }]), [{ size: 1 }, { size: 2 }]);
});

test("registration preserves original bytes and Agent references without fetching, copying or deleting the canonical blob", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Registration must not download files"); });
  const f = fixture();
  const file = await f.upload("Brief.pdf");
  assert.equal(file.storageId, file.inputStorageId);
  assert.deepEqual(f.deleted, []);
  const resolved = await getFile(f.ctx, components.agent, file.fileId);
  assert.equal(resolved.file.storageId, file.inputStorageId);
  assert.equal(resolved.filePart.data.toString(), file.url);
  assert.equal(await f.blobs.get(file.storageId)!.text(), "Brief.pdf");
  const duplicate = await f.upload("Brief.pdf");
  assert.equal(duplicate.fileId, file.fileId);
  assert.equal(duplicate.storageId, file.storageId);
  assert.deepEqual(f.deleted, [duplicate.inputStorageId]);
  assert.ok(f.blobs.has(file.storageId));
  const retry = await (registerUploadedFile as any)._handler(f.ctx, { storageId: file.storageId, filename: "Brief.pdf", mimeType: "application/pdf" });
  assert.equal(retry.fileId, file.fileId);
  assert.ok(f.blobs.has(file.storageId));
});

test("five chat uploads retain their exact storage references when attached to a task and forwarded to Trello", async t => {
  const f = fixture();
  const files = await Promise.all(Array.from({ length: 5 }, (_, index) => f.upload(`Brief ${index}.pdf`)));
  await f.send(files.map(file => file.fileId), files.map(file => file.fileId), "five-originals");
  assert.equal(f.list("agentMessages")[0].fileIds.length, 5);
  assert.equal(f.list("taskAttachments").length, 5);
  assert.deepEqual(f.list("taskAttachments").map(row => row.storageId).sort(), files.map(file => file.storageId).sort());
  const sent: string[] = [];
  t.mock.method(trelloProvider, "addCardAttachment", async (args: any) => {
    assert.equal(await args.file.text(), args.name);
    sent.push(args.name);
    return { id: `trello-${sent.length}`, url: `https://trello.example/${sent.length}` };
  });
  const result = await trello.syncPendingTaskAttachmentsToTrello._handler(f.ctx, { taskId: "task" });
  assert.equal(result.synced, 5);
  assert.equal(result.failed, 0);
  await trello.syncPendingTaskAttachmentsToTrello._handler(f.ctx, { taskId: "task" });
  assert.equal(sent.length, 5);
});

test("client receipts reconcile text and file messages through the real Agent query without changing message content or resending", async () => {
  const f = fixture();
  const file = await f.upload("Brief.pdf");
  const first = await f.send([file.fileId], undefined, "file-send");
  const second = await (sendMessage as any)._handler(f.ctx, { threadId: "thread", prompt: "Solo texto", clientMessageId: "text-send" });
  const page = await (listThreadMessages as any)._handler(f.ctx, { threadId: "thread", paginationOpts: { numItems: 50, cursor: null } });
  assert.equal(page.page.find((row: any) => row.id === first.messageId).clientMessageId, "file-send");
  assert.equal(page.page.find((row: any) => row.id === second.messageId).clientMessageId, "text-send");
  assert.equal(page.page.find((row: any) => row.id === second.messageId).text, "Solo texto");
  assert.equal(page.page[0].parts.filter((part: any) => part.type === "file").length, 1);
  assert.equal(f.list("taskAttachments").length, 1);
  const before = f.scheduled.length;
  const retry = await f.send([file.fileId], undefined, "file-send");
  assert.equal(retry.messageId, first.messageId);
  assert.equal(f.list("agentMessages").length, 2);
  assert.equal(f.list("taskAttachments").length, 1);
  assert.equal(f.scheduled.length, before);
  // Receipt fields stay outside the content and metadata passed to models.
  assert.doesNotMatch(JSON.stringify(f.list("agentMessages")), /file-send|text-send|clientMessageId/);
  f.ctx.auth.getUserIdentity = async () => ({ subject: "another-user|session" });
  await assert.rejects(f.send([file.fileId], undefined, "file-send"), /access denied/);
});

test("receipt history is bounded and legacy sends keep the existing storage shape", async () => {
  const f = fixture();
  f.rows.get("chat").clientMessageReceipts = Array.from({ length: 100 }, (_, index) => ({ clientMessageId: `old-${index}`, messageId: `message-old-${index}` }));
  await f.send([], undefined, "newest");
  const receipts = f.rows.get("chat").clientMessageReceipts;
  assert.equal(receipts.length, 100);
  assert.equal(receipts[0].clientMessageId, "old-1");
  assert.equal(receipts[99].clientMessageId, "newest");
  await f.send([]);
  assert.equal(f.rows.get("chat").clientMessageReceipts, receipts);
  await assert.rejects(f.send([], undefined, "x".repeat(129)), /Identificador/);
});

test("server rejects a sixth original even with a partial attachment list, and rejects oversized stored bytes before saving", async () => {
  const f = fixture();
  const files = await Promise.all(Array.from({ length: 6 }, (_, index) => f.upload(`file${index}.pdf`)));
  await assert.rejects(f.send(files.map(file => file.fileId), [files[0].fileId]), /5 archivos/);
  assert.equal(f.list("agentMessages").length, 0);
  assert.equal(f.scheduled.length, 0);
  f.metadata.get(files[0].storageId).size = CHAT_MAX_FILE_SIZE_BYTES + 1;
  await assert.rejects(f.send([files[0].fileId]), /20 MiB/);
  f.metadata.get(files[0].storageId).size = 20_000_000;
  f.metadata.get(files[1].storageId).size = 20_000_000;
  await assert.rejects(f.send(files.slice(0, 3).map(file => file.fileId)), /40 MB/);
  assert.equal(f.list("agentMessages").length, 0);
});

test("COR receives all five original files with unchanged bytes and does not resend them", async t => {
  const f = fixture();
  const files = await Promise.all(Array.from({ length: 5 }, (_, index) => f.upload(`COR ${index}.pdf`)));
  await f.send(files.map(file => file.fileId));
  const saved = { COR_API_KEY: process.env.COR_API_KEY, COR_CLIENT_SECRET: process.env.COR_CLIENT_SECRET };
  process.env.COR_API_KEY = "test"; process.env.COR_CLIENT_SECRET = "test";
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("/oauth/token")) return Response.json({ access_token: "test" });
    if (url.endsWith("/tasks/123")) return Response.json({ id: 123, project_id: 10, title: "Brief", status: "new" });
    if (url.endsWith("/tasks/123/attachments")) {
      const file = init.body.get("file") as File;
      assert.equal(await file.text(), file.name);
      sent.push(file.name);
      return Response.json({ files: [{ id: sent.length, url: `https://cor.example/${sent.length}`, originalname: file.name }] });
    }
    throw new Error(`Unexpected external call: ${url}`);
  });
  try {
    await (tasks.syncEditToCORAction as any)._handler(f.ctx, { taskId: "task", changedFields: [] });
    assert.equal(f.rows.get("task").corSyncStatus, "synced");
    assert.equal(sent.length, 5);
    assert.ok(f.list("taskAttachments").every(row => row.corAttachmentId && row.corUrl));
    await (tasks.syncEditToCORAction as any)._handler(f.ctx, { taskId: "task", changedFields: [] });
    assert.equal(sent.length, 5);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Word images remain model inputs without consuming original slots or becoming task attachments", async () => {
  const f = fixture();
  const originals = await Promise.all(Array.from({ length: 5 }, (_, index) => f.upload(`Word${index}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")));
  const images = await Promise.all(Array.from({ length: 6 }, (_, index) => f.upload(`Word0.docx-img-${index}.png`, "image/png")));
  await f.send([...originals, ...images].map(file => file.fileId), originals.map(file => file.fileId));
  assert.equal(f.list("agentMessages")[0].fileIds.length, 11);
  assert.equal(f.list("taskAttachments").length, 5);
  assert.ok(f.list("taskAttachments").every(row => row.filename.endsWith(".docx")));
});

test("model budget includes replayed files and repeated references, but not unused history files", async () => {
  const f = fixture();
  const first = await f.upload("first.pdf"), second = await f.upload("second.pdf");
  f.metadata.get(first.storageId).size = 20_000_000;
  f.metadata.get(second.storageId).size = 20_000_001;
  const maps = { byUrl: new Map([[first.url, { storageId: first.storageId, mimeType: "application/pdf" }], [second.url, { storageId: second.storageId, mimeType: "application/pdf" }]]), bySignature: new Map() };
  const message = (url: string) => ({ role: "user", content: [{ type: "file", data: new URL(url), mediaType: "application/pdf" }] });
  await assertChatModelFileBudget(f.ctx, [message(first.url)], maps);
  await assert.rejects(assertChatModelFileBudget(f.ctx, [message(first.url), message(second.url)], maps), /mensajes anteriores/);
  await assert.rejects(assertChatModelFileBudget(f.ctx, [message(first.url), message(first.url), message(first.url)], maps), /40 MB/);
  const candidates = [{ storageId: first.storageId, mimeType: "application/pdf" }, { storageId: second.storageId, mimeType: "application/pdf" }];
  const fallbackMaps = { byUrl: new Map(), bySignature: new Map([["brief.pdf|application/pdf", candidates]]) };
  const fallbackMessage = { role: "user", content: [{ type: "file", data: "inline", filename: "brief.pdf", mediaType: "application/pdf" }] };
  await assertChatModelFileBudget(f.ctx, [fallbackMessage], fallbackMaps);
  assert.equal(candidates.length, 2);
  await assert.rejects(assertChatModelFileBudget(f.ctx, [fallbackMessage, fallbackMessage], fallbackMaps), /40 MB/);
});

test("both installed model adapters send five PDF references without downloading or inlining them", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("The SDK must keep supported URLs as references"); });
  let openaiBody: any, geminiBody: any;
  const openai = createOpenAI({ apiKey: "test", fetch: async (_url, init) => {
    openaiBody = JSON.parse(init!.body as string);
    return Response.json({ id: "response", object: "response", created_at: 1, model: "gpt-5.5", status: "completed", output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Listo", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  } });
  const google = createGoogleGenerativeAI({ apiKey: "test", fetch: async (_url, init) => {
    geminiBody = JSON.parse(init!.body as string);
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Listo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
  } });
  const urls = Array.from({ length: 5 }, (_, index) => `https://files.example/file${index}.pdf`);
  await generateText({ model: openai("gpt-5.5"), maxRetries: 0, messages: [{ role: "user", content: urls.map(url => ({ type: "file", data: new URL(url), mediaType: "application/pdf" })) }] });
  assert.deepEqual(openaiBody.input[0].content.map((part: any) => part.file_url), urls);
  const googleUrls = urls.map((_, index) => `https://generativelanguage.googleapis.com/v1beta/files/file${index}`);
  await generateText({ model: google("gemini-3.7-flash"), maxRetries: 0, messages: [{ role: "user", content: googleUrls.map(url => ({ type: "file", data: new URL(url), mediaType: "application/pdf" })) }] });
  assert.deepEqual(geminiBody.contents[0].parts.map((part: any) => part.fileData.fileUri), googleUrls);
});
