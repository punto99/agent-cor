import type { JSONContent } from "@tiptap/react";

export function serializeComment(doc: JSONContent, fileIds: string[]): string {
  function render(node: JSONContent): string {
    const children = () => (node.content ?? []).map(render).join("");
    if (node.type === "draftFile") return `\n\n{{task-panel-file:${fileIds.indexOf(node.attrs?.fileId)}}}\n\n`;
    if (node.type === "text") {
      let text = (node.text ?? "").replace(/[\\`*_{}\[\]<>!#]/g, "\\$&");
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") text = `**${text}**`;
        if (mark.type === "italic") text = `*${text}*`;
      }
      return text;
    }
    if (node.type === "hardBreak") return "\n";
    if (node.type === "paragraph") return `${children()}\n\n`;
    if (node.type === "listItem") return children().trim().replace(/\n/g, "\n  ");
    if (node.type === "bulletList" || node.type === "orderedList") return (node.content ?? []).map((item, i) => `${node.type === "bulletList" ? "-" : `${i + 1}.`} ${render(item)}`).join("\n") + "\n\n";
    return children();
  }
  return render(doc).trim();
}
export function commentFileIds(doc: JSONContent): string[] {
  const ids: string[] = [];
  const visit = (node: JSONContent) => { if (node.type === "draftFile" && typeof node.attrs?.fileId === "string" && !ids.includes(node.attrs.fileId)) ids.push(node.attrs.fileId); node.content?.forEach(visit); };
  visit(doc);
  return ids;
}
