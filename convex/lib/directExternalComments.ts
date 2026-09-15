// Only tasks created without taxonomy or a Trello integration use this route.
// A categorized task whose Trello card is still pending must keep the old route.
export function usesDirectExternalComments(task: any): boolean {
  return Boolean(task && task.source === "external" &&
    !task.clientBrandId && !task.brandId && !task.brandName &&
    !task.subBrandId && !task.productId && !task.subBrandName &&
    !task.trelloCardId && !task.trelloCardUrl &&
    !task.trelloBoardId && !task.trelloBoardUrl && !task.trelloSyncStatus);
}
