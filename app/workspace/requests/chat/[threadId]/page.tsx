"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import ChatInterface from "@/app/ChatInterface";

export default function RequestChatPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = use(params);
  const thread = useQuery(api.messaging.threads.getThread, { threadId });

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <Link href="/workspace/requests" className="text-sm font-medium text-primary hover:underline">← Mis tareas</Link>
      </div>
      {thread === undefined ? <p role="status" className="p-8 text-muted-foreground">Cargando conversación…</p> : thread === null ? (
        <div role="status" className="p-8">
          <h1 className="text-lg font-semibold">Chat no disponible</h1>
          <p className="mt-2 text-sm text-muted-foreground">Esta conversación ya no está disponible. Podés volver al panel para consultar tu tarea.</p>
        </div>
      ) : <div className="min-h-0 flex-1"><ChatInterface key={threadId} threadId={threadId} hideHeader /></div>}
    </div>
  );
}
