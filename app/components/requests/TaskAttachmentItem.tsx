"use client";
import { ExternalLink, FileText } from "lucide-react";
import { useTaskMedia, useTaskMediaSource } from "./TaskMediaContext";
import { isImageFile, type TaskMediaFile } from "./taskMedia";
import { useState } from "react";

function Thumbnail({ file }: { file: TaskMediaFile }) {
  const { source, failed, setFailed } = useTaskMediaSource(file);
  return source && !failed ? <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} className="h-16 w-20 rounded-lg border border-border object-cover" /> : <span className="flex h-16 w-20 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">{failed ? "Sin vista" : "Cargando…"}</span>;
}
export function TaskAttachmentItem({ file }: { file: TaskMediaFile }) {
  const { resolve } = useTaskMedia();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true); setError(false);
    const url = await resolve(file);
    setBusy(false);
    if (!url) { setError(true); return; }
    const link = document.createElement("a"); link.href = url; link.download = file.filename; link.target = "_blank"; link.rel = "noopener noreferrer"; link.click();
  }
  return <li className="flex min-w-0 items-center gap-3 rounded-lg p-2 hover:bg-muted/50">
    {isImageFile(file) ? <Thumbnail file={file} /> : <span className="flex h-16 w-20 shrink-0 flex-col items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground"><FileText className="mb-1 h-5 w-5" />{file.filename.split(".").pop()?.slice(0,6).toUpperCase()}</span>}
    <div className="min-w-0 flex-1">
      <button type="button" disabled={busy} onClick={open} className="break-words text-left text-sm font-semibold hover:text-primary hover:underline">{file.filename}</button>
      {file.createdAt && Number.isFinite(file.createdAt) ? <p className="mt-1 text-[11px] text-muted-foreground">Añadido: {new Date(file.createdAt).toLocaleDateString("es")}</p> : null}
      {error && <p role="status" className="text-xs text-muted-foreground">No se pudo abrir. Volvé a intentarlo.</p>}
    </div>
    <button type="button" disabled={busy} onClick={open} aria-label={`Abrir ${file.filename}`} className="shrink-0 rounded p-2 hover:bg-muted"><ExternalLink className="h-4 w-4 text-muted-foreground" /></button>
  </li>;
}
