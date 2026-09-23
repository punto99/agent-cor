"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";

export function useNewRequest() {
  const createThread = useMutation(api.messaging.threads.createThread);
  const sendMessage = useMutation(api.messaging.chat.sendMessage);
  const router = useRouter();
  const locked = useRef(false);
  const pendingThread = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      // Reuse a created conversation if sending failed; do not create another on retry.
      const threadId = pendingThread.current ?? await createThread({ title: "Nueva tarea" });
      pendingThread.current = threadId;
      await sendMessage({
        threadId,
        prompt: "Quiero crear una tarea. Presentate brevemente y guiame para contarte qué necesito.",
      });
      router.push(`/workspace?threadId=${encodeURIComponent(threadId)}`);
    } catch {
      setError("No pudimos iniciar la tarea. Volvé a intentarlo.");
      locked.current = false;
      setBusy(false);
    }
  }
  return { start, busy, error };
}
