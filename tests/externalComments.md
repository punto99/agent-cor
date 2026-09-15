# External comments without taxonomy or Trello

Only external tasks without category/brand fields or Trello references/status use
this route. Categorized tasks (including those waiting for a Trello card) continue
through `editExternalTaskFromAgent` without changes to its arguments or behavior.

## Storage and delivery

- Each confirmed chat message creates one `taskMessages` record, keyed by
  `requestThreadId` + `requestMessageId`. Repeated tool calls reuse that record.
- Files uploaded after task creation are registered in `threadUploadedFiles` with
  `commentOnly: true`. They are not uploaded as native COR attachments.
- Current-message files are included automatically. Previously staged files are
  included only when the agent sets `includePendingFiles: true` after the user's
  request/confirmation. The save transaction consumes each file once via
  `commentMessageId` and stores its ID on the comment.
- The task must belong to the approved external user, who must still have full
  access to its client. Use the task's original conversation for this route.
- Initial brief attachments retain the existing behavior.

COR receives a comment containing text and/or links to Convex storage. If the
COR task exists, a scheduled action sends the saved comment. Otherwise the task
publication flow schedules it after COR identifiers are stored.

States on `taskMessages.corMessageSyncStatus`:

- `direct_pending_task`: waiting for the COR task.
- `direct_pending`: ready for delivery.
- `direct_sending`: an atomic claim prevents concurrent sends.
- `synced`: COR confirmed receipt.
- `direct_uncertain`: failed/unconfirmed delivery, or a worker that did not finish
  within five minutes. No automatic POST retry.

The dedicated pending states do not enter the existing Trello comment queue.

## Operational recovery

The existing COR provider does not expose an idempotency key or comment lookup.
A timeout can occur after COR has accepted a comment. Check COR before resending.

After verifying that the comment is absent, an operator can execute the internal
mutation `data/externalComments:retryAfterReview` with the `taskMessages` ID and
`confirmedAbsentInCOR: true`. It reuses the record and starts a new numbered
attempt; callbacks from earlier attempts cannot overwrite its state. This
operation is not exposed to the agent or as a public mutation.

To resume untouched pending comments after an infrastructure interruption or
restoring the COR integration, run the internal mutation
`data/externalComments:scheduleForTask` with the local `taskId`. It never resends
comments in `synced`, `direct_sending`, or `direct_uncertain` states.

## Local verification

```sh
node --conditions=import --import tsx --test tests/externalComments.test.ts
```

These tests execute real handlers with an in-memory transactional database double
and simulated COR responses. They do not prove live COR behavior or the model's
choice to call the tool; validate those in the development environment.
