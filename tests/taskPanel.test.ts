import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as panel from "../convex/data/taskPanel";
import * as sender from "../convex/data/taskPanelSync";
import * as tasks from "../convex/data/tasks";
import { hasExternalRequestsAccess, canViewExternalRequest } from "../convex/lib/externalRequestsAccess";
import * as history from "../convex/data/notificationHistory";
import * as notifications from "../convex/data/commentNotifications";
import * as taskNotifications from "../convex/data/taskCreationNotifications";
import { notifyExternalTaskCreated, taskCreationEmail } from "../convex/lib/taskCreationNotifications";
import { notifyTaskComment } from "../convex/lib/commentNotifications";
import { clientConfig } from "../config/tenant.config";

const originalRequestsClientIds = clientConfig.ui.externalRequestsClientIds;
test.beforeEach(() => { clientConfig.ui.externalRequestsClientIds = ["client1"]; });
test.afterEach(() => { clientConfig.ui.externalRequestsClientIds = originalRequestsClientIds; });

// A small transactional Convex context double; tests run real handlers/helpers.
function fixture() {
  let counter = 0;
  const rows = new Map<string, any>();
  const scheduled: any[] = [];
  const put = (table: string, doc: any) => { rows.set(doc._id, { _table: table, _creationTime: 1, ...doc }); return doc._id; };
  put("approvedExternalUsers", { _id: "external1", userId: "user1" });
  put("corClients", { _id: "client1", corClientId: clientConfig.ui.trelloPublishCorClientIds[0] });
  put("clientUserAssignments", { _id: "assignment-user1", clientId: "client1", userId: "user1" });
  put("tasks", { _id: "task1", clientId: "client1", createdBy: "user1", source: "external", threadId: "thread1", corClientId: clientConfig.ui.trelloPublishCorClientIds[0], title: "Original", description: "Original brief", status: "nueva" });
  const db: any = {
    normalizeId: (_table: string, id: string) => id || null,
    get: async (id: string) => rows.get(id) ?? null,
    insert: async (table: string, data: any) => put(table, { ...data, _id: `${table}-${++counter}` }),
    patch: async (id: string, data: any) => { const row = rows.get(id); assert.ok(row); for (const [key, value] of Object.entries(data)) { if (value === undefined) delete row[key]; else row[key] = value; } },
    query: (table: string) => {
      const filters: ((r: any) => boolean)[] = [];
      let descending = false;
      const builder: any = {
        eq: (key: string, value: any) => { filters.push(r => r[key] === value); return builder; },
        lt: (key: string, value: any) => { filters.push(r => r[key] < value); return builder; },
        gt: (key: string, value: any) => { filters.push(r => r[key] > value); return builder; },
        gte: (key: string, value: any) => { filters.push(r => r[key] >= value); return builder; },
        lte: (key: string, value: any) => { filters.push(r => r[key] <= value); return builder; },
      };
      const result = () => Array.from(rows.values()).filter(r => r._table === table && filters.every(f => f(r)));
      const query: any = { withIndex: (_: string, build: any) => { build(builder); return query; }, collect: async () => result(), unique: async () => { assert.ok(result().length < 2); return result()[0] ?? null; }, first: async () => result()[0] ?? null, take: async (n: number) => result().slice(0,n) };
      query.order = (direction: string) => { descending = direction === "desc"; return query; };
      query[Symbol.asyncIterator] = async function* () {
        const sorted = result().sort((a, b) => {
          for (const key of ["createdAt", "_creationTime", "_id"]) {
            if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (descending ? -1 : 1);
          }
          return 0;
        });
        yield* sorted;
      };
      return query;
    },
  };
  const ctx: any = { db, auth: { getUserIdentity: async () => ({ subject: "user1|session" }) }, storage: { getUrl: async (id: string) => `https://files.example/${id}`, get: async () => new Blob(["test"], { type: "application/pdf" }) }, scheduler: { runAfter: async (...args: any[]) => { scheduled.push(args); } } };
  const modules: any = { "data/taskPanel": panel, "data/taskPanelSync": sender, "data/tasks": tasks, "data/taskCreationNotifications": taskNotifications };
  const run = async (ref: any, args: any) => { const [module, name] = getFunctionName(ref).split(":"); return modules[module][name]._handler(ctx, args); };
  ctx.runQuery = run; ctx.runMutation = run;
  const upload = (id = "upload1", patch: any = {}) => put("taskPanelUploads", { _id: id, taskId: "task1", userId: "user1", key: id, filename: `${id}.pdf`, mimeType: "application/pdf", size: 4, state: "ready", fileId: `file-${id}`, storageId: `storage-${id}`, createdAt: 1, ...patch });
  const call = async (handler: any, args: any) => {
    const snapshot = structuredClone(Array.from(rows.entries()));
    try { return await handler._handler(ctx, args); } catch (error) { rows.clear(); snapshot.forEach(([id,row]) => rows.set(id,row)); throw error; }
  };
  return { ctx, rows, put, upload, call, scheduled };
}
function providers() {
  const calls: string[] = [];
  const p: any = {
    trello: { addCardAttachment: async () => { calls.push("trello-file"); return { id: "ta1", url: "https://trello.example/ta1" }; }, addCommentToCard: async () => { calls.push("trello-comment"); return { id: "tc1" }; } },
    cor: () => ({ getTask: async () => ({ projectId: 10 }), uploadTaskAttachment: async () => { calls.push("cor-file"); return { success: true, attachment: { id: 20, url: "https://cor.example/a20" } }; }, postTaskMessage: async () => { calls.push("cor-comment"); return { success: true }; } }),
  };
  return { p, calls };
}

