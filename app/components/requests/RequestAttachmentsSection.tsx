"use client";
import { useState } from "react";
import { Paperclip, Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/Button";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskPanelFilePicker } from "./TaskPanelFilePicker";
import { TaskAttachmentItem } from "./TaskAttachmentItem";
import { useTaskMedia } from "./TaskMediaContext";
import { useTaskPanelSubmit } from "./useTaskPanelActivity";

export function RequestAttachmentsSection({ taskId }: { taskId: Id<"tasks"> }) {
  const media = useTaskMedia();
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState(false);
  const submission = useTaskPanelSubmit(taskId);
  return <section aria-labelledby="request-attachments-title" className="mt-8 border-t border-border pt-6">
    <h3 id="request-attachments-title" className="mb-4 flex items-center gap-2 text-sm font-semibold"><Paperclip className="h-4 w-4" />Archivos adjuntos</h3>
    {media.files.length ? <><ul className="mb-3 space-y-1">{(expanded ? media.files : media.files.slice(0, 4)).map(file => <TaskAttachmentItem key={file.id} file={file} />)}</ul>{media.files.length > 4 && <Button variant="outline" size="sm" className="mb-4" onClick={() => setExpanded(value => !value)}>{expanded ? "Mostrar menos" : `Ver todos los adjuntos (${media.files.length - 4} ocultos)`}</Button>}</> : <p role="status" className="mb-4 text-xs text-muted-foreground">{media.loading ? "Cargando archivos…" : "No hay adjuntos disponibles para mostrar."}</p>}
    {media.error && <p role="status" className="mb-3 text-xs text-muted-foreground">No se pudieron consultar todos los archivos. <button type="button" onClick={media.refresh} className="text-primary underline">Reintentar</button></p>}
    <TaskPanelFilePicker files={files} onChange={next => { setFiles(next); setSaved(false); }} disabled={submission.busy} />
    {files.length > 0 && <Button size="sm" className="mt-3" disabled={submission.busy} onClick={async () => { if (await submission.save("", files)) { setFiles([]); setSaved(true); } }}>{submission.busy && <Loader2 className="h-4 w-4 animate-spin" />}Guardar archivos</Button>}
    {submission.error && <p role="alert" className="mt-3 text-xs text-destructive">{submission.error}</p>}
    {saved && <p role="status" className="mt-3 text-xs text-muted-foreground">Archivos guardados. La sincronización continúa en segundo plano.</p>}
  </section>;
}
