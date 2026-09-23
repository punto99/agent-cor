"use client";

import { Hash, TextCursorInput, Type } from "lucide-react";
import { useRequestBrief } from "../requests/useRequestBrief";
import styles from "./BoardDialog.module.css";

export function BoardCustomFields({ description, deliverablesCount }: {
  description?: string;
  deliverablesCount?: number;
}) {
  const brief = useRequestBrief(description);
  const requestType = brief.requestType || "No especificado";
  const count = deliverablesCount ?? (brief.deliverablesCount || "No especificada");

  return <section className={styles.customFields} aria-label="Campos personalizados">
    <h3><TextCursorInput aria-hidden="true" />Campos personalizados</h3>
    <dl className={styles.customFieldsGrid}>
      <div>
        <dt><Type aria-hidden="true" />Tipo de requerimiento</dt>
        <dd title={requestType}>{requestType}</dd>
      </div>
      <div>
        <dt><Hash aria-hidden="true" />Cantidad de entregables</dt>
        <dd title={String(count)}>{count}</dd>
      </div>
    </dl>
  </section>;
}
