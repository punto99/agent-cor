import { Building2, Search } from "lucide-react";
import type { ControlPanelClient } from "./types";

type ControlPanelSidebarProps = {
  panelClients: ControlPanelClient[] | undefined;
  visibleClients: ControlPanelClient[];
  selectedClient: ControlPanelClient | null;
  clientSearch: string;
  onClientSearchChange: (value: string) => void;
  onSelectClient: (clientId: string) => void;
};

export function ControlPanelSidebar({
  panelClients,
  visibleClients,
  selectedClient,
  clientSearch,
  onClientSearchChange,
  onSelectClient,
}: ControlPanelSidebarProps) {
  return (
    <aside className="border-r border-border bg-card min-h-0 flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Clientes</h2>
        </div>
        <div className="relative">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={clientSearch}
            onChange={(event) => onClientSearchChange(event.target.value)}
            placeholder="Buscar cliente"
            className="w-full h-9 rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {!panelClients ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Cargando clientes...
          </div>
        ) : visibleClients.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No hay clientes para mostrar.
          </div>
        ) : (
          <div className="space-y-1">
            {visibleClients.map((entry) => {
              const isSelected =
                String(entry.client._id) === String(selectedClient?.client._id);

              return (
                <button
                  key={entry.client._id}
                  onClick={() => onSelectClient(String(entry.client._id))}
                  className={`w-full cursor-pointer text-left rounded-md px-3 py-2 transition-colors ${
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium truncate">
                      {entry.client.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.taskCount}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {entry.projectCount} proyecto
                    {entry.projectCount !== 1 ? "s" : ""}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
