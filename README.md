# Tenure

**Shared memory and governance for AI clients and agents, with scope, provenance, auditability, and access control.**

Tenure gives your AI clients and agents one governed memory layer between them and the upstream model.

It remembers durable project decisions like architecture choices, coding conventions, database preferences, and team rules, then injects only the relevant scoped state into each request.

As more clients and agents route through Tenure, it becomes the shared memory system and governance layer for AI across your tools, teams, and environments.

No more re-explaining the same repo decisions.
No more stale context from another project.
No more guessing why the model used a piece of memory.

| Retrieval precision | Retrieval latency | Drift score | Workflow changes |
| ------------------- | ----------------- | ----------- | ---------------- |
| 1.0                 | <15ms             | 0.00        | 0                |

## Why use Tenure?

AI tools are useful, but their memory is fragmented.

Claude Code may learn something in one session. VS Code does not know it. Cursor does not know it. Your mobile chat does not know it. And if a memory system retrieves old or unrelated context, the model may confidently follow the wrong decision.

Tenure fixes that by making memory explicit, scoped, and inspectable.

Use Tenure when AI needs durable context, enforced boundaries, and a shared control layer across tools, sessions, clients, agents, and teams:

- Decisions: what was chosen, rejected, or replaced
- Preferences: how a person, team, or organization works
- Policies: what the AI is allowed to use or say
- Provenance: where a piece of context came from
- Boundaries: which project, client, user, or team it belongs to
- Narratives: how products, customers, and initiatives should be described
- Open questions: what has not been decided yet

## The problem with most AI memory

The value of memory is obvious. The failure mode is not forgetting. It is using the wrong memory.

Most systems retrieve semantically similar past context and ask the model to sort it out. That breaks down when decisions get replaced, preferences conflict, clients need isolation, teams have different rules, or policy determines what context is allowed.

Tenure treats memory as governed state. Every belief has scope, provenance, versioning, and an audit trail. The model receives the resolved context it is allowed to use, not a loose bundle of memories it has to interpret mid-answer.

## How Tenure works

Tenure runs as a local proxy between your AI client and the model.

1. You keep using your existing AI tools.
2. Tenure observes conversations and tool outputs.
3. Durable decisions become structured beliefs.
4. Beliefs are scoped by project, team, user, or domain.
5. On each request, Tenure injects only the relevant resolved state.

The model does not receive a random pile of past messages. It receives the current scoped state: what was decided, where it came from, and why it matters.

## Choose how much memory you want

| Mode            | What happens                                 | Best for                              |
| --------------- | -------------------------------------------- | ------------------------------------- |
| Document-driven | Injects approved docs only                   | Regulated teams, conservative rollout |
| Curated         | AI proposes memories, humans approve         | Teams that want oversight             |
| Adaptive        | Learns and injects continuously              | Fast-moving teams                     |
| Reflective      | Extracts insights but does not inject memory | Leadership, audits, knowledge mapping |

Learning and injection are separate. You can observe memory without injecting it, inject only approved docs, or let Tenure adapt continuously.

## Scope isolation

Tenure treats scope as a hard boundary, not a ranking hint.

A memory from `project:client-a` cannot appear in `project:client-b`, even if the text is semantically similar.

That means:

- Client projects do not bleed into each other
- Personal preferences do not override team rules
- Old repo decisions do not haunt new repos like tiny software ghosts
- “Redis” the fictional character and Redis the cache can coexist without a vector database having an identity crisis

```txt
!scope domain:code
!scope project:my-app
!scope domain:code/typescript
```

## Governance: know what your AI knows

### Provenance

Every belief has an origin. Click any belief to see the session it was extracted from, when it was created, and every query that surfaced it. The record is complete and written as it happens, not reconstructed after the fact.

### Injection logs

See exactly which beliefs were in context for every turn. Not inferred from similarity scores. A per-turn injection log, written at the time it happened. If the model says something unexpected, you can trace it to the specific belief that influenced it.

### Supersession

Old decisions retire instead of competing with new ones. Moved from Jest to Vitest? The old belief routes to the new one. The supersession chain records that the switch happened. The model does not reason over the conflict because the conflict was resolved when it occurred. No drift. No ambiguity. One source of truth at any moment.

## Benchmarks

Most memory systems retrieve semantically similar text and ask the model to sort it out. Tenure retrieves scoped structured beliefs.

PrecisionMemBench tests memory retrieval directly, before answer generation hides the failure.

[Run the benchmark](https://github.com/tenurehq/precisionMemBench)

## Observe before you commit

You do not need to trust Tenure on day one. Run it with extraction on and injection off:

```
!inject off
```

Tenure extracts beliefs from your conversations. You open the panel and read what it captured. You edit what you want, delete what you do not. You own the state before it ever reaches the model. Most users watch for a week or two. When they see consistent, accurate extraction, they turn injection on. No surprises. No behavior changes. No trust required.

## 30-second install

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.ps1 | iex
```

**Helm (team deploy):**

```bash
helm repo add tenure https://charts.tenureai.dev
helm repo update
helm install tenure tenure/tenure \
  --create-namespace \
  --namespace tenure
```

Point your client at `http://localhost:5757/v1`. Done.
Claude Code: point at `http://localhost:5757/anthropic`. Done.

## Works everywhere

One state layer. Every AI client.

- **IDE:** VS Code (native), Cursor, Windsurf, Continue, Cline
- **Chat:** Open WebUI, LibreChat, any OpenAI-compatible client
- **Mobile:** OpenClaw on WhatsApp or Telegram. An insight on a walk lands in the same belief store your IDE reads from tomorrow.
- **Claude Code:** full Anthropic wire format, works today
- **Teams:** Helm chart, OIDC, SCIM, audit trails

One port. Every client. Same state.

## Fully local

- No cloud
- No accounts
- No telemetry
- Encrypted at rest
- Export your entire state as an encrypted archive anytime
- MIT licensed

## Further reading

- [How memory is structured](docs/beliefs.md)
- [Memory Modes](https://tenureai.dev/use-case/memory-modes)
- [Supported models](docs/models.md)
- [Prompt caching and token efficiency](docs/prompt-caching.md)
- [Retrieval details](docs/retrieval.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](docs/contributing.md)

MIT
