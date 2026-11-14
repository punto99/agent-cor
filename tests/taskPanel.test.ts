import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as panel from "../convex/data/taskPanel";
import * as sender from "../convex/data/taskPanelSync";
import * as tasks from "../convex/data/tasks";
import * as threads from "../convex/messaging/threads";
import { hasExternalRequestsAccess, canViewExternalRequest } from "../convex/lib/externalRequestsAccess";
import * as history from "../convex/data/notificationHistory";
import * as notifications from "../convex/data/commentNotifications";
import * as taskNotifications from "../convex/data/taskCreationNotifications";
import * as statusNotifications from "../convex/data/taskStatusNotifications";
import { patchTaskWithStatusNotification, taskStatusEmail } from "../convex/lib/taskStatusNotifications";
import { applyInboundTaskUpdate } from "../convex/data/corInboundSync";
import { applySafeInboundCardUpdate, processWebhookEvent } from "../convex/data/trello";
import { canReceiveTaskCreation, notifyExternalTaskCreated, taskCreationEmail } from "../convex/lib/taskCreationNotifications";
import { notifyTaskComment, commentEmail } from "../convex/lib/commentNotifications";
import { clientConfig } from "../config/tenant.config";
import { setInternalUserRoles } from "../convex/data/internalUserAdmin";
import { setExternalUserRoles } from "../convex/data/externalUserAdmin";
import { listMyClientProjects } from "../convex/data/controlPanel";

// A small transactional Convex context double; tests run real handlers/helpers.
function fixture() {
  let counter = 0;
  const rows = new Map<string, any>();
  const scheduled: any[] = [];
  const put = (table: string, doc: any) => { rows.set(doc._id, { _table: table, _creationTime: 1, ...doc }); return doc._id; };
  put("approvedExternalUsers", { _id: "external1", userId: "user1" });
  put("corClients", { _id: "client1", externalBoardEnabled: true, corClientId: clientConfig.ui.trelloPublishCorClientIds[0] });
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
  const modules: any = { "data/taskPanel": panel, "data/taskPanelSync": sender, "data/tasks": tasks, "data/taskCreationNotifications": taskNotifications, "data/commentNotifications": notifications, "data/taskStatusNotifications": statusNotifications };
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
  f.put("corClients", { _id: "client1", externalBoardEnabled: true, corClientId: f.rows.get("task1").corClientId });
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
  f.put("corClients", { _id: "client1", externalBoardEnabled: true, corClientId: f.rows.get("task1").corClientId });
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
  f.put("corClients", { _id: "client1", externalBoardEnabled: true, corClientId: f.rows.get("task1").corClientId });
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
  assert.deepEqual(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), result);
  f.rows.delete("assignment-user1");
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

test("quantity edits adjust only the delta and keep published tasks read-only", async () => {
  const f = fixture();
  f.rows.delete("external1");
  Object.assign(f.rows.get("task1"), { projectId: "project1", deliverablesCount: 2 });
  f.put("projects", { _id: "project1", deliverables: 10, corProjectId: 123, corSyncStatus: "synced" });
  await f.call(tasks.updateTaskFields, { taskId: "task1", updates: { deliverablesCount: 5 } });
  assert.equal(f.rows.get("project1").deliverables, 13);
  assert.equal(f.rows.get("task1").deliverablesCount, 5);
  assert.deepEqual(f.rows.get("task1").projectDeliverableAllocation, { amount: 5, trackedOnProject: false });
  await f.call(tasks.updateTaskFields, { taskId: "task1", updates: { deliverablesCount: 5 } });
  assert.equal(f.rows.get("project1").deliverables, 13);
  assert.equal(f.scheduled.length, 0);
  await f.call(tasks.updateTaskFields, { taskId: "task1", updates: { deliverablesCount: 1 } });
  assert.equal(f.rows.get("project1").deliverables, 9);
  assert.equal(f.scheduled.length, 0);
  // Published tasks still reject quantity edits, preserving both records.
  f.rows.get("task1").corTaskId = "456";
  await assert.rejects(f.call(tasks.updateTaskFields,
    { taskId: "task1", updates: { deliverablesCount: 6 } }), /solo lectura/);
  assert.equal(f.rows.get("project1").deliverables, 9);
  assert.equal(f.rows.get("task1").deliverablesCount, 1);
});

test("task and project quantities roll back together if saving the task fails", async () => {
  const f = fixture();
  f.rows.delete("external1");
  Object.assign(f.rows.get("task1"), { projectId: "project1", deliverablesCount: 2 });
  f.put("projects", { _id: "project1", deliverables: 8 });
  const patch = f.ctx.db.patch;
  f.ctx.db.patch = async (id: string, data: any) => {
    if (id === "task1") throw new Error("Simulated task write failure");
    return patch(id, data);
  };
  await assert.rejects(f.call(tasks.updateTaskFields,
    { taskId: "task1", updates: { deliverablesCount: 5 } }), /Simulated task write failure/);
  assert.equal(f.rows.get("project1").deliverables, 8);
  assert.equal(f.rows.get("task1").deliverablesCount, 2);
});

function notificationFixture() {
  const f = fixture();
  f.put("users", { _id: "user1", name: "Externo" });
  f.put("users", { _id: "internal1", name: "Interno" });
  f.put("users", { _id: "internal2", name: "Colega" });
  f.put("users", { _id: "otherExternal", name: "Otro externo" });
  f.put("approvedExternalUsers", { _id: "external2", userId: "otherExternal" });
  f.put("corClients", { _id: "client1", externalBoardEnabled: true, corClientId: 99 });
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

test("external coordinator gets new-task notifications only for already-visible tasks, without changing board or detail", async () => {
  const f = notificationFixture();
  f.as("otherExternal");
  const board = await f.call(tasks.listMyExternalRequests, {});
  const detail = await f.call(panel.detail, { taskId: "task1" });
  const adminId = "platform-admin";
  f.put("users", { _id: adminId });
  f.put("userAccessProfiles", { _id: "platform-admin-role", userId: adminId, platformRole: "admin" });
  f.as(adminId);
  await f.call(setExternalUserRoles, { approvedExternalUserId: "external2", isCoordinator: true });
  f.as("otherExternal");
  assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), board);
  assert.deepEqual(await f.call(panel.detail, { taskId: "task1" }), detail);
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const rows = [...f.rows.values()].filter(r => r._table === "taskCreationNotifications");
  assert.deepEqual(rows.map(r => r.userId).sort(), ["internal1", "internal2", "otherExternal"]);
  assert.equal((await f.call(taskNotifications.unread, {})).length, 1);
  const page = await f.call(history.list, { paginationOpts: { numItems: 5, cursor: null } });
  assert.equal(page.page[0].external, true);
  assert.equal(page.page[0].kind, "task");
  await f.call(taskNotifications.markRead, { taskId: "task1" });
  assert.deepEqual(await f.call(taskNotifications.unread, {}), []);
  assert.equal((await f.call(history.list, { paginationOpts: { numItems: 5, cursor: null } })).page[0].read, true);
});

test("stored internal work and platform roles preserve existing boards, task access and details", async () => {
  const f = notificationFixture();
  f.rows.get("client1").name = "Cliente";
  f.rows.get("brand1").name = "Categoría A";
  f.rows.get("brand2").name = "Categoría B";
  f.as("internal1");
  const snapshot = async () => ({
    board: await f.call(listMyClientProjects, {}),
    task: await f.call(tasks.getTask, { taskId: "task1" }),
    detail: await f.call(panel.detail, { taskId: "task1" }),
  });
  const before = await snapshot();
  const adminId = "platform-admin";
  f.put("users", { _id: adminId });
  f.put("userAccessProfiles", { _id: "platform-admin-role", userId: adminId, platformRole: "admin" });
  f.as(adminId);
  await f.call(setInternalUserRoles, { targetUserId: "internal1", platformRole: "admin", workRole: "Cuentas" });
  f.as("internal1");
  assert.deepEqual(await snapshot(), before);
  assert.equal(await canViewExternalRequest(f.ctx, "internal1" as any, f.rows.get("task1")), false);
});

test("coordinator designation never expands category, client or feature access and excludes own tasks", async () => {
  for (const denied of ["own", "category", "client", "disabled-client", "internal-task", "deleted", "archived"]) {
    const f = notificationFixture();
    f.rows.get("external2").isCoordinator = true;
    if (denied === "own") f.rows.get("task1").createdBy = "otherExternal";
    if (denied === "category") f.rows.get("assignment-otherExternal").brandId = "brand2";
    if (denied === "client") f.rows.get("assignment-otherExternal").clientId = "other-client";
    if (denied === "disabled-client") f.rows.get("client1").externalBoardEnabled = false;
    if (denied === "internal-task") f.rows.get("task1").source = "internal";
    if (["deleted", "archived"].includes(denied)) f.rows.get("task1").convexStatus = denied;
    assert.equal(await canReceiveTaskCreation(f.ctx, "otherExternal" as any, f.rows.get("task1")), false, denied);
    await notifyExternalTaskCreated(f.ctx, "task1" as any);
    assert.equal([...f.rows.values()].filter(r => r._table === "taskCreationNotifications" && r.userId === "otherExternal").length, 0, denied);
    f.rows.get("client1").externalBoardEnabled = true;
  }
});

test("removing coordinator designation or assignments hides queued notifications and cancels email", async () => {
  for (const revoke of ["role", "assignment"]) {
    const f = notificationFixture();
    f.rows.get("external2").isCoordinator = true;
    await notifyExternalTaskCreated(f.ctx, "task1" as any);
    const row = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "otherExternal");
    if (revoke === "role") f.rows.get("external2").isCoordinator = false;
    else f.rows.delete("assignment-otherExternal");
    f.as("otherExternal");
    assert.deepEqual(await f.call(taskNotifications.unread, {}), []);
    assert.deepEqual((await f.call(history.list, { paginationOpts: { numItems: 5, cursor: null } })).page, []);
    assert.equal(await f.call(taskNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "cancelled");
  }
});

