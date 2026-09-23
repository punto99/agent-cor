"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useTaskPanelActivity(taskId: Id<"tasks">) {
  return useQuery(api.data.taskPanel.detail, { taskId });
}

export function useTaskPanelSubmit(taskId: Id<"tasks">) {
  const token = useAuthToken();
  const prepare = useMutation(api.data.taskPanel.prepareUpload);
  const submit = useMutation(api.data.taskPanel.submit);
  const locked = useRef(false);
  const uploads = useRef(new Map<File, { key: string; id?: Id<"taskPanelUploads"> }>());
  const operation = useRef<{ payload: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(text: string, files: File[], replyTo?: Id<"taskMessages">) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true); setError(null);
    try {
      if (!token) throw new Error("Tu sesión expiró. Volvé a iniciar sesión.");
      if (files.length > 10) throw new Error("Podés adjuntar hasta 10 archivos por envío.");
      const ids: Id<"taskPanelUploads">[] = [];
      for (const file of files) {
        if (file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: el tamaño debe ser de hasta 20 MB.`);
        const cached = uploads.current.get(file) ?? { key: crypto.randomUUID() };
        uploads.current.set(file, cached);
        if (!cached.id) {
          const ticket = await prepare({ taskId, key: cached.key, filename: file.name, mimeType: file.type, size: file.size });
          if (!ticket.ready) {
            const response = await fetch(ticket.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type }, body: file });
            if (!response.ok) { const result = await response.json(); throw new Error(result.error || "No se pudo subir el archivo."); }
          }
          cached.id = ticket.uploadId;
        }
        ids.push(cached.id);
      }
      const payload = JSON.stringify({ text: text.trim(), ids, replyTo });
      if (operation.current?.payload !== payload) operation.current = { payload, key: crypto.randomUUID() };
      await submit({ taskId, key: operation.current.key, text, uploadIds: ids, replyTo });
      uploads.current.clear(); operation.current = null;
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo guardar. Tus archivos y comentario siguen aquí para reintentar.");
      return false;
    } finally { locked.current = false; setBusy(false); }
  }
  return { save, busy, error };
}
