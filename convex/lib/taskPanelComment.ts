// Only panel comments use local placeholders. Existing chat/Trello consumers stay unchanged.
export function resolvePanelComment(text: string, files: { filename: string; mimeType: string; url: string }[]): string {
  const used = new Set<number>();
  const link = (index: number, image = true) => {
    const file = files[index];
    if (!file) throw new Error("El comentario referencia un archivo que no está adjunto.");
    const label = file.filename.replace(/[\\\[\]\r\n]/g, " ");
    return `${image && file.mimeType.startsWith("image/") ? "!" : ""}[${label}](${file.url})`;
  };
  const body = text.replace(/\{\{task-panel-file:(-?\d+)\}\}/g, (_match, value: string) => { const index = Number(value); used.add(index); return link(index); });
  const remaining = files.flatMap((_, index) => used.has(index) ? [] : [`- ${link(index, false)}`]);
  return [body, remaining.length ? `Archivos adjuntos:\n${remaining.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

// COR receives conservative HTML; files remain links because its message API
// does not guarantee support for embedded images. Never pass user HTML through.
export function formatPanelCommentForCOR(markdown: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  function inline(value: string): string {
    const pattern = /\\([\\`*_{}\[\]<>!#])|!?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|\*([^*]+)\*/g;
    let result = "", offset = 0;
    for (const match of value.matchAll(pattern)) {
      result += escape(value.slice(offset, match.index));
      if (match[1]) result += escape(match[1]);
      else if (match[2]) result += `<a href="${escape(match[3])}" target="_blank" rel="noopener noreferrer">${escape(match[2])}</a>`;
      else if (match[4]) result += `<strong>${inline(match[4])}</strong>`;
      else result += `<em>${inline(match[5])}</em>`;
      offset = match.index! + match[0].length;
    }
    return result + escape(value.slice(offset));
  }
  return markdown.split("\n").map(line => inline(line)).join("<br>");
}
