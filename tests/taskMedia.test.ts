import test from "node:test";
import assert from "node:assert/strict";
import { mergeTaskMedia, findTaskMedia, trelloAttachmentId } from "../app/components/requests/taskMedia";
import { media } from "../convex/taskPanelMediaHttp";
import { trelloProvider } from "../convex/integrations/trelloProvider";

const remote = { id: "a1", filename: "image.png", mimeType: "image/png", sourceUrl: "https://trello.com/1/cards/c1/attachments/a1/download/image.png", mediaUrl: "https://app.convex.site/task-panel/media?taskId=t1&attachmentId=a1", isUpload: true };
test("merges old and remote attachments without duplicates; recognizes Trello URL variants", () => {
  const files = mergeTaskMedia([{ id: "local1", filename: "image.png", mimeType: "image/png", createdAt: 1, url: "https://storage.example/image", trelloAttachmentId: "a1" }], [remote]);
  assert.equal(files.length, 1);
  assert.equal(findTaskMedia(files, "https://api.trello.com/1/cards/c1/attachments/a1/download/image.webp")?.url, "https://storage.example/image");
  assert.equal(trelloAttachmentId("https://evil.example/attachments/a1/download/x"), undefined);
  assert.equal(mergeTaskMedia([], [remote])[0].url, null);
  assert.equal(mergeTaskMedia([], [remote])[0].mediaUrl, remote.mediaUrl);
});
test("remote downloads require authentication and a matching attachment on the task's card", async t => {
  let downloads = 0;
  t.mock.method(trelloProvider, "listCardAttachments", async () => [{ id: "a1", name: "image.png", url: remote.sourceUrl, isUpload: true }]);
  t.mock.method(trelloProvider, "downloadAttachment", async (args: any) => { downloads++; assert.equal(args.cardId, "c1"); assert.equal(args.url, undefined); return { blob: new Blob(["image"], { type: "image/png" }), filename: "image.png", mimeType: "image/png", url: remote.sourceUrl }; });
  const ctx: any = { auth: { getUserIdentity: async () => null }, runQuery: async () => ({ cardId: "c1" }) };
  const handler = (media as any)._handler;
  assert.equal((await handler(ctx, new Request("https://app.convex.site/task-panel/media?taskId=t1&attachmentId=a1"))).status, 401);
  ctx.auth.getUserIdentity = async () => ({ subject: "u1|session" });
  assert.equal((await handler(ctx, new Request("https://app.convex.site/task-panel/media?taskId=t1&attachmentId=foreign"))).status, 404);
  assert.equal(downloads, 0);
  const response = await handler(ctx, new Request("https://app.convex.site/task-panel/media?taskId=t1&attachmentId=a1"));
  assert.equal(response.status, 200); assert.equal(await response.text(), "image"); assert.equal(downloads, 1);
  ctx.runQuery = async () => { throw new Error("Forbidden task"); };
  assert.equal((await handler(ctx, new Request("https://app.convex.site/task-panel/media?taskId=foreign&attachmentId=a1"))).status, 403);
  assert.equal(downloads, 1);
});