test("rejects anonymous/internal/other-owner access and foreign uploads", async () => {
  const f = fixture();
  await assert.rejects(panel.requirePanelTask(f.ctx, "task1" as any, null));
  await assert.rejects(panel.requirePanelTask(f.ctx, "task1" as any, "user2" as any));
  f.upload("foreign", { userId: "user2" });
  await assert.rejects(f.call(panel.submit, { taskId: "task1", key: "k", text: "Hello", uploadIds: ["foreign"] }));
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "taskPanelEntries").length, 0);
  f.rows.delete("external1");
  f.rows.delete("assignment-user1");
  await assert.rejects(panel.requirePanelTask(f.ctx, "task1" as any, "user1" as any));
});

test("atomic, idempotent submission relates comments/files without chat or field mutations", async () => {
  const f = fixture(); const original = structuredClone(f.rows.get("task1")); f.upload();
  const args = { taskId: "task1", key: "k", text: "Comment", uploadIds: ["upload1"] };
  const id = await f.call(panel.submit, args);
  assert.equal(await f.call(panel.submit, args), id);
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(f.rows.get("task1"), original);
  const attachments = Array.from(f.rows.values()).filter(r => r._table === "taskAttachments");
  const messages = Array.from(f.rows.values()).filter(r => r._table === "taskMessages");
  assert.equal(attachments.length, 1); assert.equal(messages.length, 1);
  assert.equal(messages[0].panelEntryId, attachments[0].panelEntryId);
  assert.equal(messages[0].corMessageSyncStatus, "pending_cor_task");
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "threadUploadedFiles").length, 0);
  await assert.rejects(f.call(panel.submit, { ...args, key: "other" }));
  await assert.rejects(f.call(panel.submit, { ...args, text: "Changed" }));
});

test("legacy queues keep chat files/comments and exclude only panel records", async () => {
  const f = fixture(); f.upload(); await f.call(panel.submit, { taskId: "task1", key: "k", text: "Panel", uploadIds: ["upload1"] });
  f.put("taskAttachments", { _id: "legacy", taskId: "task1", fileId: "old" });
  f.put("taskMessages", { _id: "chat-comment", taskId: "task1", source: "external_agent", message: "Old", corMessageSyncStatus: "pending_cor_task", createdAt: 0 });
  assert.deepEqual((await f.call(tasks.getPendingAttachments, { taskId: "task1" })).map((r: any) => r._id), ["legacy"]);
  assert.deepEqual((await f.call(tasks.getTaskAttachmentsForTrello, { taskId: "task1" })).map((r: any) => r._id), ["legacy"]);
  assert.deepEqual((await f.call(tasks.listPendingTaskMessagesForCORInternal, { taskId: "task1" })).map((r: any) => r._id), ["chat-comment"]);
});

test("sends to Trello now and COR after publishing without resending Trello", async () => {
  const f = fixture(); f.rows.get("task1").trelloCardId = "card1"; f.upload();
  const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: "Comment", uploadIds: ["upload1"] });
  const { p, calls } = providers();
  await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, ["trello-file", "trello-comment"]);
  assert.equal(f.rows.get(id).corState, "waiting");
  Object.assign(f.rows.get("task1"), { corTaskId: "2", corProjectId: 10, corSyncStatus: "synced" });
  await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, ["trello-file", "trello-comment", "cor-file", "cor-comment"]);
  await sender.syncEntry(f.ctx, id, p);
  assert.equal(calls.length, 4);
  assert.equal(f.rows.get("task1").description, "Original brief");
});

test("attachment-only and comment-only entries work for already-published tasks", async () => {
  for (const files of [false, true]) {
    const f = fixture(); Object.assign(f.rows.get("task1"), { trelloCardId: "card1", corTaskId: "2", corProjectId: 10, corSyncStatus: "synced" });
    if (files) f.upload();
    const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: files ? "" : "Comment", uploadIds: files ? ["upload1"] : [] });
    const { p, calls } = providers(); await sender.syncEntry(f.ctx, id, p);
    assert.deepEqual(calls, files ? ["trello-file", "cor-file"] : ["trello-comment", "cor-comment"]);
  }
});

