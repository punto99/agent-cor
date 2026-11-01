"use client";

import { useEffect, useId, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../../components/ui/Button";

export function ExternalBoardConfirmDialog({ clientName, enabled, saving, onClose, onConfirm }: {
  clientName: string;
  enabled: boolean;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}
    className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50 backdrop:backdrop-blur-sm">
    <div className="p-6">
      <h2 id={titleId} className="text-lg font-semibold">{enabled ? "¿Activar el board externo?" : "¿Desactivar el board externo?"}</h2>
      <div id={descriptionId} className="mt-3 space-y-3 text-sm text-muted-foreground">
        <p>{enabled
          ? `Los externos de ${clientName} podrán ver el board según sus permisos y recibir las notificaciones y correos correspondientes.`
          : `Los externos de ${clientName} dejarán de ver el board y de recibir sus notificaciones y correos.`}</p>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="outline" autoFocus disabled={saving} onClick={onClose}>Cancelar</Button>
        <Button type="button" disabled={saving} onClick={onConfirm}>
          {saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {saving ? "Guardando..." : enabled ? "Sí, activar" : "Sí, desactivar"}
        </Button>
      </div>
    </div>
  </dialog>;
}
