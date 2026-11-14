import type { Id } from "@/convex/_generated/dataModel";
import type { InternalClient } from "@/app/lib/internalUsers";

type ClientPermissionRowProps = {
  client: InternalClient;
  draftFullClientIds: ReadonlySet<string>;
  draftBrandIds: ReadonlySet<string>;
  onToggleClient: (client: InternalClient) => void;
  onToggleBrand: (client: InternalClient, brandId: Id<"clientBrands">) => void;
};

export function ClientPermissionRow({
  client,
  draftFullClientIds,
  draftBrandIds,
  onToggleClient,
  onToggleBrand,
}: ClientPermissionRowProps) {
  const fullSelected = draftFullClientIds.has(String(client._id));
  const selectedBrandCount = client.brands.filter((brand) =>
    draftBrandIds.has(String(brand._id)),
  ).length;
  const hasCategories = client.brands.length > 0;
  const assignmentLabel = hasCategories
    ? fullSelected
      ? "Todas las categorías"
      : `${selectedBrandCount} de ${client.brands.length} categoría${
          client.brands.length !== 1 ? "s" : ""
        }`
    : fullSelected
      ? "Cliente asignado"
      : "Sin categorías";
  const fullAccessLabel = hasCategories
    ? "Acceso completo"
    : "Acceso al cliente";

  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {client.name}
          </div>
          <div className="text-xs text-muted-foreground">
            COR {client.corClientId}
            {client.nomenclature ? ` · ${client.nomenclature}` : ""}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-muted-foreground">
            {assignmentLabel}
          </span>

          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground">
            <input
              type="checkbox"
              checked={fullSelected}
              onChange={() => onToggleClient(client)}
              className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
            />
            {fullAccessLabel}
          </label>
        </div>
      </div>

      {client.brands.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {client.brands.map((brand) => (
            <label
              key={brand._id}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                fullSelected
                  ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground"
                  : "cursor-pointer border-border bg-background text-foreground hover:bg-accent"
              }`}
            >
              <input
                type="checkbox"
                disabled={fullSelected}
                checked={fullSelected || draftBrandIds.has(String(brand._id))}
                onChange={() => onToggleBrand(client, brand._id)}
                className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="min-w-0 flex-1 truncate">{brand.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
