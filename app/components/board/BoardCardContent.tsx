"use client";

import { AlignLeft, Clock3 } from "lucide-react";
import { useRequestBrief } from "../requests/useRequestBrief";
import { boardLabelColor, cardDeadline, creatorInitials } from "./cardPresentation";
import styles from "./BoardCard.module.css";

export function BoardCardContent({ title, description, deadline, status, label, deliverablesCount, createdByName, syncStatus }: {
  title: string; description?: string; deadline?: string; status: string;
  label?: { name: string; color?: string }; deliverablesCount?: number; createdByName?: string; syncStatus?: string;
}) {
  const brief = useRequestBrief(description);
  const due = cardDeadline(deadline, status === "finalizada");
  const count = deliverablesCount ?? brief.deliverablesCount;
  return <>
    {label && <span className={styles.label} style={{ backgroundColor: boardLabelColor(label.color) }} title={label.name} role="img" aria-label={`Marca: ${label.name}`} />}
    <span className={styles.title}>{title}</span>
    {(due || description?.trim()) && <span className={styles.badges}>
      {due && <span className={`${styles.deadline} ${due.overdue ? styles.overdue : due.completed ? styles.completed : ""}`} title={`${due.overdue ? "Vencida" : due.completed ? "Finalizada" : "Fecha de entrega"}: ${deadline}`}>
        <Clock3 size={14} aria-hidden="true" /><span>{due.label}</span>
      </span>}
      {description?.trim() && <span role="img" aria-label="Tiene descripción" title="Tiene descripción"><AlignLeft size={16} aria-hidden="true" /></span>}
    </span>}
    {(brief.requestType || count !== "" && count !== undefined) && <span className={styles.fields}>
      {brief.requestType && <span className={styles.field} title={`Tipo de requerimiento: ${brief.requestType}`}>Tipo de requerimiento: {brief.requestType}</span>}
      {count !== "" && count !== undefined && <span className={styles.field}>Cantidad de entregables: {count}</span>}
    </span>}
    {syncStatus && ["syncing", "retrying", "error"].includes(syncStatus) && <span className={`${styles.sync} ${syncStatus === "error" ? styles.error : ""}`}>{syncStatus === "error" ? "Revisar sincronización" : syncStatus === "retrying" ? "Reintentando sincronización…" : "Publicando en COR…"}</span>}
    {createdByName?.trim() && <span className={styles.footer}><span className={styles.avatar} title={`Creada por ${createdByName}`} aria-label={`Creada por ${createdByName}`}>{creatorInitials(createdByName)}</span></span>}
  </>;
}
