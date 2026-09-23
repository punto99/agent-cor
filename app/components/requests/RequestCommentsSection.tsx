"use client";
import { CommentUnreadBadge } from "../notifications/CommentNotifications";
import { useReadVisibleComments } from "../notifications/useReadVisibleComments";
import { useState } from "react";
import { MessageSquare, Loader2, Reply, ListFilter } from "lucide-react";
import { TaskCommentBody } from "./TaskCommentBody";
import { Button } from "@/app/components/ui/Button";
import type { Id } from "@/convex/_generated/dataModel";
import { CommentEditor } from "./comment-editor/CommentEditor";
import { useTaskPanelActivity, useTaskPanelSubmit } from "./useTaskPanelActivity";
import styles from "./Comments.module.css";

type Comment = NonNullable<ReturnType<typeof useTaskPanelActivity>>["comments"][number];

function CommentComposer({ taskId, replyTo, onDone }: {
  taskId: Id<"tasks">; replyTo?: Comment; onDone?: () => void;
}) {
  const [editorKey, setEditorKey] = useState(0);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const submission = useTaskPanelSubmit(taskId);
  return <form onSubmit={async event => {
    event.preventDefault();
    if (await submission.save(text, files, replyTo?.id)) {
      setText(""); setFiles([]); setEditorKey(key => key + 1); onDone?.();
    }
  }} className={styles.composer}>
    {replyTo && <p className="mb-2 text-xs text-muted-foreground">Responder a {replyTo.own ? "tu comentario" : replyTo.authorName || "este comentario"}</p>}
    <CommentEditor key={editorKey} disabled={submission.busy} onChange={(value, selected) => { setText(value); setFiles(selected); }} footer={<div className={styles.footer}>
      <Button type="submit" size="sm" disabled={submission.busy || !text.trim() || text.length > 10000}>
        {submission.busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        {submission.busy ? "Enviando…" : replyTo ? "Responder" : "Comentar"}
      </Button>
      {replyTo ? <Button type="button" variant="ghost" size="sm" disabled={submission.busy} onClick={() => {
        if ((!text.trim() && !files.length) || window.confirm("¿Descartar esta respuesta?")) onDone?.();
      }}>Cancelar</Button> : <span className={styles.hint}>Los archivos se suben al publicar</span>}
    </div>} />
    {text.length > 10000 && <p role="alert" className="mt-2 text-xs text-destructive">El comentario supera los 10.000 caracteres.</p>}
    {submission.error && <p role="alert" className="mt-3 text-xs text-destructive">{submission.error}</p>}
  </form>;
}

function CommentContent({ comment }: { comment: Comment }) {
  const name = comment.authorName?.trim() || "Comentario";
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  const date = new Date(comment.createdAt);
  return <div className="flex min-w-0 gap-3">
    <div aria-hidden="true" className={`${styles.avatar} ${comment.own ? styles.own : ""}`}>{initials}</div>
    <div className="min-w-0 flex-1">
      <div className={styles.meta} data-comment-id={comment.id}>
        <span className={styles.name}>{name}</span>
        <time dateTime={date.toISOString()} title={date.toLocaleString("es")} className={styles.time}>{date.toLocaleDateString("es")} · {date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</time>
        {comment.isClient && <span className={styles.client}>CLIENTE</span>}
      </div>
      <TaskCommentBody text={comment.text} quote={comment.quote} />
    </div>
  </div>;
}

function CommentThread({ comment, replies, taskId }: { comment: Comment; replies: Comment[]; taskId: Id<"tasks"> }) {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(true);
  return <article className={styles.card}>
    <CommentContent comment={comment} />
    <div className="ml-[46px] mt-2">
      <button type="button" aria-expanded={replying} onClick={() => { setReplying(true); setExpanded(true); }} className={styles.action}><Reply className="h-3 w-3" />Responder</button>
      {replies.length > 0 && <div className="mt-2"><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className={`${styles.action} !font-mono !text-[10px] tracking-wide`}><span aria-hidden="true" className="mr-1 h-px w-4 bg-border" />{expanded ? "Ocultar" : "Mostrar"} {replies.length} {replies.length === 1 ? "respuesta" : "respuestas"}</button></div>}
      {(expanded && replies.length > 0 || replying) && <div className={styles.replies}>
        {expanded && replies.map(reply => <article className={styles.reply} key={reply.id}><CommentContent comment={reply} /></article>)}
        {replying && <div className="mt-4"><CommentComposer taskId={taskId} replyTo={comment} onDone={() => setReplying(false)} /></div>}
      </div>}
    </div>
  </article>;
}

function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const prefix = date.toDateString() === today.toDateString() ? "Hoy · " : date.toDateString() === yesterday.toDateString() ? "Ayer · " : "";
  return prefix + date.toLocaleDateString("es", { day: "numeric", month: "short", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
}

export function RequestCommentsSection({ taskId, appearance = "trello" }: { taskId: Id<"tasks">; appearance?: "trello" | "classic" }) {
  const readRoot = useReadVisibleComments(taskId);
  const data = useTaskPanelActivity(taskId);
  const [oldestFirst, setOldestFirst] = useState(false);
  const needsReview = data?.entries.some(e => e.trelloState === "needs_review" || e.corState === "needs_review");
  const pending = data?.entries.some(e => ["waiting", "sending"].includes(e.trelloState) || ["waiting", "sending"].includes(e.corState));
  const comments = data?.comments ?? [];
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const roots: Comment[] = [];
  const replies = new Map<string, Comment[]>();
  // Flatten any historical deeper threads for display; new nested replies are rejected server-side.
  for (const comment of comments) {
    let root = comment;
    const seen = new Set([comment.id]);
    while (root.replyTo && byId.has(root.replyTo) && !seen.has(root.replyTo)) {
      seen.add(root.replyTo); root = byId.get(root.replyTo)!;
    }
    if (root.id === comment.id) roots.push(comment);
    else replies.set(root.id, [...(replies.get(root.id) ?? []), comment]);
  }
  roots.sort((a, b) => oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  const replyCount = comments.length - roots.length;
  return <aside ref={readRoot} aria-labelledby="request-comments-title" className={`${styles.panel} ${appearance === "classic" ? styles.classic : ""} flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-border lg:border-l lg:border-t-0`}>
    <div className={styles.header}>
      <MessageSquare className="h-4 w-4 shrink-0" />
      <h3 id="request-comments-title">Comentarios <CommentUnreadBadge taskId={taskId} /></h3>
      {data && <span className={styles.count}>{roots.length} {roots.length === 1 ? "hilo" : "hilos"} · {replyCount} {replyCount === 1 ? "respuesta" : "respuestas"}</span>}
    </div>
    <div className={styles.toolbar}><label className="flex items-center gap-1.5"><ListFilter className="h-3 w-3 text-muted-foreground" /><select aria-label="Orden de los comentarios" value={oldestFirst ? "oldest" : "newest"} onChange={event => setOldestFirst(event.target.value === "oldest")} className={styles.sort}><option value="newest">Más recientes</option><option value="oldest">Más antiguos</option></select></label></div>
    <div className={styles.body}>
      <CommentComposer key={taskId} taskId={taskId} />
      {needsReview && <p role="status" className="mt-3 text-xs text-destructive">Hay contenido guardado cuya sincronización requiere revisión. No se reenvía automáticamente para evitar duplicados.</p>}
      {pending && <p role="status" className="mt-3 text-xs text-muted-foreground">Hay contenido guardado pendiente de sincronización o de publicación de la tarea.</p>}
      {data === undefined ? <p role="status" className="mt-6 text-xs text-muted-foreground">Cargando comentarios…</p> : roots.length ? roots.map((comment, index) => <div key={comment.id}>
        {(index === 0 || new Date(comment.createdAt).toDateString() !== new Date(roots[index - 1].createdAt).toDateString()) && <div className={styles.day}>{dayLabel(comment.createdAt)}</div>}
        <div className="mb-3"><CommentThread taskId={taskId} comment={comment} replies={(replies.get(comment.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)} /></div>
      </div>) : <div className="py-8 text-center"><MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground/50" /><p className="text-sm font-medium">Iniciá la conversación</p><p className="mt-1 text-xs text-muted-foreground">Compartí una idea, una consulta o un archivo.</p></div>}
    </div>
  </aside>;
}
