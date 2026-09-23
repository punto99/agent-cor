"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RequestDetailDialog } from "./RequestDetailDialog";
import { BOARD_STAGES } from "./boardStages";
import type { ExternalRequest } from "./types";

// Resolve against the full authorized list, independently of board filters.
export function RequestDialogRoute({ requests }: { requests: ExternalRequest[] | undefined }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const taskId = params.get("taskId");
  if (!taskId || requests === undefined) return null;
  const request = requests.find(task => task._id === taskId);
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("taskId");
    next.delete("tab");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  if (!request) return <div role="status" className="mx-4 my-4 rounded-lg border border-border bg-card p-4 text-sm sm:mx-8">
    <p>Esta tarea no está disponible o no tenés permiso para verla.</p>
    <button type="button" onClick={close} className="mt-2 text-primary hover:underline">Volver a mis tareas</button>
  </div>;
  const stage = BOARD_STAGES.find(stage => stage.key === request.status) ?? {
    key: request.status, label: request.status || "Sin estado", subtitle: "Estado de la tarea", accent: "", cardAccent: "",
  };
  return <RequestDetailDialog key={request._id} request={request} stage={stage} onClose={close} />;
}
