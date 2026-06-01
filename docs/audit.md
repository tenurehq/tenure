# Injection Audit Trail

Tenure keeps a record of every context injection event. Each time beliefs
are retrieved and injected into a request (or would have been injected
in observation mode) a record is written to the audit log.

## What is recorded

Each audit record captures:

- **User query** - the raw query that triggered retrieval
- **Expanded query** - the normalized version used for search
- **Injected beliefs** - a snapshot of every belief included in context,
  split into three groups:
  - Pinned facts: always-on beliefs you have explicitly pinned
  - Relevant beliefs: beliefs retrieved by semantic search
  - Open questions: pinned questions surfaced to keep them visible
- **Belief count** - total number of beliefs in context
- **Injection status** - whether beliefs were actually injected or the
  session was in observation mode (`!extract off`)
- **Scope** - the scope tags active for the request
- **Agent ID** - the agent identifier if routed through an agent client
- **Timestamps** - when the injection occurred

Snapshots are taken at injection time, so the audit record reflects
exactly what the model saw, even if beliefs are later edited or deleted.

## Viewing the audit trail

Open [http://localhost:5757/audit](http://localhost:5757/audit) in your
browser. You can filter by:

- **Date range** - narrow to a specific window
- **Scope** - select from a dropdown of all scopes seen in your audit history
- **Belief ID** - see every request where a specific belief appeared

Click any record to see the full detail view, including belief content,
confidence, epistemic status, and why-it-matters annotations as they
were at injection time.

You can also reach this filtered view by clicking the Injections button on any belief card in the World Model dashboard.

## Orientation tax dashboard

The dashboard at the top of the audit page shows four measurements for
the last 30 days:

- **Re-explanations prevented** — turns where beliefs were injected and
  the next turn was not a correction. A floor, not a ceiling: silent
  failures where the model quietly used stale context are not visible here.
- **Estimated time saved** — re-explanations prevented × 1 minute.
  Labeled as estimated because the true cost of a correction turn varies.
- **Tax still paid** — turns where the sidecar determined your message
  existed primarily to re-establish context memory should have supplied.
  This is the most directly observed number on the dashboard.
- **Re-explanation trend** — whether tax-paid turns are increasing or
  decreasing across the period. Down is good. `—` means not enough data
  yet to compute a direction.

## API access

The audit trail is also available via the admin API:

Query parameters:

| Parameter   | Type   | Description                                                       |
| ----------- | ------ | ----------------------------------------------------------------- |
| `limit`     | number | Max records to return (default 50, max 200)                       |
| `skip`      | number | Offset for pagination                                             |
| `start`     | string | ISO date: only records after this time                            |
| `end`       | string | ISO date: only records before this time (inclusive to end of day) |
| `scope`     | string | Filter by exact scope value                                       |
| `belief_id` | string | Filter to records containing this belief                          |

Returns a single record by ID. Returns `404` if not found or if the
record belongs to a different user.

## What audit logging does not capture

- The full system prompt or injected context string: only the belief
  list is stored, not the rendered prompt
- The model's response
- Requests where no beliefs were retrieved (zero-belief events are
  silently skipped)
