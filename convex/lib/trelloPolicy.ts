import { clientConfig } from "../../config/tenant.config";

export function isTrelloEnabledForCorClientId(
  corClientId: number | null | undefined,
): corClientId is number {
  return (
    typeof corClientId === "number" &&
    clientConfig.ui.trelloPublishCorClientIds.includes(corClientId)
  );
}

export function getTrelloDisabledReason(corClientId: number | null | undefined) {
  return typeof corClientId === "number"
    ? `El cliente COR ${corClientId} no está habilitado para Trello.`
    : "La task no tiene cliente COR habilitado para Trello.";
}
