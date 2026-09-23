"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ReactNode } from "react";
import { boardLabelColor, cardDeadline, creatorInitials } from "./cardPresentation";
import styles from "./BoardDialog.module.css";

export function BoardDialogMetadata({ taskId, members }: { taskId: Id<"tasks">; members?: ReactNode }) {
  const details = useQuery(api.data.tasks.getBoardDialogDetails, { taskId });
  return <div className={styles.metadata}>
    {members ?? <section><h3 className={styles.label}>Miembros</h3><div className={styles.members}>
      {details === undefined ? <span className={styles.muted}>Cargando…</span> : details?.members.length ? details.members.map(member => <span key={member.id} className={styles.avatar} title={member.name} aria-label={member.name}>{creatorInitials(member.name)}</span>) : <span className={styles.muted}>Sin miembros asignados</span>}
    </div></section>}
    <section><h3 className={styles.label}>Etiquetas</h3>
      {details?.label ? <span className={styles.tag} style={{ backgroundColor: boardLabelColor(details.label.color), color: details.label.color?.endsWith("_dark") ? "#fff" : "#172b4d" }}>{details.label.name}</span> : <span className={styles.muted}>{details === undefined ? "Cargando…" : "Sin etiqueta de marca"}</span>}
    </section>
  </div>;
}

export function BoardDialogDeadline({ deadline, status }: { deadline?: string; status: string }) {
  const due = cardDeadline(deadline, status === "finalizada");
  return <section className={styles.dueSection}><h3 className={styles.label}>Vencimiento</h3>
    {due ? <span className={styles.due} title={deadline}>{due.label}{due.overdue && <span className={styles.overdue}>Plazo vencido</span>}{due.completed && <span className={styles.complete}>Completada</span>}</span> : <span className={styles.muted}>Sin fecha de vencimiento</span>}
  </section>;
}