test("coordinator emails use the existing external task panel", async () => {
  const f = notificationFixture();
  f.rows.get("external2").isCoordinator = true;
  f.rows.get("otherExternal").email = "coordinator@example.com";
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  const row = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "otherExternal");
  const saved = { RESEND_API_KEY: process.env.RESEND_API_KEY, APP_URL: process.env.APP_URL };
  process.env.RESEND_API_KEY = "test";
  process.env.APP_URL = "https://app.example.com";
  try {
    const claim = await f.call(taskNotifications.claimEmail, { id: row._id });
    const email = JSON.parse(claim.payload);
    assert.match(email.text, /https:\/\/app.example.com\/workspace\/requests\?taskId=task1/);
    assert.ok(!email.text.includes("control-panel"));
    assert.deepEqual(email.to, ["coordinator@example.com"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
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

test("external requests require an enabled client and matching brand permissions", async () => {
  const f = notificationFixture();
  f.rows.get("assignment-user1").brandId = "brand2";
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), false);
  f.rows.get("assignment-user1").brandId = "brand1";
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), true);
  f.as("internal1"); await f.post("enabled-client");
  f.as("user1"); assert.equal((await f.unread()).length, 1);
  // Existing read and unread records disappear after changing the configured client.
  f.rows.get("client1").externalBoardEnabled = false;
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
  assert.deepEqual(await f.unread(), []);
  assert.deepEqual((await f.call(history.list, { paginationOpts: { numItems: 5, cursor: null } })).page, []);
  assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), []);
  await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
  assert.equal(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), null);
  f.as("internal1"); await f.post("disabled-client");
  assert.equal([...f.rows.values()].filter(r => r._table === "commentNotifications" && r.userId === "user1").length, 1);
  f.as("internal2"); assert.equal((await f.unread())[0].count, 2);
  f.rows.get("client1").externalBoardEnabled = true;
  f.rows.get("task1").clientBrandId = undefined;
  f.rows.get("task1").clientId = "client2";
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), false);
  f.rows.get("task1").clientId = "client1";
  f.rows.delete("assignment-user1");
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), false);
  f.rows.get("client1").externalBoardEnabled = false;
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
});

test("external board configuration never changes internal boards, comments or notifications", async () => {
  for (const enabled of [true, false, undefined]) {
    const f = notificationFixture(); f.as("internal1");
    f.rows.get("client1").name = "Cliente";
    f.rows.get("brand1").name = "Categoría A";
    f.rows.get("brand2").name = "Categoría B";
    const originalBoard = await f.call(listMyClientProjects, {});
    assert.ok(originalBoard.length > 0);
    if (enabled === undefined) delete f.rows.get("client1").externalBoardEnabled;
    else f.rows.get("client1").externalBoardEnabled = enabled;
    assert.deepEqual(await f.call(listMyClientProjects, {}), originalBoard);
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
    await f.post("allowed");
    assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" })).length, 1);
    assert.equal((await f.call(panel.detail, { taskId: "task1" })).comments.length, 1);
    assert.ok(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }));
    await notifyExternalTaskCreated(f.ctx, "task1" as any);
    assert.equal((await f.call(taskNotifications.unread, {})).length, 1);
    f.as("internal2"); assert.equal((await f.unread())[0].count, 1);
    f.as("wrongBrandUser");
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
    assert.deepEqual(await f.call(tasks.listInternalTaskComments, { taskId: "task1" }), []);
    await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
    await assert.rejects(f.post("denied"), /acceso/);
    f.as("user1");
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), enabled === true);
  }
});

test("multiple enabled clients preserve per-client assignment and notification access", async () => {
  const f = notificationFixture();
  f.put("corClients", { _id: "client2", externalBoardEnabled: true, corClientId: 100 });
  f.put("clientUserAssignments", { _id: "internal-client2", clientId: "client2", userId: "internal1" });
  f.put("tasks", { ...f.rows.get("task1"), _id: "task2", clientBrandId: undefined, clientId: "client2", corClientId: 100 });
  f.as("user1");
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task1")), true);
  assert.equal(await canViewExternalRequest(f.ctx, "user1" as any, f.rows.get("task2")), false);
  f.put("clientUserAssignments", { _id: "external-client2", clientId: "client2", userId: "user1" });
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
  f.rows.get("client1").externalBoardEnabled = false;
  assert.equal(await hasExternalRequestsAccess(f.ctx, "user1" as any), false);
  f.as("internal1"); assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
});

// Collaborators use client/category permissions, independently of task origin.
function collaboratorFixture() {
  const f = fixture();
  f.ctx.auth.getUserIdentity = async () => ({ subject: "viewer|session" });
  const member = (
    id: string,
    clientId = "client1",
    brandId?: string,
    resolved = true,
    corRoleId?: number,
    corUserId = id.length + 100,
  ) => {
    f.put("users", { _id: id, name: `Member ${id}`, email: `${id}@example.com` });
    f.put("clientUserAssignments", { _id: `access-${id}`, userId: id, clientId, brandId });
    if (resolved) f.put("corUsers", { _id: `cor-${id}`, userId: id, corUserId, corEmail: `${id}@example.com`, corFirstName: "Member", corLastName: id, corRoleId });
  };
  member("viewer");
  member("full");
  member("category-a", "client1", "category1");
  member("category-b", "client1", "category2");
  member("foreign", "client2");
  member("external");
  member("unresolved", "client1", undefined, false);
  f.put("approvedExternalUsers", { _id: "external-member", userId: "external" });
  f.put("clientUserAssignments", { _id: "duplicate-full", userId: "full", clientId: "client1", brandId: "category1" });
  f.put("clientUserAssignments", { _id: "deleted-user", userId: "deleted", clientId: "client1" });
  f.put("clientBrands", { _id: "category1", clientId: "client1" });
  f.put("clientBrands", { _id: "category2", clientId: "client1" });
  f.rows.get("task1").clientBrandId = "category1";
  return { ...f, member };
}

test("automatic collaborators include only internal users with full client or matching category access for either origin", async () => {
  const f = collaboratorFixture();
  for (const source of ["external", "internal"]) {
    f.rows.get("task1").source = source;
    const result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
    assert.deepEqual(result.collaborators.map((c: any) => c.userId).sort(), ["category-a", "full", "unresolved", "viewer"]);
    assert.equal(result.customized, false);
    assert.equal(result.collaborators.find((c: any) => c.userId === "unresolved").availableInCOR, false);
  }
  // Client resolution also works when the task only carries COR's client ID.
  delete f.rows.get("task1").clientBrandId;
  delete f.rows.get("task1").clientId;
  const result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
  assert.deepEqual(result.collaborators.map((c: any) => c.userId).sort(), ["full", "unresolved", "viewer"]);
});

test("collaborator search and mutation cannot select external, foreign, or other-category users", async () => {
  const f = collaboratorFixture();
  f.rows.get("task1").corCollaboratorUserIds = [];
  const candidates = await f.call(tasks.searchTaskCorCollaboratorCandidates, { taskId: "task1", search: "Member" });
  assert.deepEqual(candidates.map((c: any) => c.userId).sort(), ["category-a", "full", "viewer"]);
  for (const userId of ["external", "foreign", "category-b", "deleted"]) {
    await assert.rejects(f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: [userId] }), /sin acceso/);
  }
  assert.deepEqual(f.rows.get("task1").corCollaboratorUserIds, []);
});

test("edited and empty collaborator selections persist without being refilled from assignments", async () => {
  const f = collaboratorFixture();
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["full", "full"] });
  f.member("new-member");
  let result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
  assert.deepEqual(result.collaborators.map((c: any) => c.userId), ["full"]);
  assert.equal(result.customized, true);
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: [] });
  result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
  assert.deepEqual(result.collaborators, []);
  assert.deepEqual(await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), { selectedUserIds: [], collaboratorUserIds: [], requiredCorUserIds: [], projectManagerCorUserIds: [], projectManagerCorUserId: undefined });
});

test("collaborator sync summary resolves accepted and rejected COR ids to readable names", async () => {
  const f = collaboratorFixture();
  f.member("accepted", "client1", "category1", true, 4, 701);
  f.member("rejected", "client1", "category1", true, 4, 702);
  f.rows.get("task1").corCollaboratorSyncStatus = "error";
  f.rows.get("task1").corCollaboratorSyncedCorUserIds = [701];
  f.rows.get("task1").corCollaboratorRejectedCorUserIds = [702];

  const result = await f.call(tasks.getTaskCollaboratorSyncSummary, {
    taskId: "task1",
  });

  assert.deepEqual(result, {
    synced: [{ corUserId: 701, name: "Member accepted" }],
    rejected: [{ corUserId: 702, name: "Member rejected" }],
  });
});

test("inactive internal users lose task access and are excluded from collaborators", async () => {
  const f = collaboratorFixture();
  f.member("inactive", "client1", "category1", true, 4, 703);
  f.rows.get("cor-inactive").isActive = false;

  const selection = await f.call(tasks.getTaskCorCollaborators, {
    taskId: "task1",
  });
  assert.equal(
    selection.collaborators.some((user: any) => user.userId === "inactive"),
    false,
  );

  f.ctx.auth.getUserIdentity = async () => ({ subject: "inactive|session" });
  assert.equal(await f.call(tasks.getTask, { taskId: "task1" }), null);
  assert.deepEqual(await f.call(tasks.listMyTasks, {}), []);

  f.put("chatThreads", {
    _id: "inactive-thread",
    threadId: "inactive-thread",
    userId: "inactive",
  });
  const preparation = await f.call(tasks.validateAndPrepareTask, {
    threadId: "inactive-thread",
    corClientId: f.rows.get("client1").corClientId,
    corUserId: 703,
    requireIntegration: true,
  });
  assert.equal(preparation.ok, false);
  assert.match(preparation.error, /inactivo/);
  await assert.rejects(
    f.call(tasks.getUserIdFromThread, { threadId: "inactive-thread" }),
    /inactivo/,
  );
});

