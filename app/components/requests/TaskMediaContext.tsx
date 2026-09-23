"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useTaskPanelActivity } from "./useTaskPanelActivity";
import { findTaskMedia, mergeTaskMedia, type TaskMediaFile } from "./taskMedia";

type RemoteFiles = FunctionReturnType<typeof api.data.taskPanelMedia.list>;
const Context = createContext<{
  files: TaskMediaFile[]; loading: boolean; error: boolean;
  refresh: () => void; resolve: (file: TaskMediaFile) => Promise<string | null>;
} | null>(null);

export function TaskMediaProvider({ taskId, children }: { taskId: Id<"tasks">; children: React.ReactNode }) {
  const data = useTaskPanelActivity(taskId);
  const list = useAction(api.data.taskPanelMedia.list);
  const token = useAuthToken();
  const [remote, setRemote] = useState<RemoteFiles>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map<string, Promise<string | null>>());
  const urls = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const ownedUrls = urls.current;
    return () => { mounted.current = false; ownedUrls.forEach(url => URL.revokeObjectURL(url)); ownedUrls.clear(); cache.current.clear(); };
  }, []);
  useEffect(() => {
    if (data === undefined) return;
    let cancelled = false;
    setLoading(true); setError(false);
    list({ taskId }).then(files => { if (!cancelled) setRemote(files); }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [list, taskId, revision, data?.comments.length, data?.attachments.length]);
  const files = useMemo(() => mergeTaskMedia(data?.attachments ?? [], remote), [data?.attachments, remote]);
  const resolve = useCallback(async (file: TaskMediaFile) => {
    if (file.url) return file.url;
    if (!file.mediaUrl || !token) return null;
    const key = `${file.id}:${token}`;
    let pending = cache.current.get(key);
    if (!pending) {
      pending = fetch(file.mediaUrl, { headers: { Authorization: `Bearer ${token}` } }).then(async response => {
        if (!response.ok) throw new Error("Archivo no disponible");
        const blob = await response.blob();
        if (!mounted.current) return null;
        const url = URL.createObjectURL(blob); urls.current.add(url); return url;
      }).catch(() => { cache.current.delete(key); return null; });
      cache.current.set(key, pending);
    }
    return pending;
  }, [token]);
  return <Context.Provider value={{ files, loading: data === undefined || loading, error, refresh: () => setRevision(value => value + 1), resolve }}>{children}</Context.Provider>;
}
export function useTaskMedia() {
  const context = useContext(Context);
  if (!context) throw new Error("TaskMediaProvider requerido");
  return { ...context, find: (source: string) => findTaskMedia(context.files, source) };
}
export function useTaskMediaSource(file?: TaskMediaFile) {
  const { resolve } = useTaskMedia();
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSource(null); setFailed(false);
    if (file) resolve(file).then(url => { if (!cancelled) { setSource(url); setFailed(!url); } });
    return () => { cancelled = true; };
  }, [file, resolve]);
  return { source: file?.url ?? source, failed, setFailed };
}
