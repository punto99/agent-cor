"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  getErrorMessage,
  sameStringSet,
  type InternalUser,
  type InternalClient,
  type InternalUsersToast,
} from "@/app/lib/internalUsers";

export function useInternalUserPermissions(
  selectedUser: InternalUser | null,
  clients: InternalClient[],
  onNotify: (toast: InternalUsersToast) => void,
) {
  const setAssignments = useMutation(
    api.data.internalUserAdmin.setInternalUserAssignments,
  );

  const [clientPermissionSearch, setClientPermissionSearch] = useState("");
  const [showAssignedClientsOnly, setShowAssignedClientsOnly] = useState(false);
  const [draftFullClientIds, setDraftFullClientIds] = useState<
    Set<Id<"corClients">>
  >(() => new Set());
  const [draftBrandIds, setDraftBrandIds] = useState<Set<Id<"clientBrands">>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedUser || selectedUser.corUser?.isActive === false) {
      setDraftFullClientIds(new Set());
      setDraftBrandIds(new Set());
      return;
    }

    setDraftFullClientIds(
      new Set(
        selectedUser.assignments
          .filter((assignment) => !assignment.brandId)
          .map((assignment) => assignment.clientId),
      ),
    );
    setDraftBrandIds(
      new Set(
        selectedUser.assignments
          .filter((assignment) => assignment.brandId)
          .map((assignment) => assignment.brandId),
      ),
    );
  }, [
    selectedUser?._id,
    selectedUser?.assignments,
    selectedUser?.corUser?.isActive,
  ]);

  const currentFullClientIds = useMemo(
    () =>
      new Set(
        selectedUser?.assignments
          .filter((assignment) => !assignment.brandId)
          .map((assignment) => assignment.clientId) ?? [],
      ),
    [selectedUser],
  );
  const currentBrandIds = useMemo(
    () =>
      new Set(
        selectedUser?.assignments
          .filter((assignment) => assignment.brandId)
          .map((assignment) => assignment.brandId) ?? [],
      ),
    [selectedUser],
  );
  const hasPermissionChanges =
    Boolean(selectedUser && selectedUser.corUser?.isActive !== false) &&
    (!sameStringSet(currentFullClientIds, draftFullClientIds) ||
      !sameStringSet(currentBrandIds, draftBrandIds));

  const visiblePermissionClients = useMemo(() => {
    const term = clientPermissionSearch.trim().toLowerCase();

    return clients.filter((client) => {
      const hasFullClientAccess = draftFullClientIds.has(client._id);
      const hasBrandAccess = client.brands.some((brand) =>
        draftBrandIds.has(brand._id),
      );
      const isAssigned = hasFullClientAccess || hasBrandAccess;

      if (showAssignedClientsOnly && !isAssigned) return false;
      if (!term) return true;

      return (
        client.name.toLowerCase().includes(term) ||
        String(client.corClientId).includes(term) ||
        client.nomenclature?.toLowerCase().includes(term) ||
        client.brands.some((brand) => brand.name.toLowerCase().includes(term))
      );
    });
  }, [
    clients,
    clientPermissionSearch,
    draftBrandIds,
    draftFullClientIds,
    showAssignedClientsOnly,
  ]);

  const handleSaveAssignments = async () => {
    if (!selectedUser || selectedUser.corUser?.isActive === false) return;
    try {
      setSaving(true);
      await setAssignments({
        targetUserId: selectedUser._id,
        fullClientIds: Array.from(draftFullClientIds),
        brandIds: Array.from(draftBrandIds),
      });
      onNotify({
        type: "success",
        message: "Permisos actualizados.",
      });
    } catch (error) {
      onNotify({
        type: "error",
        message: getErrorMessage(error, "No se pudieron guardar los permisos."),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetDraft = () => {
    setDraftFullClientIds(new Set(currentFullClientIds));
    setDraftBrandIds(new Set(currentBrandIds));
  };

  const toggleFullClient = (client: InternalClient) => {
    setDraftFullClientIds((current) => {
      const next = new Set(current);
      if (next.has(client._id)) {
        next.delete(client._id);
      } else {
        next.add(client._id);
      }
      return next;
    });
    setDraftBrandIds((current) => {
      const next = new Set(current);
      for (const brand of client.brands) next.delete(brand._id);
      return next;
    });
  };

  const toggleBrand = (client: InternalClient, brandId: Id<"clientBrands">) => {
    setDraftFullClientIds((current) => {
      const next = new Set(current);
      next.delete(client._id);
      return next;
    });
    setDraftBrandIds((current) => {
      const next = new Set(current);
      if (next.has(brandId)) next.delete(brandId);
      else next.add(brandId);
      return next;
    });
  };

  return {
    clientCount: clients.length,
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
  };
}
