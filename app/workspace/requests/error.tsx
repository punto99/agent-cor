"use client";

export default function RequestsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">No pudimos cargar tus tareas</h1>
      <p className="mt-3 text-sm text-muted-foreground">Intentá nuevamente en unos momentos.</p>
      <button type="button" onClick={reset} className="mt-6 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent">Volver a intentar</button>
    </div>
  );
}
