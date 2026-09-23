"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { WorkspaceLayout } from "../components/WorkspaceLayout";
import { LoadingScreen } from "../components/LoadingScreen";
import ChatInterface from "../ChatInterface";
// COMENTADO: TaskPanel movido a Panel de Control como dialog
// import TaskPanel from "../TaskPanel";
// import { clientConfig } from "@/config/tenant.config";

export default function WorkspacePage() {
  return <Suspense fallback={<LoadingScreen />}><WorkspaceChat /></Suspense>;
}

function WorkspaceChat() {
  const requestedThreadId = useSearchParams().get("threadId");
  const handledThreadId = useRef<string | null>(null);
  const requestedThread = useQuery(
    api.messaging.threads.getThread,
    requestedThreadId ? { threadId: requestedThreadId } : "skip",
  );
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  // COMENTADO: TaskPanel movido a Panel de Control
  // const [isTaskPanelOpen, setIsTaskPanelOpen] = useState(false);
  // const [userClosedPanel, setUserClosedPanel] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const {
    results: threads,
    status: threadsStatus,
    loadMore,
  } = usePaginatedQuery(
    api.messaging.threads.getMyThreads,
    {},
    { initialNumItems: 20 },
  );
  const createThread = useMutation(api.messaging.threads.createThread);

  // Verificar si el thread actual tiene mensajes
  const hasMessages = useQuery(
    api.messaging.threads.hasThreadMessages,
    currentThreadId ? { threadId: currentThreadId } : "skip",
  );

  // COMENTADO: TaskPanel movido a Panel de Control
  // const tasks = useQuery(
  //   api.data.tasks.listByThread,
  //   currentThreadId ? { threadId: currentThreadId } : "skip",
  // );

  // Estado para evitar múltiples creaciones automáticas
  const [hasAutoCreated, setHasAutoCreated] = useState(false);

  // Seleccionar el primer thread si existe y no hay uno seleccionado
  // O auto-crear uno si el usuario no tiene ningún thread
  useEffect(() => {
    if (threadsStatus === "LoadingFirstPage") return; // Aún cargando

    // Open the requested conversation only after verifying ownership. Apply it
    // once so subsequent sidebar selections are not overridden by the URL.
    if (requestedThreadId && handledThreadId.current !== requestedThreadId) {
      if (requestedThread === undefined) return;
      handledThreadId.current = requestedThreadId;
      if (requestedThread) {
        setCurrentThreadId(requestedThread.threadId);
        setIsInitialized(true);
        return;
      }
    }

    if (threads.length > 0 && !currentThreadId) {
      // Usuario tiene threads, seleccionar el primero
      setCurrentThreadId(threads[0].threadId);
      setIsInitialized(true);
    } else if (threads.length === 0 && !hasAutoCreated) {
      // Usuario nuevo sin threads - crear uno automáticamente
      setHasAutoCreated(true);
      createThread({ title: "Mi primera conversación" }).then((newThreadId) => {
        setCurrentThreadId(newThreadId);
        setIsInitialized(true);
      });
    } else if (threads.length > 0 && currentThreadId) {
      // Ya tiene thread seleccionado
      setIsInitialized(true);
    }
  }, [threads, threadsStatus, currentThreadId, hasAutoCreated, createThread, requestedThreadId, requestedThread]);

  // COMENTADO: TaskPanel movido a Panel de Control
  // useEffect(() => {
  //   if (tasks && tasks.length > 0 && !isTaskPanelOpen && !userClosedPanel) {
  //     setIsTaskPanelOpen(true);
  //   }
  // }, [tasks, isTaskPanelOpen, userClosedPanel]);

  // useEffect(() => {
  //   setUserClosedPanel(false);
  // }, [currentThreadId]);

  const handleNewThread = useCallback(async () => {
    // Si el thread actual está vacío (sin mensajes), no crear uno nuevo
    if (hasMessages === false && currentThreadId) {
      // El thread actual está vacío, simplemente mantenerlo seleccionado
      return;
    }

    const newThreadId = await createThread({
      title: `Nuevo chat • ${new Date().toLocaleString()}`,
    });
    setCurrentThreadId(newThreadId);
  }, [createThread, hasMessages, currentThreadId]);

  const handleSelectThread = useCallback((threadId: string) => {
    setCurrentThreadId(threadId);
  }, []);

  const handleThreadChange = useCallback((threadId: string | null) => {
    if (threadId) {
      setCurrentThreadId(threadId);
    }
  }, []);

  // COMENTADO: TaskPanel movido a Panel de Control
  // const toggleTaskPanel = useCallback(() => {
  //   setIsTaskPanelOpen((prev) => {
  //     const newState = !prev;
  //     if (!newState) {
  //       setUserClosedPanel(true);
  //     }
  //     return newState;
  //   });
  // }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // LOADING: Mostrar pantalla de carga completa hasta que todo esté listo
  // ═══════════════════════════════════════════════════════════════════════════
  if (
    !isInitialized ||
    threadsStatus === "LoadingFirstPage" ||
    !currentThreadId
  ) {
    return <LoadingScreen />;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSPACE: Solo se muestra cuando threads y currentThreadId están listos
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <WorkspaceLayout
      sidebarDefaultOpen
      currentThreadId={currentThreadId}
      onSelectThread={handleSelectThread}
      onNewThread={handleNewThread}
      threads={requestedThread && !threads.some(thread => thread.threadId === requestedThread.threadId)
        ? [requestedThread, ...threads]
        : threads}
      threadsStatus={threadsStatus}
      loadMoreThreads={loadMore}
    >
      <div className="flex h-full overflow-hidden relative">
        {/* Chat Section */}
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          <ChatInterface
            key={currentThreadId}
            threadId={currentThreadId}
            onThreadChange={handleThreadChange}
            hideHeader={true}
          />
        </div>

        {/* COMENTADO: TaskPanel movido a Panel de Control (/workspace/control-panel) */}
        {/* El panel de tareas ahora se accede desde la pestaña "Panel de Control" */}
        {/* donde cada tarea se abre como un dialog con opción de publicar a COR */}
      </div>
    </WorkspaceLayout>
  );
}