test("uncertain writes are not repeated; lease excludes concurrent consumers", async () => {
  const f = fixture(); f.rows.get("task1").trelloCardId = "card1";
  const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: "Comment", uploadIds: [] });
  assert.equal(await f.call(sender.claim, { entryId: id }), true);
  assert.equal(await f.call(sender.claim, { entryId: id }), false);
  await f.call(sender.release, { entryId: id });
  const { p, calls } = providers(); p.trello.addCommentToCard = async () => { calls.push("uncertain"); throw new Error("connection lost"); };
  await sender.syncEntry(f.ctx, id, p); await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, ["uncertain"]); assert.equal(f.rows.get(id).trelloState, "needs_review");
});

test("COR project mismatch never uploads or posts", async () => {
  const f = fixture(); Object.assign(f.rows.get("task1"), { corTaskId: "2", corProjectId: 999, corSyncStatus: "synced" });
  const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: "Comment", uploadIds: [] });
  const { p, calls } = providers(); await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, []); assert.equal(f.rows.get(id).corState, "needs_review");
});

test("upload tickets validate type, size, ownership and task before accepting content", async () => {
  const f = fixture();
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
  const args = { taskId: "task1", key: "upload-key", filename: "brief.pdf", mimeType: "application/pdf", size: 4 };
  await assert.rejects(f.call(panel.prepareUpload, { ...args, mimeType: "text/html" }));
  await assert.rejects(f.call(panel.prepareUpload, { ...args, size: 21 * 1024 * 1024 }));
  const first = await f.call(panel.prepareUpload, args);
  assert.equal((await f.call(panel.prepareUpload, args)).uploadId, first.uploadId);
  await assert.rejects(f.call(panel.claimUpload, { uploadId: first.uploadId, userId: "user2" }));
  await f.call(panel.claimUpload, { uploadId: first.uploadId, userId: "user1" });
  await assert.rejects(f.call(panel.claimUpload, { uploadId: first.uploadId, userId: "user1" }));
  await f.call(panel.finishUpload, { uploadId: first.uploadId, userId: "user1", fileId: "f", storageId: "s" });
  assert.equal((await f.call(panel.claimUpload, { uploadId: first.uploadId, userId: "user1" })).state, "ready");
});

test("expired sender is marked for review instead of duplicating an uncertain write", async () => {
  const f = fixture();
  const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: "Comment", uploadIds: [] });
  Object.assign(f.rows.get(id), { trelloState: "sending", corState: "synced", leaseUntil: Date.now() - 1 });
  assert.equal(await f.call(sender.claim, { entryId: id }), false);
  assert.equal(f.rows.get(id).trelloState, "needs_review");
});

test("new panel attachment does not adopt an existing chat file with identical physical fileId", async () => {
  const f = fixture(); f.upload();
  f.put("taskAttachments", { _id: "original-chat-file", taskId: "task1", fileId: "file-upload1", storageId: "storage-upload1", filename: "Original.pdf", corAttachmentId: 99 });
  await f.call(panel.submit, { taskId: "task1", key: "k", text: "", uploadIds: ["upload1"] });
  assert.equal(f.rows.get("original-chat-file").panelEntryId, undefined);
  assert.equal(f.rows.get("original-chat-file").corAttachmentId, 99);
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "taskAttachments").length, 2);
});

test("two identical files in a submission reuse one task attachment without losing upload ownership", async () => {
  const f = fixture(); f.upload(); f.upload("upload2", { fileId: "file-upload1", storageId: "storage-upload1" });
  const id = await f.call(panel.submit, { taskId: "task1", key: "k", text: "", uploadIds: ["upload1", "upload2"] });
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "taskAttachments").length, 1);
  assert.equal(f.rows.get("upload1").entryId, id); assert.equal(f.rows.get("upload2").entryId, id);
});

test("detail includes legacy task attachments and uses neutral comment author metadata", async () => {
  const f = fixture();
  f.put("taskAttachments", { _id: "legacy-file", taskId: "task1", filename: "old.pdf", mimeType: "application/pdf", storageId: "old-storage", fileId: "old-file", createdAt: 1 });
  f.put("taskMessages", { _id: "trello-comment", taskId: "task1", source: "trello", message: "Image", createdAt: 2 });
  const result = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(result.attachments[0].id, "legacy-file");
  assert.equal(result.attachments[0].mimeType, "application/pdf");
  assert.equal(result.attachments[0].url, "https://files.example/old-storage");
  assert.equal("source" in result.comments[0], false);
});

