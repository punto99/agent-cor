export function RequestsHeader({ clientName }: { clientName?: string }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h1 className="text-xl font-bold tracking-tight">Mis tareas</h1>
      {clientName && <span className="max-w-48 truncate text-xs text-muted-foreground" title={clientName}>{clientName}</span>}
    </header>
  );
}

