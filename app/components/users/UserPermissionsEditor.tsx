import { Search, ShieldCheck } from "lucide-react";
import type { useInternalUserPermissions } from "@/app/hooks/useInternalUserPermissions";
import { Button } from "../ui/Button";
import { ClientPermissionRow } from "./ClientPermissionRow";

type UserPermissionsEditorProps = ReturnType<typeof useInternalUserPermissions>;

export function UserPermissionsEditor({
  clientCount,
  clientPermissionSearch,
  setClientPermissionSearch,
  showAssignedClientsOnly,
  setShowAssignedClientsOnly,
  visiblePermissionClients,
  draftFullClientIds,
  draftBrandIds,
  hasPermissionChanges,
  saving,
  handleResetDraft,
  handleSaveAssignments,
  toggleFullClient,
  toggleBrand,
}: UserPermissionsEditorProps) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Permisos de clientes y categorías
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Acceso completo al cliente permite trabajar con todas sus
            categorías. Si no, selecciona categorías específicas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={handleResetDraft}
            disabled={!hasPermissionChanges || saving}
          >
            Descartar
          </Button>
          <Button
            type="button"
            className="cursor-pointer"
            onClick={handleSaveAssignments}
            disabled={!hasPermissionChanges || saving}
          >
            {saving ? "Guardando..." : "Guardar permisos"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 dark:bg-muted/20">
        <div className="relative min-w-[240px] flex-1">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={clientPermissionSearch}
            onChange={(event) => setClientPermissionSearch(event.target.value)}
            placeholder="Buscar cliente o categoría"
            className="w-full h-9 rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <label className="inline-flex h-9 cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 text-sm text-foreground">
          <input
            type="checkbox"
            checked={showAssignedClientsOnly}
            onChange={(event) =>
              setShowAssignedClientsOnly(event.target.checked)
            }
            className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary"
          />
          Solo asignados
        </label>
      </div>

      <div className="divide-y divide-border">
        {clientCount === 0 ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No hay clientes locales sincronizados.
          </div>
        ) : visiblePermissionClients.length === 0 ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No hay clientes que coincidan con el filtro actual.
          </div>
        ) : (
          visiblePermissionClients.map((client) => (
            <ClientPermissionRow
              key={client._id}
              client={client}
              draftFullClientIds={draftFullClientIds}
              draftBrandIds={draftBrandIds}
              onToggleClient={toggleFullClient}
              onToggleBrand={toggleBrand}
            />
          ))
        )}
      </div>

      {hasPermissionChanges && (
        <div className="sticky bottom-0 z-10 border-t border-border bg-card/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur dark:shadow-[0_-8px_24px_rgba(0,0,0,0.28)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium text-foreground">
                Cambios sin guardar
              </div>
              <div className="text-xs text-muted-foreground">
                Guarda o descarta los permisos seleccionados.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={handleResetDraft}
                disabled={saving}
              >
                Descartar
              </Button>
              <Button
                type="button"
                className="cursor-pointer"
                onClick={handleSaveAssignments}
                disabled={saving}
              >
                {saving ? "Guardando..." : "Guardar permisos"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