test("inline comment files resolve atomically and invalid references cannot attach files", async () => {
  const f = fixture(); f.upload("image", { filename: "foto.png", mimeType: "image/png" });
  const args = { taskId: "task1", key: "inline", text: "Antes\n\n{{task-panel-file:0}}\n\nDespués", uploadIds: ["image"] };
  await assert.rejects(f.call(panel.submit, { ...args, text: "{{task-panel-file:2}}" }));
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "taskAttachments").length, 0);
  assert.equal(f.rows.get("image").entryId, undefined);
  const id = await f.call(panel.submit, args);
  const message = f.rows.get(f.rows.get(id).messageId).message;
  assert.equal(message, "Antes\n\n![foto.png](https://files.example/storage-image)\n\nDespués");
  assert.equal(await f.call(panel.submit, args), id);
  assert.equal(Array.from(f.rows.values()).filter(r => r._table === "taskMessages").length, 1);
});

test("internal comment reader preserves task access and includes published comments", async () => {
  const f = fixture();
  f.put("taskMessages", { _id: "comment1", taskId: "task1", userId: "user1", source: "external_panel", message: "Hola", createdAt: 1, corMessageSyncStatus: "synced" });
  assert.deepEqual(await f.call(tasks.listInternalTaskComments, { taskId: "task1" }), []);
  f.rows.delete("external1");
  f.rows.get("task1").corTaskId = "123";
  f.rows.delete("assignment-user1");
  assert.deepEqual(await f.call(tasks.listInternalTaskComments, { taskId: "task1" }), []);
  f.put("corClients", { _id: "client1", corClientId: f.rows.get("task1").corClientId });
  f.put("clientUserAssignments", { _id: "assignment1", clientId: "client1", userId: "user1" });
  const comments = await f.call(tasks.listInternalTaskComments, { taskId: "task1" });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "Hola");
  f.rows.get("task1").convexStatus = "deleted";
  assert.deepEqual(await f.call(tasks.listInternalTaskComments, { taskId: "task1" }), []);
});

test("authorized internal comments reuse deferred sync and are visible to the external creator", async () => {
  const f = fixture();
  f.ctx.auth.getUserIdentity = async () => ({ subject: "internal1|session" });
  const args = { taskId: "task1", key: "internal-comment", text: "Nueva propuesta {{task-panel-file:0}}", uploadIds: ["internal-upload"] };
  f.upload("internal-upload", { userId: "internal1" });
  await assert.rejects(f.call(panel.submit, args));
  f.put("corClients", { _id: "client1", corClientId: f.rows.get("task1").corClientId });
  f.put("clientUserAssignments", { _id: "internal-access", userId: "internal1", clientId: "client1" });
  f.rows.get("task1").trelloCardId = "card1";
  const id = await f.call(panel.submit, args);
  assert.equal(await f.call(panel.submit, args), id);
  const message = f.rows.get(f.rows.get(id).messageId);
  assert.equal(message.source, "internal_panel");
  const { p, calls } = providers();
  await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, ["trello-file", "trello-comment"]);
  assert.equal(f.rows.get(id).corState, "waiting");
  f.ctx.auth.getUserIdentity = async () => ({ subject: "user1|session" });
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.ok(detail.comments.some((comment: any) => comment.id === message._id));
  Object.assign(f.rows.get("task1"), { corTaskId: "2", corProjectId: 10, corSyncStatus: "synced" });
  await sender.syncEntry(f.ctx, id, p);
  await sender.syncEntry(f.ctx, id, p);
  assert.deepEqual(calls, ["trello-file", "trello-comment", "cor-file", "cor-comment"]);
  f.rows.delete("internal-access");
  await assert.rejects(panel.requirePanelTask(f.ctx, "task1" as any, "internal1" as any));
});

test("replies retain their parent, retry safely and include context for providers", async () => {
  const f = fixture();
  f.put("users", { _id: "user1", name: "Julia" });
  const originalId = await f.call(panel.submit, { taskId: "task1", key: "parent", text: "Revisar la imagen", uploadIds: [] });
  const parent = f.rows.get(originalId).messageId;
  const args = { taskId: "task1", key: "reply", text: "Está aprobada", uploadIds: [], replyTo: parent };
  const entryId = await f.call(panel.submit, args);
  assert.equal(await f.call(panel.submit, args), entryId);
  const message = f.rows.get(f.rows.get(entryId).messageId);
  assert.equal(message.replyTo, parent);
  assert.equal(message.message, "Está aprobada");
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(detail.comments.find((c: any) => c.id === message._id).replyTo, parent);
  const sync = await f.call(panel.syncContext, { entryId });
  assert.match(sync.message.message, /En respuesta a Julia: Revisar la imagen/);
  assert.match(sync.message.message, /Está aprobada/);
  assert.equal(sync.entry.corState, "waiting");
  await assert.rejects(f.call(panel.submit, { ...args, replyTo: undefined }));
});

