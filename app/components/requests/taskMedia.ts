export type TaskMediaFile = {
  id: string; filename: string; mimeType: string; size?: number;
  createdAt?: number; url: string | null; mediaUrl?: string | null;
  sourceUrls: string[]; trelloAttachmentId?: string;
};
export function trelloAttachmentId(source: string): string | undefined {
  try {
    const url = new URL(source);
    if (!["trello.com", "api.trello.com"].includes(url.hostname)) return undefined;
    return url.pathname.match(/\/attachments\/([^/]+)\//)?.[1];
  } catch { return undefined; }
}
export function findTaskMedia(files: TaskMediaFile[], source: string) {
  const id = trelloAttachmentId(source);
  return files.find(file => file.sourceUrls.includes(source) || file.url === source || (id && file.trelloAttachmentId === id));
}
export function isImageFile(file: Pick<TaskMediaFile, "mimeType" | "filename">) {
  return /^(image\/(png|jpeg|gif|webp|avif))$/i.test(file.mimeType) || /\.(png|jpe?g|gif|webp|avif)$/i.test(file.filename);
}
export function mergeTaskMedia(
  local: Array<{ id: string; filename: string; mimeType: string; size?: number; createdAt: number; url: string | null; trelloAttachmentId?: string; trelloUrl?: string; corUrl?: string }>,
  remote: Array<{ id: string; filename: string; mimeType: string; size?: number; createdAt?: string; sourceUrl: string; mediaUrl: string | null; isUpload: boolean }>,
): TaskMediaFile[] {
  const files: TaskMediaFile[] = local.map(file => ({ ...file, sourceUrls: [file.url, file.trelloUrl, file.corUrl].filter((url): url is string => Boolean(url)) }));
  for (const file of remote) {
    const existing = files.find(item => item.trelloAttachmentId === file.id || item.sourceUrls.includes(file.sourceUrl));
    if (existing) {
      existing.sourceUrls.push(file.sourceUrl);
      existing.mediaUrl = file.mediaUrl;
    } else files.push({ ...file, id: `trello-${file.id}`, trelloAttachmentId: file.id, createdAt: file.createdAt ? Date.parse(file.createdAt) : undefined, url: file.isUpload ? null : /^https?:\/\//i.test(file.sourceUrl) ? file.sourceUrl : null, sourceUrls: [file.sourceUrl] });
  }
  return files.sort((a,b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