test("COR leadership stays out, existing project PM wins and creator PM is the fallback", async () => {
  const f = collaboratorFixture();
  f.rows.delete("access-unresolved");
  f.member("c-level", "client1", "category1", true, 1, 101);
  f.member("director", "client1", "category1", true, 2, 201);
  f.member("project-manager", "client1", "category1", true, 3, 303);
  f.member("pm-two", "client1", "category1", true, 3, 302);
  f.member("worker", "client1", "category1", true, 4, 401);
  f.put("projects", { _id: "project1", pmId: 302 });
  f.rows.get("task1").projectId = "project1";
  f.rows.get("task1").createdBy = "project-manager";

  const displayed = await f.call(tasks.getTaskCorCollaborators, {
    taskId: "task1",
  });
  assert.ok(displayed.collaborators.some((c: any) => c.userId === "worker"));
  assert.ok(!displayed.collaborators.some((c: any) => c.userId === "c-level"));
  assert.ok(!displayed.collaborators.some((c: any) => c.userId === "director"));
  assert.ok(displayed.collaborators.some((c: any) => c.userId === "project-manager"));
  assert.ok(displayed.collaborators.some((c: any) => c.userId === "pm-two"));

  const selection = await f.call(
    tasks.getTaskCollaboratorSelectionInternal,
    { taskId: "task1" },
  );
  assert.ok(selection.collaboratorUserIds.includes("worker"));
  assert.ok(!selection.collaboratorUserIds.includes("c-level"));
  assert.ok(!selection.collaboratorUserIds.includes("director"));
  assert.ok(!selection.collaboratorUserIds.includes("project-manager"));
  assert.ok(!selection.collaboratorUserIds.includes("pm-two"));
  assert.ok(selection.selectedUserIds.includes("worker"));
  assert.ok(selection.selectedUserIds.includes("project-manager"));
  assert.ok(selection.selectedUserIds.includes("pm-two"));
  assert.ok(!selection.selectedUserIds.includes("c-level"));
  assert.ok(!selection.selectedUserIds.includes("director"));
  assert.deepEqual(selection.projectManagerCorUserIds, [302, 303]);
  assert.equal(selection.projectManagerCorUserId, 302);

  // Sin PM previo, el creador role 3 pasa a ser el PM principal.
  delete f.rows.get("project1").pmId;
  const creatorPmSelection = await f.call(
    tasks.getTaskCollaboratorSelectionInternal,
    { taskId: "task1" },
  );
  assert.equal(creatorPmSelection.projectManagerCorUserId, 303);

  // Si quien crea es colaborador y no hay PM previo, se elige otro role 3.
  f.rows.get("task1").createdBy = "worker";
  const collaboratorCreatorSelection = await f.call(
    tasks.getTaskCollaboratorSelectionInternal,
    { taskId: "task1" },
  );
  assert.equal(collaboratorCreatorSelection.projectManagerCorUserId, 302);

  f.rows.get("task1").corCollaboratorUserIds = [];
  const candidates = await f.call(
    tasks.searchTaskCorCollaboratorCandidates,
    { taskId: "task1", search: "Member" },
  );
  assert.ok(candidates.some((c: any) => c.userId === "worker"));
  assert.ok(!candidates.some((c: any) => c.userId === "c-level"));
  assert.ok(!candidates.some((c: any) => c.userId === "director"));
  assert.ok(candidates.some((c: any) => c.userId === "project-manager"));
  assert.ok(candidates.some((c: any) => c.userId === "pm-two"));
  await f.call(tasks.setTaskCorCollaborators, {
    taskId: "task1",
    userIds: ["project-manager"],
  });
  assert.deepEqual(
    (await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" }))
      .collaborators.map((c: any) => c.userId),
    ["project-manager"],
  );
  await assert.rejects(
    f.call(tasks.setTaskCorCollaborators, {
      taskId: "task1",
      userIds: ["director"],
    }),
    /C-Level o Director/,
  );
});

test("publishing collaborator resolution revalidates revoked access and category changes", async () => {
  const f = collaboratorFixture();
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["category-a"] });
  assert.deepEqual((await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" })).collaboratorUserIds, ["category-a"]);
  f.rows.get("task1").clientBrandId = "category2";
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /sin acceso/);
  f.rows.get("task1").clientBrandId = "category1";
  f.rows.delete("access-category-a");
  const result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
  assert.equal(result.collaborators[0].hasClientAccess, false);
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /sin acceso/);
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: [] });
});

test("automatic defaults stay current until edited and surface missing COR mappings and collaborator limits", async () => {
  const f = collaboratorFixture();
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /no resuelto/);
  f.rows.delete("access-unresolved");
  f.member("new-member");
  const resolved = await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" });
  assert.ok(resolved.collaboratorUserIds.includes("new-member"));
  for (let i = 0; i < 21; i++) f.member(`extra-${i}`);
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /máximo de 20/);
});

test("published tasks receive no assignment defaults and keep their stored collaborators and retry selection", async () => {
  const f = collaboratorFixture();
  for (const published of [{ corTaskId: "123", corSyncStatus: "error" }, { corTaskId: undefined, corSyncStatus: "synced" }]) {
    Object.assign(f.rows.get("task1"), published);
    delete f.rows.get("task1").corCollaboratorUserIds;
    assert.deepEqual((await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" })).collaborators, []);
    assert.deepEqual((await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" })).collaboratorUserIds, []);
    f.rows.get("task1").corCollaboratorUserIds = ["foreign"];
    assert.deepEqual((await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" })).collaboratorUserIds, ["foreign"]);
    await assert.rejects(f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["full"] }), /después de publicar/);
  }
  assert.equal(f.scheduled.length, 0);
});


test("users can remove automatic collaborators incrementally despite unresolved COR users or an oversized list", async () => {
  const f = collaboratorFixture();
  f.member("unresolved-two", "client1", undefined, false);
  for (let i = 0; i < 21; i++) f.member(`extra-${i}`);
  const result = await f.call(tasks.getTaskCorCollaborators, { taskId: "task1" });
  const remaining = result.collaborators.map((c: any) => c.userId).filter((id: string) => id !== "unresolved");
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: remaining });
  assert.deepEqual(f.rows.get("task1").corCollaboratorUserIds, remaining);
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /máximo de 20/);
});

test("multiple revoked collaborators can be removed individually but cannot be published or re-added", async () => {
  const f = collaboratorFixture();
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["category-a", "full", "viewer"] });
  f.rows.delete("access-category-a");
  f.rows.delete("access-full");
  f.rows.delete("duplicate-full");
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["full", "viewer"] });
  await assert.rejects(f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" }), /sin acceso/);
  await assert.rejects(f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["category-a", "full", "viewer"] }), /sin acceso/);
  await f.call(tasks.setTaskCorCollaborators, { taskId: "task1", userIds: ["viewer"] });
  assert.deepEqual((await f.call(tasks.getTaskCollaboratorSelectionInternal, { taskId: "task1" })).collaboratorUserIds, ["viewer"]);
});

test("external profile names appear in both comment views, notifications, history and email", async () => {
  const f = notificationFixture();
  f.rows.get("external1").name = "  Julia Pérez  ";
  // Auth profiles may contain a different name or no name at all.
  f.rows.get("user1").name = "Nombre desactualizado";
  await f.post("named-comment");
  const detail = () => f.call(panel.detail, { taskId: "task1" });
  assert.equal((await detail()).comments[0].authorName, "Julia Pérez");
  delete f.rows.get("user1").name;
  f.as("internal1");
  assert.equal((await detail()).comments[0].authorName, "Julia Pérez");
  assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" }))[0].author, "Julia Pérez");
  assert.equal((await f.unread())[0].author, "Julia Pérez");
  await notifyExternalTaskCreated(f.ctx, "task1" as any);
  assert.equal((await f.call(taskNotifications.unread, {}))[0].author, "Julia Pérez");
  const historyRows = (await f.call(history.list, { paginationOpts: { numItems: 10, cursor: null } })).page;
  assert.equal(historyRows.length, 2);
  assert.ok(historyRows.every((row: any) => row.author === "Julia Pérez"));
  const row = [...f.rows.values()].find(r => r._table === "taskCreationNotifications" && r.userId === "internal1");
  f.rows.get("internal1").email = "internal@example.com";
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  try {
    process.env.APP_URL = "https://app.example.com";
    process.env.RESEND_API_KEY = "test-only";
    const claim = await f.call(taskNotifications.claimEmail, { id: row._id });
    const email = JSON.parse(claim.payload);
    assert.ok(email.text.includes("Julia Pérez creó una nueva tarea."));
    assert.ok(email.html.includes("Julia Pérez creó una nueva tarea."));
    assert.ok(email.html.includes("<h2>Nueva tarea</h2>"));
    assert.ok(!/usuario externo|tarea externa/i.test(email.html));
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  await f.post("internal-named-comment");
  assert.ok((await detail()).comments.some((comment: any) => comment.authorName === "Interno"));
  f.as("user1");
  assert.ok((await detail()).comments.some((comment: any) => comment.authorName === "Interno"));
  assert.equal((await f.unread())[0].author, "Interno");
});

async function importTrelloComment(f: ReturnType<typeof notificationFixture>, authorFields: Record<string, unknown>) {
  const runQuery = f.ctx.runQuery;
  const runMutation = f.ctx.runMutation;
  const event = {
    status: "received", actionType: "commentCard", trelloCardId: "card1",
    payloadJson: JSON.stringify({ action: { id: "trello-comment-1", data: { text: "Comentario de Trello" }, ...authorFields } }),
  };
  f.ctx.runQuery = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "data/trello:getWebhookEventById") return event;
    if (name === "data/trello:getTrelloCardContextByCardId") return { task: f.rows.get("task1"), project: { _id: "project1" } };
    return runQuery(ref, args);
  };
  f.ctx.runMutation = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "data/trello:markWebhookEventStatus") { event.status = args.status; return; }
    if (name === "data/trello:recordInboundChange") return;
    return runMutation(ref, args);
  };
  try {
    const result = await f.call(processWebhookEvent, { eventId: "event1" });
    assert.equal(result.success, true);
    assert.equal(event.status, "processed");
    const comments = [...f.rows.values()].filter(row => row._table === "taskMessages");
    assert.equal(comments.length, 1);
    return comments[0];
  } finally {
    f.ctx.runQuery = runQuery;
    f.ctx.runMutation = runMutation;
  }
}