test("replies reject missing, other-task and externally hidden parents", async () => {
  const f = fixture();
  f.put("taskMessages", { _id: "foreign", taskId: "task2", source: "external_panel", message: "Private" });
  f.put("taskMessages", { _id: "hidden", taskId: "task1", source: "internal", message: "Private" });
  for (const replyTo of ["missing", "foreign", "hidden"]) {
    await assert.rejects(f.call(panel.submit, { taskId: "task1", key: replyTo, text: "Reply", uploadIds: [], replyTo }));
  }
  assert.equal(Array.from(f.rows.values()).filter(row => row._table === "taskPanelEntries").length, 0);
});

test("rejects a reply to a reply and hides client labels from external viewers", async () => {
  const f = fixture();
  const first = await f.call(panel.submit, { taskId: "task1", key: "root", text: "First", uploadIds: [] });
  const rootId = f.rows.get(first).messageId;
  const second = await f.call(panel.submit, { taskId: "task1", key: "child", text: "Reply", uploadIds: [], replyTo: rootId });
  await assert.rejects(f.call(panel.submit, { taskId: "task1", key: "nested", text: "Nested", uploadIds: [], replyTo: f.rows.get(second).messageId }));
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(detail.viewerIsExternal, true);
  assert.ok(detail.comments.every((comment: any) => !comment.isClient));
});

test("structured agent quotes are returned separately from comment text", async () => {
  const f = fixture();
  f.put("taskMessages", { _id: "quoted", taskId: "task1", source: "external_agent", message: "Se solicita cambiar la imagen.", userQuote: "Usá esta imagen", createdAt: 1 });
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(detail.comments[0].quote, "Usá esta imagen");
  assert.equal(detail.comments[0].text, "Se solicita cambiar la imagen.");
});

test("only internal viewers see client labels on external comments", async () => {
  const f = fixture();
  f.ctx.auth.getUserIdentity = async () => ({ subject: "internal1|session" });
  f.put("corClients", { _id: "client1", corClientId: f.rows.get("task1").corClientId });
  f.put("clientUserAssignments", { _id: "access", userId: "internal1", clientId: "client1" });
  f.put("taskMessages", { _id: "client-comment", taskId: "task1", userId: "user1", source: "external_panel", message: "Hola", createdAt: 1 });
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(detail.viewerIsExternal, false);
  assert.equal(detail.comments[0].isClient, true);
});

test("board dialog exposes only the authorized task label and member names", async () => {
  const f = fixture();
  f.put("users", { _id: "member1", name: "Ximena Torres", email: "private@example.com" });
  f.put("subBrands", { _id: "brand1", name: "Marca", trelloLabelName: "Marca Corporativa", trelloLabelColor: "orange" });
  Object.assign(f.rows.get("task1"), { subBrandId: "brand1", corCollaboratorUserIds: ["member1"] });
  const result = await f.call(tasks.getBoardDialogDetails, { taskId: "task1" });
  assert.deepEqual(result, { label: { name: "Marca Corporativa", color: "orange" }, members: [{ id: "member1", name: "Ximena Torres" }] });
  f.rows.get("task1").createdBy = "another-user";
  assert.equal(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), null);
});

test("external users and already published COR tasks reject dialog edits", async () => {
  const f = fixture();
  await assert.rejects(f.call(tasks.updateTaskFields, { taskId: "task1", updates: { title: "Changed" } }));
  f.rows.delete("external1");
  for (const published of [{ corTaskId: "123", corSyncStatus: "error" }, { corTaskId: undefined, corSyncStatus: "synced" }]) {
    Object.assign(f.rows.get("task1"), published);
    await assert.rejects(f.call(tasks.updateTaskFields, { taskId: "task1", updates: { title: "Changed" } }), /solo lectura/);
    assert.equal(f.rows.get("task1").title, "Original");
  }
});

function notificationFixture() {
  const f = fixture();
  f.put("users", { _id: "user1", name: "Externo" });
  f.put("users", { _id: "internal1", name: "Interno" });
  f.put("users", { _id: "internal2", name: "Colega" });
  f.put("users", { _id: "otherExternal", name: "Otro externo" });
  f.put("approvedExternalUsers", { _id: "external2", userId: "otherExternal" });
  f.put("corClients", { _id: "client1", corClientId: 99 });
  f.put("clientBrands", { _id: "brand1", clientId: "client1" });
  f.put("clientBrands", { _id: "brand2", clientId: "client1" });
  Object.assign(f.rows.get("task1"), { clientId: "client1", corClientId: 99, clientBrandId: "brand1" });
  for (const id of ["internal1", "internal2", "otherExternal"]) f.put("clientUserAssignments", { _id: `assignment-${id}`, userId: id, clientId: "client1" });
  f.put("clientUserAssignments", { _id: "wrong-brand", userId: "wrongBrandUser", clientId: "client1", brandId: "brand2" });
  const as = (id: string) => { f.ctx.auth.getUserIdentity = async () => ({ subject: `${id}|session` }); };
  const post = (key: string, replyTo?: string) => f.call(panel.submit, { taskId: "task1", key, text: "Nuevo comentario", uploadIds: [], replyTo });
  const unread = () => f.call(notifications.unread, {});
  return { ...f, as, post, unread };
}

