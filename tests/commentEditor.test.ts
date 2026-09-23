import test from "node:test";
import assert from "node:assert/strict";
import { serializeComment, commentFileIds } from "../app/components/requests/comment-editor/serializeComment";
import { resolvePanelComment, formatPanelCommentForCOR } from "../convex/lib/taskPanelComment";

test("serializes file positions, formatting and excludes removed draft files", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Antes", marks: [{ type: "bold" }] }] }, { type: "draftFile", attrs: { fileId: "b", preview: "blob:private" } }, { type: "paragraph", content: [{ type: "text", text: "Después" }] }, { type: "draftFile", attrs: { fileId: "a" } }] };
  assert.deepEqual(commentFileIds(doc), ["b", "a"]);
  const text = serializeComment(doc, commentFileIds(doc));
  const message = resolvePanelComment(text, [{ filename: "foto.png", mimeType: "image/png", url: "https://files/image" }, { filename: "brief.pdf", mimeType: "application/pdf", url: "https://files/pdf" }]);
  assert.match(message, /\*\*Antes\*\*[\s\S]*!\[foto.png\]\(https:\/\/files\/image\)[\s\S]*Después[\s\S]*\[brief.pdf\]/);
  assert.ok(!message.includes("blob:") && !message.includes("Archivos adjuntos"));
  doc.content.splice(1, 1);
  assert.deepEqual(commentFileIds(doc), ["a"]);
});
test("rejects missing files and preserves legacy attachment suffix", () => {
  assert.throws(() => resolvePanelComment("{{task-panel-file:1}}", []));
  assert.equal(resolvePanelComment("Texto", [{ filename: "a.png", mimeType: "image/png", url: "https://files/a" }]), "Texto\n\nArchivos adjuntos:\n- [a.png](https://files/a)");
});
test("COR format escapes HTML, preserves emphasis and uses safe file links", () => {
  const result = formatPanelCommentForCOR('**Hola** *mundo*\n![foto](https://files/image)\n<script>alert(1)</script>\n[x](javascript:alert)');
  assert.match(result, /<strong>Hola<\/strong> <em>mundo<\/em>/);
  assert.match(result, /<a href="https:\/\/files\/image"/);
  assert.ok(!result.includes("<script>") && !result.includes('href="javascript:'));
  assert.equal(formatPanelCommentForCOR('\\*literal\\*'), '*literal*');
});
