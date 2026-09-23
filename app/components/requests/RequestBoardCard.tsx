"use client";

import Link from "next/link";
import type { ExternalRequest } from "./types";
import { BoardCardContent } from "../board/BoardCardContent";
import styles from "../board/BoardCard.module.css";

export function RequestBoardCard({ request }: { request: ExternalRequest }) {
  return <Link href={`/workspace/requests?taskId=${encodeURIComponent(request._id)}`} scroll={false} aria-haspopup="dialog" aria-label={request.title} className={styles.card}>
    <BoardCardContent title={request.title} description={request.description} deadline={request.deadline}
      status={request.status} label={request.boardLabel} deliverablesCount={request.deliverablesCount}
      createdByName={request.createdByName} />
  </Link>;
}