test("notifications target authorized internal users and only the external creator for internal comments", async () => {
  const f = notificationFixture();
  f.as("internal1");
  await f.post("one");
  const rows = [...f.rows.values()].filter(r => r._table === "commentNotifications");
  assert.deepEqual(rows.map(r => r.userId).sort(), ["internal2", "user1"]);
  await f.post("one"); // retried submission cannot notify twice
  assert.equal([...f.rows.values()].filter(r => r._table === "commentNotifications").length, 2);
  f.as("user1");
  assert.equal((await f.unread())[0].count, 1);
  await f.post("external-comment");
  assert.equal((await f.unread())[0].count, 1); // own comment excluded
  f.as("otherExternal");
  assert.deepEqual(await f.unread(), []);
  f.as("wrongBrandUser");
  assert.deepEqual(await f.unread(), []);
});

test("read acknowledgments are individual, limited to displayed IDs, and revalidate revoked access", async () => {
  const f = notificationFixture(); f.as("internal1");
  await f.post("one"); await f.post("two");
  f.as("user1");
  const [group] = await f.unread();
  await f.call(notifications.markRead, { taskId: "task1", messageIds: [group.messageIds[0]] });
  assert.equal((await f.unread())[0].count, 1);
  f.as("internal2");
  assert.equal((await f.unread())[0].count, 2);
  f.rows.delete("assignment-internal2");
  assert.deepEqual(await f.unread(), []);
  await f.call(notifications.markRead, { taskId: "task1", messageIds: group.messageIds });
  assert.equal([...f.rows.values()].filter(r => r._table === "commentNotifications" && r.userId === "internal2" && !r.read).length, 2);
  f.as("user1"); f.rows.get("task1").createdBy = "otherExternal";
  assert.deepEqual(await f.unread(), []);
});

test("internal replies notify the external author; imported comments never notify externals", async () => {
  const f = notificationFixture(); f.as("user1");
  const entry = await f.post("question");
  f.as("internal1"); await f.post("answer", f.rows.get(entry).messageId);
  f.as("user1"); assert.equal((await f.unread())[0].count, 1);
  f.put("taskMessages", { _id: "imported", taskId: "task1", source: "trello", message: "From Trello", createdAt: Date.now() });
  await notifyTaskComment(f.ctx, "imported" as any);
  await notifyTaskComment(f.ctx, "imported" as any);
  assert.equal((await f.unread())[0].count, 1);
  f.as("internal2");
  const rows = await f.unread();
  assert.equal(rows[0].messageIds.filter((id: string) => id === "imported").length, 1);
  f.rows.get("task1").convexStatus = "deleted";
  assert.deepEqual(await f.unread(), []);
});

test("new external tasks notify only authorized internals, once per task and recipient", async () => {
  const f = notificationFixture();
  f.put("clientUserAssignments", { _id: "other-client", userId: "unrelated", clientId: "client2" });
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const rows = [...f.rows.values()].filter(r => r._table === "taskCreationNotifications");
  assert.deepEqual(rows.map(r => r.userId).sort(), ["internal1", "internal2"]);
  f.as("user1"); assert.deepEqual(await f.call(taskNotifications.unread, {}), []);
  f.as("internal1"); assert.equal((await f.call(taskNotifications.unread, {})).length, 1);
  await f.call(taskNotifications.markRead, { taskId: "task1" });
  assert.deepEqual(await f.call(taskNotifications.unread, {}), []);
  f.as("internal2"); assert.equal((await f.call(taskNotifications.unread, {})).length, 1);
  f.rows.delete("assignment-internal2");
  assert.deepEqual(await f.call(taskNotifications.unread, {}), []);
  await f.call(taskNotifications.markRead, { taskId: "task1" });
  const revoked = rows.find(r => r.userId === "internal2");
  assert.equal(revoked.read, false);
  assert.equal(await f.call(taskNotifications.claimEmail, { id: revoked._id }), null);
  assert.equal(revoked.emailState, "cancelled");
  const other = notificationFixture(); other.rows.get("task1").createdBy = "internal1";
  await notifyExternalTaskCreated(other.ctx, "task1" as any);
  assert.equal([...other.rows.values()].filter(r => r._table === "taskCreationNotifications").length, 0);
});

