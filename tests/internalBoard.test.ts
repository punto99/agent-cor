import test from "node:test";
import assert from "node:assert/strict";
import { internalBoardStage, internalBoardStages, isTaskInCOR } from "../app/components/control-panel/internalBoard";
import type { FullTask } from "../app/components/control-panel/types";

const task = (values: Partial<FullTask>) => ({ status: "nueva", ...values }) as FullTask;
test("unpublished internal and external tasks always use the first column", () => {
  for (const source of ["internal", "external"] as const) {
    for (const corSyncStatus of [undefined, "pending", "error", "syncing", "retrying"]) {
      assert.equal(internalBoardStage(task({ source, corSyncStatus, status: "en_revision" })), "pending_cor");
    }
  }
  assert.equal(internalBoardStages([])[0].key, "pending_cor");
});
test("already created COR tasks keep their workflow status even after a sync failure", () => {
  for (const corSyncStatus of ["error", "syncing", "retrying", "synced"]) {
    const row = task({ corTaskId: "123", corSyncStatus, status: "en_proceso" });
    assert.equal(isTaskInCOR(row), true);
    assert.equal(internalBoardStage(row), "en_proceso");
  }
  assert.equal(internalBoardStage(task({ corSyncStatus: "synced" })), "nueva");
});
test("unknown workflow states remain visible without changing the original task", () => {
  const row = task({ corTaskId: "123", status: "custom_status" });
  const original = { ...row };
  assert.ok(internalBoardStages([row]).some(stage => stage.key === "custom_status"));
  assert.deepEqual(row, original);
});
