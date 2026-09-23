import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import * as comments from "../convex/data/externalComments";
import * as tasks from "../convex/data/tasks";
import { usesDirectExternalComments } from "../convex/lib/directExternalComments";
import { editExternalTaskTool } from "../convex/tools/editExternalTaskTool";

function fixture(taskPatch: any = {}) {
  let next = 0;
  const rows = new Map<string, any>();
  const scheduled: any[] = [];
  const put = (table: string, row: any) => { rows.set(row._id, { _table: table, _creationTime: 10, ...row }); return row._id; };
  put("chatThreads", { _id: "threadDoc", threadId: "thread1", userId: "user1" });
  put("approvedExternalUsers", { _id: "approved1", userId: "user1" });
  put("clientUserAssignments", { _id: "assignment1", userId: "user1", clientId: "client1" });
  put("tasks", { _id: "task1", threadId: "thread1", source: "external", clientId: "client1", corClientId: 178768, createdBy: "user1", title: "Original", description: "Original brief", ...taskPatch });
  put("taskDrafts", { _id: "draft1", threadId: "thread1", userId: "user1", taskId: "task1", status: "created" });
  const userMessage = (id: string, time = Date.now() + 1000) => put("agentMessages", { _id: id, threadId: "thread1", _creationTime: time, message: { role: "user", content: "Pedido" } });
  userMessage("request1");
  const db: any = {
    get: async (id: string) => rows.get(id) ?? null,
    normalizeId: (_: string, id: string) => id,
    insert: async (table: string, data: any) => put(table, { ...data, _id: `${table}-${++next}` }),
    patch: async (id: string, patch: any) => { const row = rows.get(id); assert.ok(row); for (const [key, val] of Object.entries(patch)) { if (val === undefined) delete row[key]; else row[key] = val; } },
    query: (table: string) => {
      const filters: any[] = [];
      const builder: any = { eq: (key: string, val: any) => { filters.push((row: any) => row[key] === val); return builder; } };
      const list = () => [...rows.values()].filter(r => r._table === table && filters.every(f => f(r)));
      const q: any = { withIndex: (_: string, build: any) => { build(builder); return q; }, collect: async () => list(), first: async () => list()[0] ?? null, unique: async () => { assert.ok(list().length <= 1); return list()[0] ?? null; } };
      return q;
    },
  };
  const ctx: any = { db, storage: { getUrl: async (id: string) => `https://files.example/${id}` }, scheduler: { runAfter: async (...args: any[]) => { scheduled.push(args); } } };
  const call = async (fn: any, args: any) => {
    const snapshot = structuredClone([...rows.entries()]); const count = scheduled.length;
    try { return await fn._handler(ctx, args); } catch (error) { rows.clear(); snapshot.forEach(([id, r]) => rows.set(id, r)); scheduled.splice(count); throw error; }
  };
  const run = async (ref: any, args: any) => {
    // Component reference paths aren't regular function names.
    if (args.messageIds) return args.messageIds.map((id: string) => rows.get(id) ?? null);
    const name = getFunctionName(ref); const [mod, fn] = name.split(":");
    return call((mod === "data/externalComments" ? comments : tasks as any)[fn as keyof typeof comments], args);
  };
  ctx.runQuery = run; ctx.runMutation = run;
  const register = (messageId = "request1") => call(tasks.registerThreadUploadedFiles, {
    threadId: "thread1", messageId,
    files: [{ fileId: `file-${messageId}`, storageId: `storage-${messageId}`, filename: "Referencia.pdf", mimeType: "application/pdf", size: 10 }],
  });
  const save = (patch: any = {}) => call(comments.save, { threadId: "thread1", requestMessageId: "request1", comment: "Agregar esta referencia", ...patch });
  const all = (table: string) => [...rows.values()].filter(r => r._table === table);
  return { ctx, rows, put, userMessage, call, register, save, all, scheduled };
}

