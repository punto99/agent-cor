import boardStyles from "../board/BoardLayout.module.css";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/app/components/ui/Button";
import type { FilterOption } from "./types";
import type { useRequestFilters } from "./useRequestFilters";

function RequestFilter({ label, allLabel, value, options, onChange }: {
  label: string; allLabel: string; value: string; options: FilterOption[]; onChange: (value: string) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
      className="h-9 max-w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <option value="">{allLabel}</option>
      {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
  );
}

export function RequestsToolbar({ filters, onNewRequest, busy }: {
  filters: ReturnType<typeof useRequestFilters>; onNewRequest: () => void; busy: boolean;
}) {
  return (
    <div className={`${boardStyles.controls} flex min-w-0 flex-1 flex-wrap items-center gap-2`}>
      <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-card px-3 focus-within:ring-2 focus-within:ring-ring sm:min-w-48 sm:max-w-[320px] sm:flex-1">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input aria-label="Buscar tareas" placeholder="Buscar tareas…" value={filters.search} onChange={(e) => filters.setSearch(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </label>
      {filters.clients.length > 1 && <RequestFilter label="Filtrar por cliente" allLabel="Todos los clientes" value={filters.client} options={filters.clients} onChange={filters.setClient} />}
      {filters.brands.length > 0 && <RequestFilter label="Filtrar por marca" allLabel="Todas las marcas" value={filters.brand} options={filters.brands} onChange={filters.setBrand} />}
      {filters.subBrands.length > 0 && <RequestFilter label="Filtrar por submarca" allLabel="Todas las submarcas" value={filters.subBrand} options={filters.subBrands} onChange={filters.setSubBrand} />}
      <Button onClick={onNewRequest} disabled={busy} className={`${boardStyles.primary} gap-2 sm:ml-auto`}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
        {busy ? "Iniciando tarea…" : "Nueva tarea"}
      </Button>
    </div>
  );
}

