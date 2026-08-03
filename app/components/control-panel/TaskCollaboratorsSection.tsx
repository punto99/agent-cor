"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertCircle, Loader2, Lock, Search, Users, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type TaskCollaborator = {
  userId?: Id<"users">;
  corUserId?: number;
  name: string;
  email?: string;
  source?: "client_default" | "task";
  availableInCOR?: boolean;
};

type CollaboratorCandidate = {
  userId: Id<"users">;
  corUserId: number;
  name: string;
  email: string;
};

type TaskCollaboratorsSectionProps = {
  taskId: Id<"tasks">;
  published: boolean;
  editable: boolean;
  syncStatus: string;
  collaboratorSyncStatus?: string;
};

export function TaskCollaboratorsSection({
  taskId,
  published,
  editable,
  syncStatus,
  collaboratorSyncStatus,
}: TaskCollaboratorsSectionProps) {
  const selection = useQuery(api.data.tasks.getTaskCorCollaborators, {
    taskId,
  });
  const setTaskCollaborators = useMutation(
    api.data.tasks.setTaskCorCollaborators,
  );
  const getPublishedCollaborators = useAction(
    api.data.tasks.getPublishedTaskCorCollaborators,
  );
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedCollaborators, setPublishedCollaborators] = useState<
    TaskCollaborator[] | null
  >(null);
  const [isLoadingPublished, setIsLoadingPublished] = useState(false);

  const canEdit = Boolean(editable && selection?.editable && !published);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  const candidates = useQuery(
    api.data.tasks.searchTaskCorCollaboratorCandidates,
    canEdit && debouncedSearch.length >= 2
      ? { taskId, search: debouncedSearch }
      : "skip",
  ) as CollaboratorCandidate[] | undefined;

  useEffect(() => {
    let cancelled = false;
    if (!published) {
      setPublishedCollaborators(null);
      setIsLoadingPublished(false);
      return;
    }

    setIsLoadingPublished(true);
    setError(null);
    void getPublishedCollaborators({ taskId })
      .then((result) => {
        if (!cancelled) {
          setPublishedCollaborators(result as TaskCollaborator[]);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "No se pudieron consultar los colaboradores de COR.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPublished(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    collaboratorSyncStatus,
    getPublishedCollaborators,
    published,
    syncStatus,
    taskId,
  ]);

  const localCollaborators = (selection?.collaborators ||
    []) as TaskCollaborator[];
  const visibleCollaborators = published
    ? publishedCollaborators || localCollaborators
    : localCollaborators;

  const saveSelection = async (userIds: Id<"users">[]) => {
    try {
      setIsSaving(true);
      setError(null);
      await setTaskCollaborators({ taskId, userIds });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "No se pudieron guardar los colaboradores.",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
    return true;
  };

  const handleRemove = async (userId: Id<"users">) => {
    const nextUserIds = localCollaborators
      .map((collaborator) => collaborator.userId)
      .filter((candidateUserId): candidateUserId is Id<"users"> =>
        Boolean(candidateUserId && candidateUserId !== userId),
      );
    await saveSelection(nextUserIds);
  };

  const handleAdd = async (candidate: CollaboratorCandidate) => {
    const currentUserIds = localCollaborators
      .map((collaborator) => collaborator.userId)
      .filter((userId): userId is Id<"users"> => Boolean(userId));
    if (await saveSelection([...currentUserIds, candidate.userId])) {
      setSearch("");
      setDebouncedSearch("");
    }
  };

  return (
    <section className="mx-6 mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Users className="h-4 w-4 flex-shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Colaboradores en COR
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {published
                ? "Asignación actual de la tarea publicada."
                : "Esta selección se aplicará al proyecto y a la tarea al publicar."}
            </p>
          </div>
        </div>
        {published && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
            <Lock className="h-3 w-3" />
            Solo lectura
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {isLoadingPublished && visibleCollaborators.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Consultando COR...
          </span>
        ) : visibleCollaborators.length > 0 ? (
          visibleCollaborators.map((collaborator) => (
            <div
              key={collaborator.userId || collaborator.corUserId}
              className="flex max-w-full items-center gap-2 rounded-full border border-border bg-muted/50 py-1 pl-3 pr-2 text-xs"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  {collaborator.name}
                </span>
                {collaborator.email && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {collaborator.email}
                  </span>
                )}
              </span>
              {!published && collaborator.source === "client_default" && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Cliente
                </span>
              )}
              {!published && collaborator.availableInCOR === false && (
                <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  Sin COR
                </span>
              )}
              {canEdit && collaborator.userId && (
                <button
                  type="button"
                  onClick={() => void handleRemove(collaborator.userId!)}
                  disabled={isSaving}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  title={`Quitar a ${collaborator.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            {published
              ? "La tarea no tiene colaboradores asignados en COR."
              : "No hay colaboradores seleccionados."}
          </p>
        )}
      </div>

      {canEdit && (
        <div className="relative mt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setError(null);
              }}
              disabled={isSaving}
              placeholder="Buscar usuario de COR..."
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          {debouncedSearch.length >= 2 && (
            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
              {candidates === undefined ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Buscando...
                </div>
              ) : candidates.length > 0 ? (
                candidates.map((candidate) => (
                  <button
                    key={candidate.userId}
                    type="button"
                    onClick={() => void handleAdd(candidate)}
                    disabled={isSaving}
                    className="block w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {candidate.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {candidate.email}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No encontramos usuarios internos resueltos en COR.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
