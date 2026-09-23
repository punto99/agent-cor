import test from "node:test";
import assert from "node:assert/strict";
import { boardLabelColor, cardDeadline, creatorInitials } from "../app/components/board/cardPresentation";

test("dates preserve the calendar day and only past unfinished tasks are overdue", () => {
  const now = new Date(2026, 8, 22, 14);
  assert.equal(cardDeadline("2026-09-21T00:00:00Z", false, now)?.overdue, true);
  assert.equal(cardDeadline("2026-09-22", false, now)?.overdue, false);
  assert.equal(cardDeadline("2026-09-23", false, now)?.overdue, false);
  assert.equal(cardDeadline("2026-09-21", true, now)?.overdue, false);
  assert.equal(cardDeadline("2026-09-21", true, now)?.completed, true);
  assert.match(cardDeadline("2026-08-14", false, now)!.label, /14 ago/);
  assert.equal(cardDeadline(undefined, false, now), undefined);
  assert.equal(cardDeadline("2026-02-31", false, now)?.label, "2026-02-31");
  assert.equal(cardDeadline("mediados de agosto", false, now)?.overdue, false);
});

test("persisted Trello colors include variants and unknown colors stay neutral", () => {
  assert.equal(boardLabelColor("orange"), "#FEA362");
  assert.equal(boardLabelColor("blue_dark"), "#0C66E4");
  assert.equal(boardLabelColor("purple_light"), "#DFD8FD");
  assert.equal(boardLabelColor(undefined), "#8590A2");
  assert.equal(boardLabelColor("unknown"), "#8590A2");
  assert.equal(creatorInitials("  Ximena  Torres "), "XT");
});
