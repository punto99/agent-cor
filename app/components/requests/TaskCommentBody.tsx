"use client";
import { useState } from "react";
import { FileText } from "lucide-react";
import styles from "./Comments.module.css";
import ReactMarkdown from "react-markdown";
import { useTaskMedia, useTaskMediaSource } from "./TaskMediaContext";
import { isImageFile, trelloAttachmentId, type TaskMediaFile } from "./taskMedia";

function StoredImage({ file, alt }: { file: TaskMediaFile; alt: string }) {
  const { source, failed, setFailed } = useTaskMediaSource(file);
  return source && !failed ? <a href={source} download={file.filename} target="_blank" rel="noopener noreferrer" className="my-3 block"><img src={source} alt={alt} onError={() => setFailed(true)} loading="lazy" className="max-h-80 max-w-full rounded-lg object-contain" /></a> : <span className="my-3 block rounded border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{failed ? `Imagen no disponible: ${alt}` : "Cargando imagen…"}</span>;
}
function CommentImage({ source, alt }: { source: string; alt: string }) {
  const { find, loading } = useTaskMedia();
  const file = find(source);
  const [failed, setFailed] = useState(false);
  if (file) return <StoredImage file={file} alt={alt || file.filename} />;
  if (trelloAttachmentId(source)) return <span className="my-3 block text-xs text-muted-foreground">{loading ? "Cargando imagen…" : `Imagen no disponible: ${alt}`}</span>;
  return failed ? <span className="block text-xs text-muted-foreground">Imagen no disponible: {alt}</span> : <img src={source} alt={alt} onError={() => setFailed(true)} loading="lazy" className="my-3 max-h-80 max-w-full rounded-lg object-contain" />;
}
function CommentAttachmentLink({ file, children }: { file: TaskMediaFile; children: React.ReactNode }) {
  const { resolve } = useTaskMedia();
  const [error, setError] = useState(false);
  if (isImageFile(file)) return <StoredImage file={file} alt={file.filename} />;
  return <><button type="button" className="text-left text-primary underline" onClick={async () => { const url = await resolve(file); if (!url) { setError(true); return; } const a = document.createElement("a"); a.href = url; a.download = file.filename; a.target = "_blank"; a.rel = "noopener noreferrer"; a.click(); }}>{children}</button>{error && <span className="ml-2 text-xs text-muted-foreground">Archivo no disponible</span>}</>;
}
function AttachmentCard({ file, source, name }: { file?: TaskMediaFile; source: string; name: string }) {
  const { source: resolved, failed, setFailed } = useTaskMediaSource(file);
  const url = file ? resolved : (/^https?:\/\//i.test(source) ? source : null);
  const image = file ? isImageFile(file) : /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(source);
  const filename = file?.filename || name || "Archivo adjunto";
  const extension = filename.split(".").pop()?.toUpperCase();
  const size = file?.size ? (file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`) : "";
  return <a href={url || undefined} aria-disabled={!url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex max-w-full items-center gap-3 rounded-xl border border-border bg-muted/50 p-2 no-underline transition-colors hover:bg-muted">
    <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">{image && url && !failed ? <img src={url} alt={filename} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" /> : <FileText className="h-6 w-6 text-muted-foreground" />}</span>
    <span className="min-w-0 pr-2"><span className="block truncate text-xs font-medium text-foreground">{filename}</span><span className="mt-1 block font-mono text-[10px] tracking-wide text-muted-foreground">{failed ? "No disponible" : !url ? "Cargando…" : [extension, size].filter(Boolean).join(" · ")}</span></span>
  </a>;
}
export function TaskCommentBody({ text, quote }: { text: string; quote?: string }) {
  const { find } = useTaskMedia();
  const attachments: { file?: TaskMediaFile; source: string; name: string }[] = [];
  const body = text.replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (match, name: string, source: string) => {
    const file = find(source);
    if (!file && !match.startsWith("!")) return match;
    if (!attachments.some(item => item.source === source)) attachments.push({ file, source, name });
    return "";
  }).replace(/^\s*[-*]\s*$/gm, "").replace(/Archivos adjuntos:\s*(?=\n*$)/i, "").trim();
  return <div className="break-words text-sm leading-relaxed [&_p]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
    <ReactMarkdown skipHtml components={{
      img: ({ src, alt }) => <CommentImage source={typeof src === "string" ? src : ""} alt={alt ?? "Imagen adjunta"} />,
      a: ({ children, href }) => { const file = href ? find(href) : undefined; return file ? <CommentAttachmentLink file={file}>{children}</CommentAttachmentLink> : <a className="text-primary underline" href={href} target="_blank" rel="noopener noreferrer">{children}</a>; },
    }}>{body}</ReactMarkdown>
    {quote && <blockquote className={styles.quote}>“{quote}”</blockquote>}
    {attachments.length > 0 && <div className="flex flex-wrap gap-x-2">{attachments.map(item => <AttachmentCard key={item.source} {...item} />)}</div>}
  </div>;
}