test("Trello webhook authors survive import without a platform account and appear across comment views", async () => {
  for (const sample of [
    { fields: { memberCreator: { id: " member1 ", fullName: "  Lucía Pérez  ", username: "lucia" } }, memberId: "member1", name: "Lucía Pérez" },
    { fields: { idMemberCreator: "member1", memberCreator: { fullName: " ", username: " lucia " } }, memberId: "member1", name: "lucia" },
    { fields: { idMemberCreator: "member1", memberCreator: { id: 42, fullName: null, username: "lucia" } }, memberId: "member1", name: "lucia" },
    { fields: {}, memberId: undefined, name: undefined },
  ]) {
    const f = notificationFixture();
    const message = await importTrelloComment(f, sample.fields);
    assert.equal(message.source, "trello");
    assert.equal(message.userId, undefined);
    assert.equal(message.trelloMemberId, sample.memberId);
    assert.equal(message.trelloAuthorName, sample.name);
    assert.equal((await f.call(panel.detail, { taskId: "task1" })).comments[0].authorName, sample.name ?? "Autor sin nombre");
    f.as("internal1");
    assert.equal((await f.call(panel.detail, { taskId: "task1" })).comments[0].authorName, sample.name ?? "Autor sin nombre");
    assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" }))[0].author, sample.name ?? "Autor sin nombre");
    assert.equal((await f.unread())[0].author, sample.name ?? "Autor sin nombre");
    const historyRows = (await f.call(history.list, { paginationOpts: { numItems: 10, cursor: null } })).page;
    assert.equal(historyRows[0].author, sample.name ?? "Autor sin nombre");
    // Repeated delivery does not duplicate the comment or its notifications.
    const notificationCount = [...f.rows.values()].filter(row => row._table === "commentNotifications").length;
    assert.equal((await importTrelloComment(f, sample.fields))._id, message._id);
    assert.equal([...f.rows.values()].filter(row => row._table === "commentNotifications").length, notificationCount);
  }
});

test("Trello author lookup failures still save the comment and finish the webhook", async t => {
  t.mock.method(console, "warn", () => {});
  for (const failure of ["sync", "async"]) {
    for (const trelloName of [undefined, "Nombre conservado de Trello"]) {
      const f = notificationFixture();
      const query = f.ctx.db.query;
      f.ctx.db.query = (table: string) => {
        const result = query(table);
        const withIndex = result.withIndex;
        result.withIndex = (index: string, build: any) => {
          if (table === "approvedExternalUsers" && index === "by_trello_member" && failure === "sync") {
            throw new Error("Author lookup unavailable");
          }
          const indexed = withIndex(index, build);
          if (table === "approvedExternalUsers" && index === "by_trello_member") {
            indexed.take = async () => { throw new Error("Author lookup unavailable"); };
          }
          return indexed;
        };
        return result;
      };
      const fields = { memberCreator: { id: "member1", fullName: trelloName } };
      const message = await importTrelloComment(f, fields);
      assert.equal(message.userId, undefined);
      assert.equal(message.message, "Comentario de Trello");
      assert.equal(message.trelloCommentId, "trello-comment-1");
      assert.equal(message.corMessageSyncStatus, "pending_cor_task");
      const [comment] = (await f.call(panel.detail, { taskId: "task1" })).comments;
      assert.equal(comment.authorName, trelloName ?? "Autor sin nombre");
      assert.equal(comment.own, false);
      f.as("internal1");
      assert.equal((await f.unread())[0].messageIds[0], message._id);
      assert.equal((await importTrelloComment(f, fields))._id, message._id);
    }
  }
});

test("author profile errors preserve comment display, notifications and reply context", async t => {
  t.mock.method(console, "warn", () => {});
  for (const failure of ["external-profile", "user-profile"]) {
    for (const trelloName of [undefined, "Nombre de Trello"]) {
      const f = notificationFixture();
      f.put("users", { _id: "trello-author", name: "Nombre del perfil" });
      f.put("taskMessages", { _id: "imported", taskId: "task1", source: "trello", userId: "trello-author", trelloAuthorName: trelloName, message: "Comentario guardado", createdAt: 1 });
      await notifyTaskComment(f.ctx, "imported" as any);
      if (failure === "external-profile") {
        // A duplicate profile makes the real unique lookup fail for this author only.
        f.put("approvedExternalUsers", { _id: "duplicate1", userId: "trello-author" });
        f.put("approvedExternalUsers", { _id: "duplicate2", userId: "trello-author" });
      } else {
        f.put("approvedExternalUsers", { _id: "external-author", userId: "trello-author" });
        const get = f.ctx.db.get;
        f.ctx.db.get = async (id: string) => {
          if (id === "trello-author") throw new Error("Author profile unavailable");
          return get(id);
        };
      }
      f.as("internal1");
      const [comment] = (await f.call(panel.detail, { taskId: "task1" })).comments;
      assert.equal(comment.authorName, trelloName ?? "Autor sin nombre");
      assert.equal(comment.isClient, failure === "user-profile");
      assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" }))[0].author, trelloName ?? "Autor sin nombre");
      assert.equal((await f.unread())[0].author, trelloName ?? "Autor sin nombre");
      const historyRows = (await f.call(history.list, { paginationOpts: { numItems: 10, cursor: null } })).page;
      assert.equal(historyRows[0].author, trelloName ?? "Autor sin nombre");
      const entryId = await f.post("reply-with-author-error", "imported");
      const context = await f.call(panel.syncContext, { entryId });
      assert.ok(context.message.message.startsWith(`En respuesta a ${trelloName ?? "Autor sin nombre"}:`));
      f.as("no-access");
      await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
    }
  }
});

test("comment persistence errors still fail instead of reporting a saved comment", async () => {
  const f = notificationFixture();
  const insert = f.ctx.db.insert;
  f.ctx.db.insert = async (table: string, data: any) => {
    if (table === "taskMessages") throw new Error("Comment storage unavailable");
    return insert(table, data);
  };
  await assert.rejects(f.call(tasks.createTaskMessageInternal, { taskId: "task1", source: "trello", message: "No guardado" }), /Comment storage unavailable/);
  assert.equal([...f.rows.values()].filter(row => row._table === "taskMessages" || row._table === "commentNotifications").length, 0);
});

test("Trello authors link by exact member ID and retain the Trello name as a fallback", async () => {
  const f = notificationFixture();
  Object.assign(f.rows.get("external1"), { trelloMemberId: "member1", name: "Nombre del perfil" });
  const message = await importTrelloComment(f, { idMemberCreator: "member1", memberCreator: { fullName: "Nombre de Trello" } });
  assert.equal(message.userId, "user1");
  assert.equal(message.trelloAuthorName, "Nombre de Trello");
  const detail = () => f.call(panel.detail, { taskId: "task1" });
  assert.equal((await detail()).comments[0].authorName, "Nombre del perfil");
  assert.equal((await detail()).comments[0].own, true);
  f.as("internal1");
  assert.equal((await detail()).comments[0].isClient, true);
  delete f.rows.get("external1").name;
  assert.equal((await detail()).comments[0].authorName, "Externo");
  delete f.rows.get("user1").name;
  assert.equal((await detail()).comments[0].authorName, "Nombre de Trello");
});

test("internal Trello authors use the Trello name without looking up an internal account", async () => {
  for (const trelloName of ["Nombre en Trello", "Interno", undefined]) {
    const f = notificationFixture();
    const query = f.ctx.db.query;
    let internalLookups = 0;
    f.ctx.db.query = (table: string) => {
      if (table === "users") internalLookups += 1;
      return query(table);
    };
    const message = await importTrelloComment(f, { memberCreator: { id: "internal-member", fullName: trelloName } });
    assert.equal(internalLookups, 0, "Trello identity must only be resolved through approvedExternalUsers");
    assert.equal(message.userId, undefined);
    f.as("internal1");
    const [comment] = (await f.call(panel.detail, { taskId: "task1" })).comments;
    assert.equal(comment.own, false);
    assert.equal(comment.isClient, false);
    assert.equal(comment.authorName, trelloName ?? "Autor sin nombre");
    assert.equal((await f.unread())[0].author, trelloName ?? "Autor sin nombre");
    assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" }))[0].author, trelloName ?? "Autor sin nombre");
  }
});

test("historical Trello comments with an internal userId still use Trello's name", async () => {
  for (const trelloName of ["Nombre en Trello", undefined]) {
    const f = notificationFixture();
    f.put("taskMessages", { _id: "legacy-internal", taskId: "task1", source: "trello", userId: "internal2", trelloAuthorName: trelloName, message: "Comentario anterior", createdAt: 1 });
    f.as("internal1");
    const [comment] = (await f.call(panel.detail, { taskId: "task1" })).comments;
    assert.equal(comment.authorName, trelloName ?? "Autor sin nombre");
    assert.equal(comment.isClient, false);
    assert.equal((await f.call(tasks.listInternalTaskComments, { taskId: "task1" }))[0].author, trelloName ?? "Autor sin nombre");
  }
});

test("shared or unlinked Trello members keep their own name without assuming a platform user", async () => {
  for (const shared of [false, true]) {
    const f = notificationFixture();
    Object.assign(f.rows.get("external1"), { trelloMemberId: "member1" });
    if (shared) f.rows.get("external2").trelloMemberId = "member1";
    else delete f.rows.get("external1").userId;
    const message = await importTrelloComment(f, { memberCreator: { id: "member1", fullName: "Autor Trello" } });
    assert.equal(message.userId, undefined);
    f.as("internal1");
    assert.equal((await f.call(panel.detail, { taskId: "task1" })).comments[0].authorName, "Autor Trello");
  }
});

