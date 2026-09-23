"use client";
import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/app/components/ui/Button";

export function TaskPanelFilePicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div>
    <input ref={input} type="file" multiple className="hidden" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={e => { onChange([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} disabled={disabled} />
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()}><Paperclip className="h-4 w-4" />Adjuntar archivos</Button>
    <p className="mt-2 text-[11px] text-muted-foreground">Imágenes, PDF o Word · Hasta 20 MB por archivo</p>
    {files.length > 0 && <ul className="mt-3 space-y-2">{files.map((file, index) => <li key={index} className="flex min-w-0 items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs"><span className="min-w-0 flex-1 truncate">{file.name}</span><button type="button" disabled={disabled} aria-label={`Quitar ${file.name}`} onClick={() => onChange(files.filter((_, i) => i !== index))} className="rounded p-1 hover:bg-muted"><X className="h-3 w-3" /></button></li>)}</ul>}
  </div>;
}
