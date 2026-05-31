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
- **Scope** - e.g. `project:my-app`
- **Belief ID** - see every request where a specific belief appeared

Click any record to see the full detail view, including belief content,
confidence, epistemic status, and why-it-matters annotations as they
were at injection time.

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