test("historical Trello comments can be repaired by name or user ID, including reply context and emails", async () => {
  const f = notificationFixture();
  f.put("taskMessages", { _id: "legacy-trello", taskId: "task1", source: "trello", message: "Comentario anterior", createdAt: 1 });
  const message = f.rows.get("legacy-trello");
  const detail = () => f.call(panel.detail, { taskId: "task1" });
  assert.equal((await detail()).comments[0].authorName, "Autor sin nombre");
  // These are the same fields an operator can edit in the Convex dashboard.
  message.trelloAuthorName = "  Lucía Pérez  ";
  assert.equal((await detail()).comments[0].authorName, "Lucía Pérez");
  message.userId = "user1";
  f.rows.get("external1").name = "Nombre aprobado";
  assert.equal((await detail()).comments[0].authorName, "Nombre aprobado");
  delete message.userId;
  f.as("internal1");
  const entryId = await f.post("trello-reply", message._id);
  const context = await f.call(panel.syncContext, { entryId });
  assert.match(context.message.message, /^En respuesta a Lucía Pérez: Comentario anterior/);

  message.mentionedUserIds = ["internal2"];
  f.rows.get("internal2").email = "internal2@example.com";
  await notifyTaskComment(f.ctx, message._id);
  const notification = [...f.rows.values()].find(row => row._table === "commentNotifications" && row.messageId === message._id && row.userId === "internal2");
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  try {
    process.env.APP_URL = "https://app.example.com";
    process.env.RESEND_API_KEY = "test-only";
    const claim = await f.call(notifications.claimEmail, { id: notification._id });
    assert.match(JSON.parse(claim.payload).text, /Lucía Pérez te mencionó/);
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("three external users share brand tasks, comments and uploads while chats remain private", async () => {
  const f = notificationFixture();
  f.put("approvedExternalUsers", { _id: "external3", userId: "thirdExternal", name: "Tercera persona" });
  f.put("clientUserAssignments", { _id: "assignment-third", userId: "thirdExternal", clientId: "client1", brandId: "brand1" });
  f.rows.get("assignment-user1").brandId = "brand1";
  f.rows.get("assignment-otherExternal").brandId = "brand1";
  f.rows.get("external1").name = "Creadora";
  f.put("chatThreads", { _id: "chat1", threadId: "thread1", userId: "user1" });
  for (const id of ["user1", "otherExternal", "thirdExternal"]) {
    f.as(id);
    const board = await f.call(tasks.listMyExternalRequests, {});
    assert.equal(board.length, 1); // Deduplicates matches across client, COR and brand indexes.
    assert.equal(board[0].createdByName, "Creadora");
    assert.equal(board[0].threadId, id === "user1" ? "thread1" : null);
    const chat = await f.call(threads.getThread, { threadId: "thread1" });
    assert.equal(Boolean(chat), id === "user1");
    assert.ok(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }));
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
    f.upload(`file-${id}`, { userId: id });
    await f.call(panel.submit, { taskId: "task1", key: `shared-${id}`, text: `Comentario de ${id}`, uploadIds: [`file-${id}`] });
  }
  const detail = await f.call(panel.detail, { taskId: "task1" });
  assert.equal(detail.comments.length, 3);
  assert.equal(detail.attachments.length, 3);
  assert.equal(detail.comments.find((c: any) => c.own).authorName, "Tercera persona");
  // Even a mismatched task/thread ownership must not reveal the chat link.
  f.rows.get("task1").createdBy = "otherExternal";
  f.as("user1");
  assert.equal((await f.call(tasks.listMyExternalRequests, {}))[0].threadId, null);
});

test("archiving hides a task from its external creator and other authorized client and brand users", async () => {
  const f = notificationFixture();
  f.put("approvedExternalUsers", { _id: "brandExternal", userId: "brandUser" });
  f.put("clientUserAssignments", { _id: "assignment-brand", userId: "brandUser", clientId: "client1", brandId: "brand1" });
  const original = f.rows.get("task1");
  f.put("tasks", { ...original, _id: "active-task", convexStatus: "active" });
  f.put("tasks", { ...original, _id: "legacy-task" });
  const viewers = ["user1", "otherExternal", "brandUser"];
  for (const userId of viewers) {
    f.as(userId);
    assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 3);
    assert.ok(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }));
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), true);
  }

  await f.call(tasks.completeArchiveUnpublishedTask, { taskId: "task1", archiveProject: false, archivedBy: "internal1" });
  assert.equal(f.rows.get("task1").convexStatus, "archived");

  for (const userId of viewers) {
    f.as(userId);
    assert.equal(await hasExternalRequestsAccess(f.ctx, userId as any), true);
    assert.deepEqual((await f.call(tasks.listMyExternalRequests, {})).map((task: any) => task._id).sort(), ["active-task", "legacy-task"]);
    assert.equal(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), null);
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
    await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
    await assert.rejects(f.post(`archived-${userId}`), /acceso/);
    await assert.rejects(f.call(panel.prepareUpload, { taskId: "task1", key: `archived-${userId}`, filename: "file.pdf", mimeType: "application/pdf", size: 4 }), /acceso/);
  }
});

test("external board enforces client and brand access on reads, comments and file uploads", async () => {
  const f = notificationFixture();
  f.as("otherExternal");
  f.rows.get("assignment-otherExternal").brandId = "brand2";
  const denied = async () => {
    assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), []);
    assert.equal(await f.call(tasks.getBoardDialogDetails, { taskId: "task1" }), null);
    assert.equal(await f.call(panel.canAccessComments, { taskId: "task1" }), false);
    await assert.rejects(f.call(panel.detail, { taskId: "task1" }), /acceso/);
    await assert.rejects(f.post("forbidden"), /acceso/);
    await assert.rejects(f.call(panel.prepareUpload, { taskId: "task1", key: "forbidden", filename: "file.pdf", mimeType: "application/pdf", size: 4 }), /acceso/);
  };
  await denied();
  // A second matching assignment qualifies even if the first one doesn't.
  f.put("clientUserAssignments", { _id: "matching-brand", userId: "otherExternal", clientId: "client1", brandId: "brand1" });
  assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 1);
  f.upload("ready-before-revocation", { userId: "otherExternal" });
  f.rows.delete("matching-brand");
  await assert.rejects(f.call(panel.submit, { taskId: "task1", key: "revoked", text: "File", uploadIds: ["ready-before-revocation"] }), /acceso/);
  f.rows.get("assignment-otherExternal").clientId = "client2";
  delete f.rows.get("assignment-otherExternal").brandId;
  f.put("corClients", { _id: "client2", externalBoardEnabled: true, corClientId: 100 });
  await denied();
  f.rows.get("assignment-otherExternal").clientId = "client1";
  assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 1);
  f.rows.get("task1").source = "internal";
  await denied();
  f.rows.get("task1").source = "external";
  f.rows.get("task1").convexStatus = "deleted";
  await denied();
});

test("external board includes legacy client and brand links without granting brand-only access to unbranded tasks", async () => {
  const f = notificationFixture(); f.as("otherExternal");
  const task = f.rows.get("task1");
  delete task.clientId; delete task.corClientId;
  assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 1); // Brand-only task.
  delete task.clientBrandId;
  task.corClientId = 99;
  assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 1); // COR-only task.
  delete task.corClientId;
  task.clientId = "client1";
  assert.equal((await f.call(tasks.listMyExternalRequests, {})).length, 1); // Client-only task.
  f.rows.get("assignment-otherExternal").brandId = "brand1";
  assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), []);
  task.clientBrandId = "missing-brand";
  delete f.rows.get("assignment-otherExternal").brandId;
  assert.deepEqual(await f.call(tasks.listMyExternalRequests, {}), []);
});

test("mention candidates are restricted to this client and brand, including inherited subbrands", async () => {
  const f = fixture();
  f.put("clientBrands", { _id: "brand1", clientId: "client1" });
  f.put("subBrands", { _id: "sub1", clientBrandId: "brand1" });
  f.rows.get("task1").clientBrandId = "brand1";
  f.rows.get("task1").subBrandId = "sub1";
  for (const [id, clientId, brandId] of [["internal1", "client1", "brand1"], ["otherBrand", "client1", "brand2"], ["otherClient", "client2", undefined], ["wholeClient", "client1", undefined]]) {
    f.put("users", { _id: id, name: id });
    f.put("clientUserAssignments", { _id: `a-${id}`, userId: id, clientId, brandId });
  }
  f.put("users", { _id: "user1", name: "External" });
  const people = await f.call(panel.mentionUsers, { taskId: "task1" });
  assert.deepEqual(people.map((p: any) => p.id).sort(), ["internal1", "user1", "wholeClient"]);
  const args = { taskId: "task1", key: "mention", text: "Hola {{task-panel-mention:internal1}}", uploadIds: [] };
  const entryId = await f.call(panel.submit, args);
  assert.equal(await f.call(panel.submit, args), entryId);
  const message = f.rows.get(f.rows.get(entryId).messageId);
  assert.deepEqual(message.mentionedUserIds, ["internal1"]);
  const sync = await f.call(panel.syncContext, { entryId });
  assert.equal(sync.message.message, "Hola @internal1");
  await assert.rejects(f.call(panel.submit, { ...args, key: "forged", text: "{{task-panel-mention:otherBrand}}" }));
  f.rows.delete("a-internal1");
  await assert.rejects(f.call(panel.submit, { ...args, key: "revoked" }));
  f.rows.get("client1").externalBoardEnabled = false;
  await assert.rejects(f.call(panel.mentionUsers, { taskId: "task1" }));
});

async function mentionNotificationFixture() {
  const f = notificationFixture();
  for (const id of ["internal1", "internal2", "user1", "otherExternal"]) f.rows.get(id).email = `${id}@example.com`;
  f.as("internal1");
  const args = { taskId: "task1", key: "mentions", text: "Revisar {{task-panel-mention:internal2}} y {{task-panel-mention:otherExternal}}. Otra vez {{task-panel-mention:internal2}}. {{task-panel-mention:internal1}}", uploadIds: [] };
  const entryId = await f.call(panel.submit, args);
  const messageId = f.rows.get(entryId).messageId;
  const all = () => [...f.rows.values()].filter(r => r._table === "commentNotifications");
  return { ...f, args, messageId, all, mentioned: (id: string) => all().find(r => r.userId === id) };
}

test("mentions notify internal and external recipients once, with one email only for selected users", async () => {
  const f = await mentionNotificationFixture();
  await f.call(panel.submit, f.args);
  await notifyTaskComment(f.ctx, f.messageId);
  assert.equal(f.all().length, 3);
  assert.equal(f.mentioned("internal1"), undefined); // no self-notification
  for (const id of ["internal2", "otherExternal"]) {
    const row = f.mentioned(id);
    assert.equal(row.kind, "mention"); assert.equal(row.emailState, "pending");
    f.as(id);
    const page = await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } });
    assert.equal(page.page[0].kind, "mention");
    assert.equal(page.page[0].external, id === "otherExternal");
    assert.equal((await f.unread())[0].count, 1);
    await f.call(notifications.markRead, { taskId: "task1", messageIds: [f.messageId] });
    assert.deepEqual(await f.unread(), []);
  }
  assert.equal(f.mentioned("user1").kind, undefined);
  assert.equal(f.mentioned("user1").emailState, undefined);
  assert.equal(await f.call(notifications.claimEmail, { id: f.mentioned("user1")._id }), null);
});