test("creation email retries keep payload and idempotency key, suppress concurrent sends and respect expiry", async () => {
  const f = notificationFixture();
  f.rows.get("internal1").email = "internal@example.com";
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const row = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "internal1");
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  const originalFetch = globalThis.fetch;
  const calls: any[] = [];
  try {
    process.env.APP_URL = "https://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    globalThis.fetch = (async (_url: any, init: any) => { calls.push(init); return new Response(JSON.stringify(calls.length === 1 ? { name: "rate_limit_exceeded" } : { id: "email-1" }), { status: calls.length === 1 ? 429 : 200 }); }) as typeof fetch;
    await f.call(taskNotifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "pending"); assert.equal(calls.length, 1);
    await f.call(taskNotifications.sendEmail, { id: row._id });
    assert.equal(calls.length, 1); // wait for backoff
    row.nextAttemptAt = 0; f.rows.get("task1").title = "Edited after first attempt";
    await f.call(taskNotifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "sent"); assert.equal(row.resendId, "email-1");
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
    await f.call(taskNotifications.sendEmail, { id: row._id }); assert.equal(calls.length, 2);
    row.emailState = "sending"; row.nextAttemptAt = Date.now() + 120000;
    assert.equal(await f.call(taskNotifications.claimEmail, { id: row._id }), null);
    row.nextAttemptAt = 0; row.firstAttemptAt = Date.now() - 23 * 60 * 60 * 1000;
    assert.equal(await f.call(taskNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("email configuration waits safely; changed address and revoked rights prevent delivery", async () => {
  const f = notificationFixture(); f.rows.get("internal1").email = "internal@example.com";
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const row = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "internal1");
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  try {
    process.env.APP_URL = "http://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    assert.equal(await f.call(taskNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "pending"); assert.equal(row.attempts, 0);
    process.env.APP_URL = "https://app.example.com"; row.nextAttemptAt = 0;
    const claim = await f.call(taskNotifications.claimEmail, { id: row._id }); assert.ok(claim);
    await f.call(taskNotifications.finishEmail, { id: row._id, attempt: claim.attempt + 1, resendId: "stale", retry: false });
    assert.equal(row.emailState, "sending");
    row.nextAttemptAt = 0; f.rows.get("internal1").email = "changed@example.com";
    assert.equal(await f.call(taskNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "cancelled");
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("creation email escapes untrusted content and links directly to authenticated task tab", () => {
  const args = { from: "sender@example.com", to: "recipient@example.com", baseUrl: "https://app.example.com", taskId: "task1", title: "<script>alert(1)</script>", author: "Someone & another", client: "Client" };
  const email = taskCreationEmail(args);
  assert.ok(!email.html.includes("<script>")); assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(email.text.includes("https://app.example.com/workspace/control-panel?taskId=task1&tab=task"));
  const localEmail = taskCreationEmail({ ...args, baseUrl: "http://localhost:3000" });
  assert.ok(localEmail.text.includes("http://localhost:3000/workspace/control-panel?taskId=task1&tab=task"));
  for (const baseUrl of ["http://app.example.com", "http://localhost.evil.example", "javascript:alert(1)"]) assert.throws(() => taskCreationEmail({ ...args, baseUrl }));
});

test("notification history paginates mixed read/unread records, survives reads, and rechecks access", async () => {
  const f = notificationFixture();
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const created = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "internal2");
  created.createdAt = 105;
  for (let i = 0; i < 11; i++) {
    f.put("taskMessages", { _id: `history-message-${i}`, taskId: "task1", userId: "internal1", source: "internal_panel" });
    f.put("commentNotifications", { _id: `history-${i}`, userId: "internal2", taskId: "task1", messageId: `history-message-${i}`, read: i % 2 === 0, createdAt: 100 + Math.floor(i / 2) });
  }
  // Invalid records cannot fill a page or leak titles.
  f.put("commentNotifications", { _id: "missing-message", userId: "internal2", taskId: "task1", messageId: "missing", read: false, createdAt: 200 });
  f.as("internal2");
  const list = (cursor: string | null = null) => f.call(history.list, { paginationOpts: { numItems: 5, cursor } });
  const first = await list();
  assert.equal(first.page.length, 5);
  assert.ok(first.page.some((r: any) => r.read)); assert.ok(first.page.some((r: any) => !r.read));
  await f.call(taskNotifications.markRead, { taskId: "task1" });
  const afterRead = await list();
  assert.deepEqual(afterRead.page.map((r: any) => r.id), first.page.map((r: any) => r.id));
  assert.equal(afterRead.page.find((r: any) => r.kind === "task").read, true);
  const second = await list(first.continueCursor);
  assert.equal(second.page.length, 5);
  const third = await list(second.continueCursor);
  const all = [...first.page, ...second.page, ...third.page];
  assert.equal(all.length, 12); assert.equal(new Set(all.map(r => r.id)).size, 12);
  assert.ok(all.every((r, i) => i === 0 || all[i - 1].createdAt >= r.createdAt));
  if (!third.isDone) assert.equal((await list(third.continueCursor)).isDone, true);
  f.rows.delete("assignment-internal2");
  assert.deepEqual((await list()).page, []);
  assert.deepEqual((await list(first.continueCursor)).page, []);
  f.as("otherExternal"); assert.deepEqual((await list()).page, []);
  f.ctx.auth.getUserIdentity = async () => null;
  assert.deepEqual((await list()).page, []);
});

test("external notification history retains read comments only for the external task owner", async () => {
  const f = notificationFixture(); f.as("internal1"); await f.post("history-comment");
  f.as("user1");
  const [group] = await f.unread();
  await f.call(notifications.markRead, { taskId: "task1", messageIds: group.messageIds });
  const args = { paginationOpts: { numItems: 5, cursor: null } };
  const result = await f.call(history.list, args);
  assert.equal(result.page.length, 1); assert.equal(result.page[0].read, true); assert.equal(result.page[0].external, true);
  f.rows.get("task1").createdBy = "otherExternal";
  assert.deepEqual((await f.call(history.list, args)).page, []);
});

test("external requests and notifications require the configured client, regardless of category", async () => {
  const f = notificationFixture();
  f.rows.get("assignment-user1").brandId = "brand2";
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), true);
  f.as("internal1"); await f.post("enabled-client");
  f.as("user1"); assert.equal((await f.unread()).length, 1);
  // Existing read and unread records disappear after changing the configured client.
  clientConfig.ui.externalRequestsClientIds = ["client2"];
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
  assert.deepEqual(await f.unread(), []);
  assert.deepEqual((await f.call(history.list, { paginationOpts: { numItems: 5, cursor: null } })).page, []);
  assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), []);
  await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
  assert.equal(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), null);
  f.as("internal1"); await assert.rejects(f.post("disabled-client"), /acceso/);
  assert.equal([...f.rows.values()].filter(r => r._table === "commentNotifications" && r.userId === "user1").length, 1);
  f.as("internal2"); assert.deepEqual(await f.unread(), []);
  clientConfig.ui.externalRequestsClientIds = ["client1"];
  f.rows.get("task1").clientBrandId = undefined;
  f.rows.get("task1").clientId = "client2";
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), false);
  f.rows.get("task1").clientId = "client1";
  f.rows.delete("assignment-user1");
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), false);
  clientConfig.ui.externalRequestsClientIds = [];
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
});

