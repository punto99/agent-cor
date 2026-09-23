"use client";

import { CommentNotificationBell } from "./notifications/CommentNotifications";
import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
  MoreVertical,
  MessageCircle,
  Pencil,
  X,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { UserMenu } from "./UserMenu";
import { SwitchThemeButton } from "./ui/SwitchThemeButton";
import { Button } from "./ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/DropdownMenu";
import { Tooltip } from "./ui/Tooltip";
import { clientConfig } from "@/config/tenant.config";
import { TopNavigation } from "./TopNavigation";

interface Thread {
  _id: string;
  threadId: string;
  title?: string;
  updatedAt: number;
}

interface WorkspaceLayoutProps {
  children: React.ReactNode;
  sidebarDefaultOpen?: boolean;
  currentThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  onNewThread?: () => void;
  threads: Thread[];
  threadsStatus:
    | "LoadingFirstPage"
    | "CanLoadMore"
    | "LoadingMore"
    | "Exhausted";
  loadMoreThreads: (numItems: number) => void;
}

export function WorkspaceLayout({
  children,
  sidebarDefaultOpen = false,
  currentThreadId,
  onSelectThread,
  onNewThread,
  threads,
  threadsStatus,
  loadMoreThreads,
}: WorkspaceLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const deleteThread = useMutation(api.messaging.threads.deleteThread);
  const updateThreadTitle = useMutation(
    api.messaging.threads.updateThreadTitle,
  );
  const [sidebar, setSidebar] = useState(() => ({
    pathname,
    open: sidebarDefaultOpen,
  }));
  // A new page gets its own default; changing conversations keeps the user's choice.
  if (sidebar.pathname !== pathname) {
    setSidebar({ pathname, open: sidebarDefaultOpen });
  }
  const isSidebarOpen = sidebar.open;
  const toggleSidebar = () => setSidebar({ pathname, open: !isSidebarOpen });
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const threadsContainerRef = useRef<HTMLDivElement>(null);
  const activeThreadRef = useRef<HTMLDivElement>(null);
  const activeThreadLoaded = threads.some(thread => thread.threadId === currentThreadId);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = threadsContainerRef.current;
      const active = activeThreadRef.current;
      if (!container || !active || !container.clientHeight) return;
      const bounds = container.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.top < bounds.top || row.bottom > bounds.top + container.clientHeight) {
        // Move only the sidebar, leaving the conversation's scroll untouched.
        container.scrollTop += row.top - bounds.top - (container.clientHeight - row.height) / 2;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentThreadId, activeThreadLoaded, isSidebarOpen, isMobileSidebarOpen]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingThreadId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingThreadId]);

  // Infinite scroll handler
  const handleScroll = useCallback(() => {
    const container = threadsContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isNearBottom = scrollTop + clientHeight >= scrollHeight - 100;

    if (isNearBottom && threadsStatus === "CanLoadMore") {
      loadMoreThreads(20);
    }
  }, [threadsStatus, loadMoreThreads]);

  useEffect(() => {
    const container = threadsContainerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll);
      return () => container.removeEventListener("scroll", handleScroll);
    }
  }, [handleScroll]);

  useEffect(() => {
    if (!isMobileSidebarOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobileSidebarOpen]);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 767px)");

    const keepMobileOnChat = () => {
      if (mobileViewport.matches && pathname !== "/workspace") {
        router.replace("/workspace");
      }
    };

    keepMobileOnChat();
    mobileViewport.addEventListener("change", keepMobileOnChat);
    return () =>
      mobileViewport.removeEventListener("change", keepMobileOnChat);
  }, [pathname, router]);

  const handleNewThreadClick = () => {
    onNewThread?.();
    setIsMobileSidebarOpen(false);
  };

  const handleSelectThreadClick = (threadId: string) => {
    onSelectThread?.(threadId);
    setIsMobileSidebarOpen(false);
  };

  const handleStartEdit = (
    threadId: string,
    currentTitle: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    setEditingThreadId(threadId);
    setEditingTitle(currentTitle || "Sin título");
  };

  const handleSaveEdit = async (threadId: string) => {
    if (editingTitle.trim()) {
      await updateThreadTitle({ threadId, title: editingTitle.trim() });
    }
    setEditingThreadId(null);
    setEditingTitle("");
  };

  const handleCancelEdit = () => {
    setEditingThreadId(null);
    setEditingTitle("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, threadId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveEdit(threadId);
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  const handleDeleteThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("¿Estás seguro de eliminar esta conversación?")) {
      await deleteThread({ threadId });

      // Si eliminamos el thread actual, cargar el más reciente (el primero de la lista que no sea el eliminado)
      if (currentThreadId === threadId && threads.length > 0) {
        const remainingThreads = threads.filter((t) => t.threadId !== threadId);
        if (remainingThreads.length > 0) {
          onSelectThread?.(remainingThreads[0].threadId);
        }
      }
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return "Hoy";
    if (days === 1) return "Ayer";
    if (days < 7) return `Hace ${days} días`;
    return date.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background md:h-screen">
      {isMobileSidebarOpen && (
        <button
          type="button"
          aria-label="Cerrar menú de conversaciones"
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar: drawer en mobile, fijo en tablet/desktop */}
      <aside
        id="workspace-sidebar"
        className={`${
          isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        } fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[calc(100vw-3rem)] shrink-0 flex-col overflow-hidden border-r border-border bg-card transition-[transform,width] duration-200 motion-reduce:transition-none md:static md:z-auto md:h-auto md:max-w-none md:translate-x-0 ${
          isSidebarOpen ? "md:w-72" : "md:w-16"
        }`}
      >
        {/* The desktop toggle stays accessible in both sidebar sizes. */}
        <div className="relative flex h-16 shrink-0 items-center justify-center border-b border-border px-3">
          <div className={`flex min-w-0 flex-1 justify-center ${isSidebarOpen ? "" : "md:hidden"}`}>
            <BrandLogo />
          </div>
          <button
            type="button"
            aria-label={isSidebarOpen ? "Colapsar menú de conversaciones" : "Expandir menú de conversaciones"}
            title={isSidebarOpen ? "Colapsar menú de conversaciones" : "Expandir menú de conversaciones"}
            aria-controls="workspace-conversations"
            aria-expanded={isSidebarOpen}
            onClick={toggleSidebar}
            className="hidden h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex"
          >
            {isSidebarOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
          </button>
          <button
            type="button"
            aria-label="Cerrar menú de conversaciones"
            onClick={() => setIsMobileSidebarOpen(false)}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <Button
            onClick={handleNewThreadClick}
            aria-label="Nueva conversación"
            title="Nueva conversación"
            className={`w-full justify-start gap-2 ${isSidebarOpen ? "" : "md:h-10 md:w-10 md:justify-center md:border-transparent md:p-0 md:shadow-none"}`}
            variant="outline"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className={isSidebarOpen ? "" : "md:hidden"}>Nueva conversación</span>
          </Button>
        </div>

        {/* Threads List */}
        <div
          id="workspace-conversations"
          ref={threadsContainerRef}
          className={`min-h-0 flex-1 overflow-y-auto ${isSidebarOpen ? "" : "md:hidden"}`}
        >
          <div className="px-3 py-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-2">
              Mis Chats
            </h3>
            <div className="space-y-1">
              {threads.length === 0 ? (
                <div className="px-2 py-4 text-center text-muted-foreground text-sm">
                  No hay conversaciones
                </div>
              ) : (
                <>
                  {threads.map((thread) => (
                    <div
                      key={thread._id}
                      ref={currentThreadId === thread.threadId ? activeThreadRef : undefined}
                      onClick={() => {
                        if (editingThreadId !== thread.threadId) {
                          handleSelectThreadClick(thread.threadId);
                        }
                      }}
                      className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        currentThreadId === thread.threadId
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-accent text-foreground"
                      }`}
                    >
                      <MessageCircle className="h-4 w-4 flex-shrink-0" />
                      <div className="flex-1 min-w-0 overflow-hidden">
                        {editingThreadId === thread.threadId ? (
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) =>
                              handleEditKeyDown(e, thread.threadId)
                            }
                            onBlur={handleCancelEdit}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-sm font-medium bg-background border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-foreground"
                          />
                        ) : (
                          <Tooltip content={thread.title || "Sin título"}>
                            <p className="text-sm font-medium truncate max-w-full">
                              {thread.title || "Sin título"}
                            </p>
                          </Tooltip>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {formatDate(thread.updatedAt)}
                        </p>
                      </div>
                      {editingThreadId !== thread.threadId && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Opciones de ${thread.title || "conversación sin título"}`}
                              className="rounded p-2 opacity-100 transition-opacity hover:bg-accent md:p-1 md:opacity-0 md:group-hover:opacity-100"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) =>
                                handleStartEdit(
                                  thread.threadId,
                                  thread.title || "",
                                  e,
                                )
                              }
                              className="cursor-pointer"
                            >
                              <Pencil className="h-4 w-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) =>
                                handleDeleteThread(thread.threadId, e)
                              }
                              className="text-destructive cursor-pointer"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  ))}
                  {threadsStatus === "LoadingMore" && (
                    <div className="px-2 py-3 text-center text-muted-foreground text-sm">
                      Cargando más...
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar Footer - User controls */}
        <div className={`mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card p-3 ${isSidebarOpen ? "" : "md:flex-col md:px-1 md:py-3"}`}>
          <UserMenu />
          <SwitchThemeButton />
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden md:h-screen">
        {/* Header - Fijo */}
        <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border bg-card px-3 md:h-16 md:px-4">
          <div className="flex min-w-0 items-center gap-2 md:gap-4">
            <button
              type="button"
              aria-label="Abrir menú de conversaciones"
              aria-controls="workspace-sidebar"
              aria-expanded={isMobileSidebarOpen}
              onClick={() => setIsMobileSidebarOpen(true)}
              className="rounded-lg p-2 transition-colors hover:bg-accent md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h2 className="truncate text-base font-semibold text-foreground md:text-lg">
              {clientConfig.brand.name}
            </h2>
          </div>
          <CommentNotificationBell />
        </header>

        {/* Tab Navigation — Chat / Panel de Control */}
        <TopNavigation />

        {/* Content - Área con scroll controlado */}
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