test("a disabled or unconfigured external board preserves internal mention notifications and email eligibility", async () => {
  const env = { RESEND_API_KEY: process.env.RESEND_API_KEY, APP_URL: process.env.APP_URL };
  process.env.RESEND_API_KEY = "test-only";
  process.env.APP_URL = "https://app.example.com";
  try {
    for (const enabled of [false, undefined]) {
      const f = notificationFixture();
      f.rows.get("internal2").email = "internal2@example.com";
      if (enabled === undefined) delete f.rows.get("client1").externalBoardEnabled;
      else f.rows.get("client1").externalBoardEnabled = enabled;
      f.as("internal1");
      await f.call(panel.submit, { taskId: "task1", key: "disabled-mentions", text: "Revisar {{task-panel-mention:internal2}} y {{task-panel-mention:otherExternal}}", uploadIds: [] });
      const rows = [...f.rows.values()].filter(row => row._table === "commentNotifications");
      assert.deepEqual(rows.map(row => row.userId), ["internal2"]);
      assert.equal(rows[0].kind, "mention");
      f.as("internal2"); assert.equal((await f.unread())[0].count, 1);
      const claim = await f.call(notifications.claimEmail, { id: rows[0]._id });
      assert.ok(claim);
      assert.deepEqual(JSON.parse(claim.payload).to, ["internal2@example.com"]);
      f.as("otherExternal"); assert.deepEqual(await f.unread(), []);
    }
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("plain text @names and unselected email addresses never queue mention emails", async () => {
  const f = notificationFixture(); f.as("internal1");
  await f.call(panel.submit, { taskId: "task1", key: "plain", text: "@Colega correo@example.com", uploadIds: [] });
  assert.ok([...f.rows.values()].filter(r => r._table === "commentNotifications").every(r => !r.emailState && !r.kind));
});

test("revocation, brand scope, disabled feature, hidden comments and removed mentions suppress display and email", async () => {
  const cases: ((f: Awaited<ReturnType<typeof mentionNotificationFixture>>) => void)[] = [
    f => { f.rows.delete("assignment-otherExternal"); },
    f => { f.rows.get("assignment-otherExternal").brandId = "brand2"; },
    f => { f.rows.get("client1").externalBoardEnabled = false; },
    f => { f.rows.get(f.messageId).source = "internal"; },
    f => { f.rows.get(f.messageId).mentionedUserIds = []; },
    f => { f.rows.delete(f.messageId); },
    f => { f.rows.get("task1").source = "internal"; },
    f => { f.rows.get("task1").convexStatus = "deleted"; },
    f => { f.rows.get("task1").convexStatus = "archived"; },
    f => { f.put("taskMessages", { _id: "hiddenParent", taskId: "task1", source: "internal" }); f.rows.get(f.messageId).replyTo = "hiddenParent"; },
  ];
  for (const change of cases) {
    const f = await mentionNotificationFixture(); const row = f.mentioned("otherExternal");
    change(f); f.as("otherExternal");
    assert.deepEqual(await f.unread(), []);
    const page = await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } });
    assert.deepEqual(page.page, []);
    await f.call(notifications.markRead, { taskId: "task1", messageIds: [f.messageId] });
    assert.equal(row.read, false);
    assert.equal(await f.call(notifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "cancelled");
  }
});

test("mention emails retry idempotently with leases, route by recipient, and stop on access revocation", async () => {
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  const originalFetch = globalThis.fetch; const calls: any[] = [];
  try {
    process.env.APP_URL = "https://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    globalThis.fetch = (async (_url: any, init: any) => { calls.push(init); return new Response(JSON.stringify(calls.length === 1 ? { name: "rate_limit_exceeded" } : { id: "mention-email" }), { status: calls.length === 1 ? 429 : 200 }); }) as typeof fetch;
    const f = await mentionNotificationFixture(); const row = f.mentioned("otherExternal");
    await f.call(notifications.sweep, {});
    assert.ok(f.scheduled.some(args => getFunctionName(args[1]) === "data/commentNotifications:sendEmail" && args[2].id === row._id));
    await f.call(notifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "pending");
    await f.call(notifications.sendEmail, { id: row._id }); assert.equal(calls.length, 1);
    row.nextAttemptAt = 0;
    await f.call(notifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "sent");
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
    const payload = JSON.parse(calls[0].body);
    assert.deepEqual(payload.to, ["otherExternal@example.com"]);
    assert.match(payload.text, /Revisar @Colega/);
    assert.match(payload.text, /\/workspace\/requests\?taskId=task1&tab=comments/);
    await f.call(notifications.sendEmail, { id: row._id }); assert.equal(calls.length, 2);
    const internalRow = f.mentioned("internal2");
    const claim = await f.call(notifications.claimEmail, { id: internalRow._id });
    assert.match(JSON.parse(claim.payload).text, /\/workspace\/control-panel\?taskId=task1&tab=comments/);
    assert.equal(await f.call(notifications.claimEmail, { id: internalRow._id }), null);
    await f.call(notifications.finishEmail, { id: internalRow._id, attempt: claim.attempt + 1, resendId: "stale", retry: false });
    assert.equal(internalRow.emailState, "sending");
    f.rows.delete("assignment-internal2"); internalRow.nextAttemptAt = 0;
    await f.call(notifications.sendEmail, { id: internalRow._id });
    assert.equal(internalRow.emailState, "cancelled"); assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("mention email escapes content and offers an authenticated task link", () => {
  const args = { from: "sender@example.com", to: "recipient@example.com", baseUrl: "https://app.example.com", taskId: "task1", title: "<script>bad</script>\r\nTitle", author: "Name <img>", comment: "**Revisar** [@Persona](#mention-user) <script>bad</script> [bad](javascript:alert) ![file](https://files.example/a)", quote: "<img src=x>", external: true };
  const email = commentEmail(args);
  assert.ok(!email.html.includes("<script>")); assert.ok(!email.html.includes("<img"));
  assert.ok(!email.html.includes('href="javascript:')); assert.ok(!email.html.includes("#mention-"));
  assert.match(email.html, /<strong>Revisar<\/strong>/); assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, />Ver tarea<\/a>/); assert.ok(!/[\r\n]/.test(email.subject));
  assert.throws(() => commentEmail({ ...args, baseUrl: "http://app.example.com" }));
});

test("mention email configuration, changed recipient and retry expiry are handled without delivery", async () => {
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  try {
    process.env.RESEND_API_KEY = "test-only"; process.env.APP_URL = "http://app.example.com";
    const f = await mentionNotificationFixture(); const row = f.mentioned("internal2");
    assert.equal(await f.call(notifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "pending"); assert.equal(row.attempts, 0);
    process.env.APP_URL = "https://app.example.com"; row.nextAttemptAt = 0;
    assert.ok(await f.call(notifications.claimEmail, { id: row._id }));
    row.nextAttemptAt = 0; f.rows.get("internal2").email = "changed@example.com";
    assert.equal(await f.call(notifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "cancelled");
    const external = f.mentioned("otherExternal");
    external.firstAttemptAt = Date.now() - 23 * 60 * 60 * 1000;
    assert.equal(await f.call(notifications.claimEmail, { id: external._id }), null);
    assert.equal(external.emailState, "failed");
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a mention in a reply notifies the selected recipient and does not revive historical emails", async () => {
  const f = notificationFixture(); f.as("user1");
  const parentEntry = await f.post("parent");
  const parentId = f.rows.get(parentEntry).messageId;
  await f.call(panel.submit, { taskId: "task1", key: "reply", text: "{{task-panel-mention:otherExternal}} revisá esto", uploadIds: [], replyTo: parentId });
  const row = [...f.rows.values()].find(r => r._table === "commentNotifications" && r.userId === "otherExternal");
  assert.equal(row.kind, "mention"); assert.equal(row.emailState, "pending");
  assert.equal(f.rows.get(row.messageId).replyTo, parentId);
  f.put("commentNotifications", { _id: "legacy", userId: "internal2", taskId: "task1", messageId: "oldMention", read: false, createdAt: 0 });
  f.put("taskMessages", { _id: "oldMention", taskId: "task1", source: "external_panel", userId: "user1", message: "Old", mentionedUserIds: ["internal2"] });
  await notifyTaskComment(f.ctx, "oldMention" as any);
  assert.equal(f.rows.get("legacy").emailState, undefined);
});

test("external coordinators receive comments and replies without mentions while ordinary users keep their existing notifications", async () => {
  const f = notificationFixture();
  f.rows.get("external2").isCoordinator = true;
  f.as("user1");
  const parentEntry = await f.post("external-question");
  f.as("internal1");
  await f.post("internal-answer", f.rows.get(parentEntry).messageId);
  for (const source of ["external_agent", "trello"]) {
    f.put("taskMessages", { _id: source, taskId: "task1", userId: "user1", source, message: "Nuevo comentario", createdAt: Date.now() });
    await notifyTaskComment(f.ctx, source as any);
    await notifyTaskComment(f.ctx, source as any);
  }
  const rows = [...f.rows.values()].filter(row => row._table === "commentNotifications");
  const coordinatorRows = rows.filter(row => row.userId === "otherExternal");
  assert.equal(coordinatorRows.length, 4);
  assert.ok(coordinatorRows.every(row => row.kind === "coordinator_comment" && row.emailState === "pending"));
  assert.ok(rows.filter(row => row.userId !== "otherExternal").every(row => !row.kind && !row.emailState));
  f.as("otherExternal");
  const [group] = await f.unread();
  assert.equal(group.count, 4);
  const historyPage = await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } });
  assert.equal(historyPage.page.length, 4);
  assert.ok(historyPage.page.every((row: any) => row.kind === "comment" && row.external));
  await f.call(notifications.markRead, { taskId: "task1", messageIds: group.messageIds });
  assert.deepEqual(await f.unread(), []);
  f.as("user1"); assert.equal((await f.unread())[0].count, 1);
});

test("coordinators are notified on their own tasks but never for their own comments or twice for a mention", async () => {
  const f = notificationFixture();
  f.rows.get("external2").isCoordinator = true;
  f.rows.get("task1").createdBy = "otherExternal";
  f.as("otherExternal"); await f.post("own-comment");
  const forCoordinator = () => [...f.rows.values()].filter(row => row._table === "commentNotifications" && row.userId === "otherExternal");
  assert.equal(forCoordinator().length, 0);
  f.as("internal1"); await f.post("comment-on-coordinator-task");
  assert.equal(forCoordinator()[0].kind, "coordinator_comment");
  const args = { taskId: "task1", key: "coordinator-mention", text: "Hola {{task-panel-mention:otherExternal}}", uploadIds: [] };
  const entry = await f.call(panel.submit, args);
  await f.call(panel.submit, args);
  await notifyTaskComment(f.ctx, f.rows.get(entry).messageId);
  assert.deepEqual(forCoordinator().map(row => row.kind).sort(), ["coordinator_comment", "mention"]);
});

test("coordinator comment subscriptions respect each client, category and external board setting", async () => {
  const f = notificationFixture();
  f.rows.get("external2").isCoordinator = true;
  f.rows.get("assignment-otherExternal").brandId = "brand1";
  f.put("corClients", { _id: "client2", corClientId: 100, externalBoardEnabled: true });
  f.put("clientUserAssignments", { _id: "coordinator-client2", clientId: "client2", userId: "otherExternal" });
  f.put("tasks", { ...f.rows.get("task1"), _id: "task2", clientBrandId: undefined, clientId: "client2", corClientId: 100 });
  for (const taskId of ["task1", "task2"]) {
    const id = `comment-${taskId}`;
    f.put("taskMessages", { _id: id, taskId, userId: "user1", source: "external_panel", message: "Hola", createdAt: Date.now() });
    await notifyTaskComment(f.ctx, id as any);
  }
  f.as("otherExternal");
  assert.deepEqual((await f.unread()).map((row: any) => row.taskId).sort(), ["task1", "task2"]);
  f.rows.get("client1").externalBoardEnabled = false;
  assert.deepEqual((await f.unread()).map((row: any) => row.taskId), ["task2"]);
  f.rows.delete("coordinator-client2");
  assert.deepEqual(await f.unread(), []);
});

test("coordinator comment notifications and queued emails stop after role or access revocation and never expose hidden comments", async () => {
  const cases: Record<string, (f: ReturnType<typeof notificationFixture>, messageId: string) => void> = {
    role: f => { f.rows.get("external2").isCoordinator = false; },
    assignment: f => { f.rows.delete("assignment-otherExternal"); },
    client: f => { f.rows.get("assignment-otherExternal").clientId = "another-client"; },
    category: f => { f.rows.get("assignment-otherExternal").brandId = "brand2"; },
    board: f => { f.rows.get("client1").externalBoardEnabled = false; },
    unconfigured: f => { delete f.rows.get("client1").externalBoardEnabled; },
    hidden: (f, id) => { f.rows.get(id).source = "internal"; },
    cor: (f, id) => { f.rows.get(id).source = "cor"; },
    missing: (f, id) => { f.rows.delete(id); },
    foreignMessage: (f, id) => { f.rows.get(id).taskId = "task2"; },
    own: (f, id) => { f.rows.get(id).userId = "otherExternal"; },
    internalTask: f => { f.rows.get("task1").source = "internal"; },
    deleted: f => { f.rows.get("task1").convexStatus = "deleted"; },
    archived: f => { f.rows.get("task1").convexStatus = "archived"; },
    hiddenParent: (f, id) => {
      f.put("taskMessages", { _id: "hidden-parent", taskId: "task1", source: "internal" });
      f.rows.get(id).replyTo = "hidden-parent";
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = notificationFixture();
    f.rows.get("external2").isCoordinator = true;
    f.as("internal1"); const entry = await f.post(name);
    const messageId = f.rows.get(entry).messageId;
    const row = [...f.rows.values()].find(row => row._table === "commentNotifications" && row.userId === "otherExternal");
    assert.equal(row.kind, "coordinator_comment");
    change(f, messageId);
    f.as("otherExternal"); assert.deepEqual(await f.unread(), [], name);
    assert.deepEqual((await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } })).page, [], name);
    await f.call(notifications.markRead, { taskId: "task1", messageIds: [messageId] });
    assert.equal(row.read, false, name);
    assert.equal(await f.call(notifications.claimEmail, { id: row._id }), null, name);
    assert.equal(row.emailState, "cancelled", name);
    f.rows.delete(row._id);
    await notifyTaskComment(f.ctx, messageId);
    assert.equal([...f.rows.values()].filter(r => r._table === "commentNotifications" && r.userId === "otherExternal").length, 0, name);
  }
});

test("coordinator comment emails use the external task link and retry once per notification without claiming a mention", async () => {
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  const originalFetch = globalThis.fetch;
  const calls: any[] = [];
  try {
    process.env.APP_URL = "https://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push(init);
      return new Response(JSON.stringify(calls.length === 1 ? { name: "rate_limit_exceeded" } : { id: "coordinator-comment-email" }), { status: calls.length === 1 ? 429 : 200 });
    }) as typeof fetch;
    const f = notificationFixture();
    f.rows.get("external2").isCoordinator = true;
    f.rows.get("otherExternal").email = "coordinator@example.com";
    f.as("user1"); await f.post("email-comment");
    const row = [...f.rows.values()].find(row => row._table === "commentNotifications" && row.userId === "otherExternal");
    await f.call(notifications.sweep, {});
    assert.ok(f.scheduled.some(args => getFunctionName(args[1]) === "data/commentNotifications:sendEmail" && args[2].id === row._id));
    await f.call(notifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "pending");
    row.nextAttemptAt = 0;
    await f.call(notifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "sent");
    await f.call(notifications.sendEmail, { id: row._id });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
    const payload = JSON.parse(calls[0].body);
    assert.deepEqual(payload.to, ["coordinator@example.com"]);
    assert.match(payload.subject, /^Nuevo comentario en:/);
    assert.match(payload.text, /Externo agregó un comentario/);
    assert.match(payload.text, /\/workspace\/requests\?taskId=task1&tab=comments/);
    assert.ok(!payload.html.includes("Te mencionaron"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("enabling coordinator comment subscriptions does not resend historical notifications", async () => {
  const f = notificationFixture();
  f.rows.get("task1").createdBy = "otherExternal";
  f.as("internal1"); const entry = await f.post("historical-comment");
  const row = [...f.rows.values()].find(row => row._table === "commentNotifications" && row.userId === "otherExternal");
  assert.equal(row.kind, undefined);
  f.rows.get("external2").isCoordinator = true;
  await notifyTaskComment(f.ctx, f.rows.get(entry).messageId);
  assert.equal(row.emailState, undefined);
  assert.equal(await f.call(notifications.claimEmail, { id: row._id }), null);
});

function statusFixture() {
  const f = notificationFixture();
  f.rows.get("external2").isCoordinator = true;
  f.rows.get("otherExternal").email = "coordinator@example.com";
  const statusRows = () => [...f.rows.values()].filter(row => row._table === "taskStatusNotifications");
  const change = (status: string) => patchTaskWithStatusNotification(f.ctx, "task1" as any, { status }, "platform");
  return { ...f, statusRows, change };
}

test("status events notify only authorized external coordinators, once per real transition across sync sources", async () => {
  const f = statusFixture();
  f.put("approvedExternalUsers", { _id: "wrong-brand-external", userId: "wrongBrandUser", isCoordinator: true });
  f.put("approvedExternalUsers", { _id: "foreign-external", userId: "foreignCoordinator", isCoordinator: true });
  f.put("corClients", { _id: "client2", corClientId: 100, externalBoardEnabled: true });
  f.put("clientUserAssignments", { _id: "foreign-assignment", userId: "foreignCoordinator", clientId: "client2" });
  // Duplicate assignments must not duplicate a coordinator's notification.
  f.put("clientUserAssignments", { _id: "duplicate-assignment", userId: "otherExternal", clientId: "client1", brandId: "brand1" });
  f.as("internal1");
  await f.call(tasks.updateTaskFields, { taskId: "task1", updates: { status: "en_proceso" } });
  assert.deepEqual(f.statusRows().map(row => [row.userId, row.fromStatus, row.toStatus, row.source]), [["otherExternal", "nueva", "en_proceso", "platform"]]);
  f.rows.get("task1").corSyncStatus = "synced";
  assert.deepEqual(await f.call(applyInboundTaskUpdate, { taskId: "task1", corTitle: "Original", corStatus: "en_proceso" }), { updated: false, analyticsChanged: false, statusChanged: false, trelloFieldsChanged: false });
  await f.call(applySafeInboundCardUpdate, { taskId: "task1", updates: { status: "en_proceso" } });
  assert.equal(f.statusRows().length, 1);
  assert.equal(f.rows.get("task1").trelloInboundSyncStatus, "pending_review");
  const result = await f.call(applyInboundTaskUpdate, { taskId: "task1", corTitle: "Changed title", corStatus: "en_revision" });
  assert.deepEqual(result, { updated: true, analyticsChanged: true, statusChanged: true, trelloFieldsChanged: true });
  assert.equal(f.statusRows()[1].source, "cor");
  await f.call(applySafeInboundCardUpdate, { taskId: "task1", updates: { status: "finalizada" } });
  assert.deepEqual(f.statusRows().map(row => row.toStatus), ["en_proceso", "en_revision", "finalizada"]);
  assert.equal(f.statusRows()[2].source, "trello");
  assert.ok(f.statusRows().every(row => row.emailState === "pending" && row.read === false));
  assert.equal([...f.rows.values()].filter(row => row._table === "taskCreationNotifications" || row._table === "commentNotifications").length, 0);
});

test("status events cover every assigned client and own external tasks, preserving repeated legitimate transitions", async () => {
  const f = statusFixture();
  f.rows.get("task1").createdBy = "otherExternal";
  for (const status of ["en_proceso", "nueva", "en_proceso"]) await f.change(status);
  assert.deepEqual(f.statusRows().map(row => [row.fromStatus, row.toStatus]), [["nueva", "en_proceso"], ["en_proceso", "nueva"], ["nueva", "en_proceso"]]);
  assert.equal(new Set(f.statusRows().map(row => row._id)).size, 3);
  f.put("corClients", { _id: "client2", corClientId: 100, externalBoardEnabled: true });
  f.put("clientUserAssignments", { _id: "second-client", userId: "otherExternal", clientId: "client2" });
  f.put("tasks", { ...f.rows.get("task1"), _id: "task2", clientId: "client2", clientBrandId: undefined, corClientId: 100 });
  await patchTaskWithStatusNotification(f.ctx, "task2" as any, { status: "finalizada" }, "cor");
  f.as("otherExternal");
  assert.deepEqual((await f.call(statusNotifications.unread, {})).map((row: any) => row.taskId).sort(), ["task1", "task1", "task1", "task2"]);
});

test("status notifications fail closed for revoked roles, clients, categories, boards and hidden tasks before creation or delivery", async () => {
  const cases: Record<string, (f: ReturnType<typeof statusFixture>) => void> = {
    role: f => { f.rows.get("external2").isCoordinator = false; },
    external: f => { f.rows.delete("external2"); },
    assignment: f => { f.rows.delete("assignment-otherExternal"); },
    client: f => { f.rows.get("assignment-otherExternal").clientId = "another-client"; },
    category: f => { f.rows.get("assignment-otherExternal").brandId = "brand2"; },
    board: f => { f.rows.get("client1").externalBoardEnabled = false; },
    unconfigured: f => { delete f.rows.get("client1").externalBoardEnabled; },
    internalTask: f => { f.rows.get("task1").source = "internal"; },
    deleted: f => { f.rows.get("task1").convexStatus = "deleted"; },
    archived: f => { f.rows.get("task1").convexStatus = "archived"; },
    missingBrand: f => { f.rows.delete("brand1"); },
    foreignBrand: f => { f.rows.get("brand1").clientId = "another-client"; },
  };
  for (const [name, revoke] of Object.entries(cases)) {
    const f = statusFixture(); await f.change("en_proceso");
    const [row] = f.statusRows(); assert.ok(row, name);
    revoke(f); f.as("otherExternal");
    assert.deepEqual(await f.call(statusNotifications.unread, {}), [], name);
    assert.deepEqual((await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } })).page, [], name);
    await f.call(statusNotifications.markRead, { taskId: "task1", notificationIds: [row._id] });
    assert.equal(row.read, false, name);
    assert.equal(await f.call(statusNotifications.claimEmail, { id: row._id }), null, name);
    assert.equal(row.emailState, "cancelled", name);
    await f.change("finalizada"); assert.equal(f.statusRows().length, 1, name);
  }
});

test("status reads acknowledge only the viewer's requested task events, retaining new events and paginated history", async () => {
  const f = statusFixture(); await f.change("en_proceso");
  const [first] = f.statusRows();
  f.put("taskStatusNotifications", { ...first, _id: "foreign-event", userId: "user1" });
  f.put("taskStatusNotifications", { ...first, _id: "other-task-event", taskId: "task2" });
  f.as("otherExternal");
  const displayed = await f.call(statusNotifications.unread, {});
  assert.deepEqual(displayed.map((row: any) => row.id), [first._id]);
  await f.change("finalizada");
  await f.call(statusNotifications.markRead, { taskId: "task1", notificationIds: [first._id, "foreign-event", "other-task-event"] });
  assert.equal(first.read, true);
  assert.equal(f.rows.get("foreign-event").read, false);
  assert.equal(f.rows.get("other-task-event").read, false);
  assert.equal((await f.call(statusNotifications.unread, {})).length, 1);
  const page = await f.call(history.list, { paginationOpts: { numItems: 20, cursor: null } });
  assert.equal(page.page.length, 2);
  assert.ok(page.page.every((row: any) => row.kind === "status" && row.external));
  assert.ok(page.page.some((row: any) => row.read && row.context === "Nueva → En proceso"));
  await assert.rejects(f.call(statusNotifications.markRead, { taskId: "task1", notificationIds: Array(101).fill(first._id) }));
  f.ctx.auth.getUserIdentity = async () => null;
  assert.deepEqual(await f.call(statusNotifications.unread, {}), []);
  await assert.rejects(f.call(statusNotifications.markRead, { taskId: "task1", notificationIds: [first._id] }), /No autenticado/);
});

test("status-only public mutation enforces existing task edit access and read-only locks", async () => {
  const denied: Record<string, (f: ReturnType<typeof statusFixture>) => void> = {
    anonymous: f => { f.ctx.auth.getUserIdentity = async () => null; },
    external: f => { f.as("otherExternal"); },
    assignment: f => { f.rows.delete("assignment-internal1"); },
    inactive: f => { f.put("corUsers", { _id: "inactive", userId: "internal1", isActive: false }); },
    published: f => { f.rows.get("task1").corTaskId = "99"; },
    synced: f => { f.rows.get("task1").corSyncStatus = "synced"; },
    syncing: f => { f.rows.get("task1").corSyncStatus = "syncing"; },
    retrying: f => { f.rows.get("task1").corSyncStatus = "retrying"; },
  };
  for (const [name, change] of Object.entries(denied)) {
    const f = statusFixture(); f.as("internal1"); change(f);
    await assert.rejects(f.call(tasks.updateTaskStatus, { taskId: "task1", status: "en_proceso" }), Error, name);
    assert.equal(f.rows.get("task1").status, "nueva", name);
    assert.equal(f.statusRows().length, 0, name);
  }
  const f = statusFixture(); f.as("internal1");
  await f.call(tasks.updateTaskStatus, { taskId: "task1", status: "en_proceso" });
  assert.equal(f.statusRows().length, 1);
});

test("unchanged status, metadata-only changes and blocked COR syncs never create historical status alerts", async () => {
  const f = statusFixture();
  await f.change("nueva");
  await patchTaskWithStatusNotification(f.ctx, "task1" as any, { title: "Edited title" }, "platform");
  assert.equal(f.rows.get("task1").title, "Edited title");
  f.rows.get("task1").corSyncStatus = "syncing";
  const result = await f.call(applyInboundTaskUpdate, { taskId: "task1", corTitle: "COR title", corStatus: "finalizada" });
  assert.equal(result.updated, false); assert.equal(f.rows.get("task1").status, "nueva");
  assert.equal(f.statusRows().length, 0);
});

test("status emails use scoped external links and stable retry keys without duplicate delivery", async () => {
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  const originalFetch = globalThis.fetch; const calls: any[] = [];
  try {
    process.env.APP_URL = "https://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push(init);
      return new Response(JSON.stringify(calls.length === 1 ? { name: "rate_limit_exceeded" } : { id: `status-email-${calls.length}` }), { status: calls.length === 1 ? 429 : 200 });
    }) as typeof fetch;
    const f = statusFixture(); await f.change("en_proceso"); const [row] = f.statusRows();
    await f.call(statusNotifications.sweep, {});
    assert.ok(f.scheduled.some(args => getFunctionName(args[1]) === "data/taskStatusNotifications:sendEmail" && args[2].id === row._id));
    await f.call(statusNotifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "pending");
    await f.call(statusNotifications.sendEmail, { id: row._id }); assert.equal(calls.length, 1);
    row.nextAttemptAt = 0; f.rows.get("task1").title = "New title after first attempt";
    await f.call(statusNotifications.sendEmail, { id: row._id });
    await f.call(statusNotifications.sendEmail, { id: row._id });
    assert.equal(row.emailState, "sent"); assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
    const payload = JSON.parse(calls[0].body);
    assert.deepEqual(payload.to, ["coordinator@example.com"]);
    assert.match(payload.subject, /^Cambio de estado:/);
    assert.match(payload.text, /Nueva → En proceso/);
    assert.match(payload.text, /\/workspace\/requests\?taskId=task1&tab=task/);
    await f.change("nueva"); await f.change("en_proceso");
    const repeated = f.statusRows()[2];
    await f.call(statusNotifications.sendEmail, { id: repeated._id });
    assert.notEqual(calls[2].headers["Idempotency-Key"], calls[0].headers["Idempotency-Key"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("status email claims prevent concurrency, unsafe retries and changed-recipient delivery", async () => {
  const env = { APP_URL: process.env.APP_URL, RESEND_API_KEY: process.env.RESEND_API_KEY };
  try {
    process.env.APP_URL = "http://app.example.com"; process.env.RESEND_API_KEY = "test-only";
    const f = statusFixture(); await f.change("en_proceso"); const [row] = f.statusRows();
    assert.equal(await f.call(statusNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "pending"); assert.equal(row.attempts, 0);
    process.env.APP_URL = "https://app.example.com"; row.nextAttemptAt = 0;
    const claim = await f.call(statusNotifications.claimEmail, { id: row._id }); assert.ok(claim);
    assert.equal(await f.call(statusNotifications.claimEmail, { id: row._id }), null);
    await f.call(statusNotifications.finishEmail, { id: row._id, attempt: claim.attempt + 1, resendId: "stale", retry: false });
    assert.equal(row.emailState, "sending");
    row.nextAttemptAt = 0; f.rows.get("otherExternal").email = "changed@example.com";
    assert.equal(await f.call(statusNotifications.claimEmail, { id: row._id }), null);
    assert.equal(row.emailState, "cancelled");
    for (const expiration of [{ attempts: 8 }, { attempts: 1, firstAttemptAt: Date.now() - 23 * 60 * 60 * 1000 }]) {
      Object.assign(row, { emailState: "pending", nextAttemptAt: 0 }, expiration);
      assert.equal(await f.call(statusNotifications.claimEmail, { id: row._id }), null);
      assert.equal(row.emailState, "failed");
    }
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("status email content escapes titles, client names and unknown status labels", () => {
  const args = { from: "sender@example.com", to: "recipient@example.com", baseUrl: "https://app.example.com", taskId: "task1", title: "<script>alert(1)</script>\nTitle", client: "Client & Co", fromStatus: "nueva", toStatus: "<unsafe>" };
  const email = taskStatusEmail(args);
  assert.ok(!email.html.includes("<script>")); assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(email.html.includes("Client &amp; Co")); assert.ok(email.html.includes("Nueva → &lt;unsafe&gt;"));
  assert.ok(!email.subject.includes("\n"));
  for (const baseUrl of ["javascript:alert(1)", "http://app.example.com", "https://user:pass@app.example.com", "http://localhost.evil.example"]) assert.throws(() => taskStatusEmail({ ...args, baseUrl }));
  assert.match(taskStatusEmail({ ...args, baseUrl: "http://localhost:3000" }).text, /http:\/\/localhost:3000\/workspace\/requests/);
});