test("internal comments tab requires the enabled task client and existing task permissions", async () => {
  const f = notificationFixture(); f.as("internal1");
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
  await f.post("allowed");
  f.as("wrongBrandUser");
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
  f.as("internal1"); clientConfig.ui.externalRequestsClientIds = ["client2"];
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
  assert.deepEqual(await f.call(tasks.listInternalTaskComments, { taskId: "task1" }), []);
  await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
  await assert.rejects(f.post("denied"), /acceso/);
  // General task access and new-task notifications stay independent of comments.
  assert.ok(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }));
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  assert.equal((await f.call(taskNotifications.unread, {})).length, 1);
  clientConfig.ui.externalRequestsClientIds = [];
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
});

test("multiple enabled clients preserve per-client assignment, task ownership and notification access", async () => {
  const f = notificationFixture();
  clientConfig.ui.externalRequestsClientIds = ["client1", " client2 ", "client1", ""];
  f.put("corClients", { _id: "client2", corClientId: 100 });
  f.put("clientUserAssignments", { _id: "internal-client2", clientId: "client2", userId: "internal1" });
  f.put("tasks", { ...f.rows.get("task1"), _id: "task2", clientBrandId: undefined, clientId: "client2", corClientId: 100 });
  f.as("user1");
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task2")), false);
  f.put("clientUserAssignments", { _id: "external-client2", clientId: "client2", userId: "user1", brandId: "any-category" });
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task2")), true);
  f.as("internal1");
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
  assert.equal(await f.call(panel.canAccessComments, { taskId: "task2" }), true);
  await f.call(panel.submit, { taskId: "task2", key: "multi-client", text: "Hello", uploadIds: [] });
  f.as("user1"); assert.equal((await f.unread())[0].taskId, "task2");
  f.rows.delete("external-client2");
  assert.deepEqual(await f.unread(), []);
  f.rows.get("task2").createdBy = "otherExternal";
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task2")), false);
  clientConfig.ui.externalRequestsClientIds = [];
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
  f.as("internal1"); assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
});