test("only external tasks without taxonomy or Trello select the new route", () => {
  assert.equal(usesDirectExternalComments({ source: "external", corClientId: 178768 }), true);
  for (const patch of [{ source: "internal" }, { clientBrandId: "b1" }, { subBrandId: "s1" }, { brandId: 1 }, { brandName: "Brand" }, { trelloCardId: "c1" }, { trelloSyncStatus: "pending" }, { trelloSyncStatus: "error" }]) {
    assert.equal(usesDirectExternalComments({ source: "external", ...patch }), false);
  }
});

test("text is durable and idempotent before COR publication", async () => {
  const f = fixture(); const original = structuredClone(f.rows.get("task1"));
  const first = await f.save(); const second = await f.save();
  assert.equal(first.id, second.id); assert.equal(f.all("taskMessages").length, 1);
  assert.equal(first.status, "direct_pending_task"); assert.equal(f.scheduled.length, 0);
  assert.deepEqual(f.rows.get("task1"), original);
  assert.deepEqual(await f.call(tasks.listPendingTaskMessagesForCORInternal, { taskId: "task1" }), []);
});

test("post-creation files are staged as links, consumed once, and never natively uploaded", async () => {
  const f = fixture({ corTaskId: "123" });
  await f.register();
  assert.equal(f.all("taskAttachments").length, 0); assert.equal(f.scheduled.length, 0);
  assert.equal(f.all("threadUploadedFiles")[0].commentOnly, true);
  const first = await f.save({ comment: undefined });
  assert.match(f.rows.get(first.id).message, /\[Referencia.pdf\]\(https:\/\/files.example\//);
  assert.equal(f.rows.get(first.id).commentFileIds.length, 1);
  assert.equal(f.all("threadUploadedFiles")[0].commentMessageId, first.id);
  await f.register(); // Upload registration retry must not attach or requeue.
  assert.equal(f.all("taskAttachments").length, 0);
  f.userMessage("request2");
  const second = await f.save({ requestMessageId: "request2", comment: "Solo texto" });
  assert.equal(f.rows.get(second.id).message, "Solo texto");
  assert.deepEqual(f.rows.get(second.id).commentFileIds, []);
});

test("confirmation in a later turn retains staged files; future and original brief files are excluded", async () => {
  const f = fixture(); await f.register();
  f.userMessage("confirmation");
  f.put("threadUploadedFiles", { _id: "initialFile", taskId: "task1", threadId: "thread1", userId: "user1", status: "attached", fileId: "initial", storageId: "initial", filename: "initial.pdf", uploadedAt: 1 });
  f.put("threadUploadedFiles", { _id: "futureFile", taskId: "task1", threadId: "thread1", userId: "user1", status: "attached", commentOnly: true, fileId: "future", storageId: "future", filename: "future.pdf", messageId: "future", uploadedAt: Date.now() + 100_000 });
  const result = await f.save({ requestMessageId: "confirmation", comment: "Sí, agregar archivo", includePendingFiles: true });
  assert.equal(f.rows.get(result.id).commentFileIds.length, 1);
  assert.equal(f.rows.get("futureFile").commentMessageId, undefined);
  assert.equal(f.rows.get("initialFile").commentMessageId, undefined);
});

test("missing files and empty requests fail atomically without consuming uploads", async () => {
  const f = fixture(); await assert.rejects(f.save({ comment: " " }), /comentario o sube/);
  await f.register(); f.ctx.storage.getUrl = async () => null;
  await assert.rejects(f.save(), /recuperar el archivo/);
  assert.equal(f.all("taskMessages").length, 0);
  assert.equal(f.all("threadUploadedFiles")[0].commentMessageId, undefined);
});

test("rejects foreign owners, removed access, internal/Trello tasks and foreign messages", async () => {
  for (const patch of [{ createdBy: "other" }, { source: "internal" }, { clientBrandId: "b1" }, { trelloCardId: "card" }, { convexStatus: "deleted" }]) {
    const f = fixture(patch); await assert.rejects(f.save()); assert.equal(f.all("taskMessages").length, 0);
  }
  const f = fixture(); f.rows.delete("assignment1"); await assert.rejects(f.save(), /acceso a este cliente/);
  const g = fixture(); g.rows.get("request1").threadId = "other"; await assert.rejects(g.save(), /pedido no pertenece/);
  const h = fixture(); h.rows.delete("approved1"); await assert.rejects(h.save());
});

test("publication schedules only the dedicated queue and successful delivery is not repeated", async () => {
  const f = fixture(); const result = await f.save();
  f.put("taskMessages", { _id: "legacy", taskId: "task1", source: "external_agent", message: "Legacy", corMessageSyncStatus: "pending_cor_task" });
  f.rows.get("task1").corTaskId = "123";
  await f.call(comments.scheduleForTask, { taskId: "task1" });
  await f.call(comments.scheduleForTask, { taskId: "task1" });
  let posts = 0;
  const provider: any = { name: "cor", postTaskMessage: async (data: any) => { posts++; assert.equal(data.taskId, 123); return { success: true }; } };
  await comments.deliverComment(f.ctx, result.id, provider);
  await comments.deliverComment(f.ctx, result.id, provider);
  assert.equal(posts, 1); assert.equal(f.rows.get(result.id).corMessageSyncStatus, "synced");
  assert.equal(f.rows.get("legacy").corMessageSyncStatus, "pending_cor_task");
  assert.equal(f.scheduled.filter(s => getFunctionName(s[1]).endsWith(":send")).every(s => s[2].id === result.id), true);
});

test("concurrent deliveries claim once; ambiguous failures never automatically POST again", async () => {
  const f = fixture({ corTaskId: "123" }); const result = await f.save();
  let release!: () => void; const waiting = new Promise<void>(r => release = r); let posts = 0;
  const provider: any = { name: "cor", postTaskMessage: async () => { posts++; await waiting; throw Error("Connection lost after POST"); } };
  const first = comments.deliverComment(f.ctx, result.id, provider);
  // Wait until claim has committed and the request has begun.
  while (!posts) await new Promise(r => setImmediate(r));
  await comments.deliverComment(f.ctx, result.id, provider);
  release(); await first;
  assert.equal(posts, 1); assert.equal(f.rows.get(result.id).corMessageSyncStatus, "direct_uncertain");
  await f.call(comments.scheduleForTask, { taskId: "task1" });
  await comments.deliverComment(f.ctx, result.id, provider); assert.equal(posts, 1);
  await assert.rejects(f.call(comments.retryAfterReview, { id: result.id, confirmedAbsentInCOR: false }));
  await f.call(comments.retryAfterReview, { id: result.id, confirmedAbsentInCOR: true });
  await comments.deliverComment(f.ctx, result.id, { name: "cor", postTaskMessage: async () => ({ success: true }) } as any);
  await f.call(comments.markUncertain, { id: result.id, attempt: 1 });
  assert.equal(f.rows.get(result.id).corMessageSyncStatus, "synced");
  assert.equal(f.all("taskMessages").length, 1);
});

test("Trello uploads still create native attachments and schedule existing sync actions", async () => {
  const f = fixture({ clientBrandId: "brand1", trelloCardId: "card1", corTaskId: "123" });
  await f.register();
  assert.equal(f.all("taskAttachments").length, 1);
  assert.equal(f.all("threadUploadedFiles")[0].commentOnly, undefined);
  assert.deepEqual(f.scheduled.map(s => getFunctionName(s[1])), ["data/tasks:syncEditToCORAction", "data/trello:syncPendingTaskAttachmentsToTrello"]);
});

test("agent keeps the original Trello action and arguments, routes only uncategorized tasks", async () => {
  for (const task of [{ source: "external", clientBrandId: "brand1" }, { source: "external", trelloCardId: "card1" }, { source: "external" }]) {
    const calls: any[] = [];
    const tool: any = Object.assign({}, editExternalTaskTool, { ctx: { threadId: "thread1", promptMessageId: "request1", runQuery: async () => ({ ok: true, task }), runAction: async (ref: any, args: any) => { calls.push([getFunctionName(ref), args]); return { ok: true, applied: ["comment"] }; } } });
    await tool.execute({ comment: "Comentario" }, {});
    const direct = usesDirectExternalComments(task);
    assert.deepEqual(calls, [[direct ? "data/externalComments:submit" : "data/trello:editExternalTaskFromAgent", { threadId: "thread1", taskId: undefined, comment: "Comentario", ...(direct ? { requestMessageId: "request1", includePendingFiles: undefined } : {}) }]]);
  }
});

test("unrelated text does not consume files still awaiting confirmation", async () => {
  const f = fixture(); await f.register(); f.userMessage("textOnly");
  const text = await f.save({ requestMessageId: "textOnly", comment: "Cambiar el título" });
  assert.equal(f.rows.get(text.id).message, "Cambiar el título");
  assert.equal(f.all("threadUploadedFiles")[0].commentMessageId, undefined);
  f.userMessage("confirmation");
  const confirmation = await f.save({ requestMessageId: "confirmation", comment: "Agregar el archivo anterior", includePendingFiles: true });
  assert.equal(f.rows.get(confirmation.id).commentFileIds.length, 1);
});

test("initial brief uploads remain pending attachments, outside the comment-only route", async () => {
  const f = fixture(); f.rows.delete("task1");
  f.rows.get("draft1").status = "collecting"; delete f.rows.get("draft1").taskId;
  await f.register();
  assert.equal(f.all("threadUploadedFiles")[0].status, "pending");
  assert.equal(f.all("threadUploadedFiles")[0].commentOnly, undefined);
  assert.equal(f.all("taskMessages").length, 0);
  assert.equal(f.scheduled.length, 0);
});

test("delivery formats links for COR and never treats the noop provider as success", async () => {
  const f = fixture({ corTaskId: "123" }); await f.register(); const result = await f.save();
  await comments.deliverComment(f.ctx, result.id, { name: "noop", postTaskMessage: async () => { throw Error("must not call"); } } as any);
  assert.equal(f.rows.get(result.id).corMessageSyncStatus, "direct_pending");
  await comments.deliverComment(f.ctx, result.id, { name: "cor", postTaskMessage: async (data: any) => {
    assert.match(data.message, /<a href="https:\/\/files.example\/storage-request1"/);
    assert.match(data.message, /Referencia.pdf<\/a>/);
    return { success: true };
  } } as any);
  assert.equal(f.rows.get(result.id).corMessageSyncStatus, "synced");
});

test("stale delivery callbacks cannot change a later attempt", async () => {
  const f = fixture({ corTaskId: "123" }); const result = await f.save();
  await f.call(comments.claim, { id: result.id });
  await f.call(comments.markUncertain, { id: result.id, attempt: 1 });
  await f.call(comments.retryAfterReview, { id: result.id, confirmedAbsentInCOR: true });
  await f.call(comments.claim, { id: result.id });
  await f.call(comments.finish, { id: result.id, attempt: 1, success: true });
  await f.call(comments.markUncertain, { id: result.id, attempt: 1 });
  assert.equal(f.rows.get(result.id).corMessageSyncStatus, "direct_sending");
  assert.equal(f.rows.get(result.id).directDeliveryAttempt, 2);
});

test("agent quotes are stored separately without changing the summary", async () => {
  const f = fixture();
  const result = await f.save({ comment: "Cambiar la imagen", userQuote: "Usá esta foto" });
  const message = f.rows.get(result.id);
  assert.equal(message.message, "Cambiar la imagen");
  assert.equal(message.userQuote, "Usá esta foto");
});
