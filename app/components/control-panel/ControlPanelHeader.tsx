import {
  Filter,
  LayoutGrid,
  List as ListIcon,
} from "lucide-react";
import type {
  ControlPanelClient,
  ControlPanelPublicationTab,
  ControlPanelView,
} from "./types";
import { STATUS_OPTIONS } from "./utils";

type ControlPanelHeaderProps = {
  selectedClient: ControlPanelClient;
  selectedBrandId: string | null;
  statusFilter: string | undefined;
  viewMode: ControlPanelView;
  publicationTab: ControlPanelPublicationTab;
  filteredTaskCount: number;
  publishedTaskCount: number;
  unpublishedTaskCount: number;
  onSelectedBrandChange: (brandId: string | null) => void;
  onStatusFilterChange: (status: string | undefined) => void;
  onViewModeChange: (viewMode: ControlPanelView) => void;
  onPublicationTabChange: (tab: ControlPanelPublicationTab) => void;
};

export function ControlPanelHeader({
  selectedClient,
  selectedBrandId,
  statusFilter,
  viewMode,
  publicationTab,
  filteredTaskCount,
  publishedTaskCount,
  unpublishedTaskCount,
  onSelectedBrandChange,
  onStatusFilterChange,
  onViewModeChange,
  onPublicationTabChange,
}: ControlPanelHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            {selectedClient.client.name}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {selectedClient.projectCount} proyecto
            {selectedClient.projectCount !== 1 ? "s" : ""} ·{" "}
            {selectedClient.taskCount} tarea
            {selectedClient.taskCount !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="inline-flex h-9 rounded-lg border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => onViewModeChange("cards")}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                viewMode === "cards"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title="Ver como cards"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Cards
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("list")}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                viewMode === "list"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title="Ver como lista"
            >
              <ListIcon className="h-3.5 w-3.5" />
              Lista
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            {selectedClient.brands.length > 0 && (
              <select
                value={selectedBrandId || ""}
                onChange={(event) =>
                  onSelectedBrandChange(event.target.value || null)
                }
                className="h-9 max-w-[220px] cursor-pointer rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Todas las categorías</option>
                {selectedClient.brands.map((brand) => (
                  <option key={brand._id} value={String(brand._id)}>
                    {brand.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={statusFilter || ""}
              onChange={(event) =>
                onStatusFilterChange(event.target.value || undefined)
              }
              className="h-9 cursor-pointer rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value || ""}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-5 border-b border-border">
        <div className="flex flex-wrap items-center gap-6">
          <button
            type="button"
            onClick={() => onPublicationTabChange("all")}
            className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
              publicationTab === "all"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Todas ({filteredTaskCount})
          </button>
          <button
            type="button"
            onClick={() => onPublicationTabChange("cor")}
            className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
              publicationTab === "cor"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            En COR ({publishedTaskCount})
          </button>
          <button
            type="button"
            onClick={() => onPublicationTabChange("unpublished")}
            className={`inline-flex h-10 cursor-pointer items-center border-b-2 px-1 text-sm font-semibold transition-colors ${
              publicationTab === "unpublished"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Sin publicar ({unpublishedTaskCount})
          </button>
        </div>
      </div>
    </div>
  );
}
