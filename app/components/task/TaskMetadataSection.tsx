"use client";
import { TaskFieldButtonsContext } from "./TaskFieldButton";
import type { ReactNode } from "react";
import styles from "./TaskMetadataSection.module.css";
export function TaskMetadataSection({ collapsible, readOnly = false, children }: { collapsible: boolean; readOnly?: boolean; children: ReactNode }) {
  if (!collapsible) return <>{children}</>;
  return <TaskFieldButtonsContext.Provider value={true}><section aria-label="Datos de la tarea" className={`${styles.fields} ${readOnly ? styles.readOnly : ""}`}>{children}</section></TaskFieldButtonsContext.Provider>;
}
