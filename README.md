# Tenure

### Stop AI memory drift with deterministic state.

Persistent, governable, scoped state for AI systems.

![Build](https://github.com/tenurehq/tenure/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)
[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/tenure)](https://artifacthub.io/packages/search?repo=tenure)
![arXiv](https://img.shields.io/badge/arXiv-2605.11325-b31b1b.svg)

## Your memory system will drift in ways you cannot detect.

Context bleeds across sessions. Projects contaminate each other. Old decisions keep resurfacing. The model still answers. Nobody knows why.

Most AI memory systems rely on semantic similarity. Over time, irrelevant context accumulates and stale knowledge competes with the truth. The model compensates until it cannot.

Tenure treats memory as state.

## AI does not need more context. It needs state.

Conversations become structured beliefs. Beliefs have provenance, versioning, hard scope boundaries, and supersession chains. The model receives a resolved belief, not raw material to re-derive.

```
Conversations
      |
Structured beliefs
      |
Versioning + Scope
      |
Retrieval
      |
Injected state
      |
AI response
```

Memory is the output. State is the system.

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

## Observe before you commit

Run with extraction on and injection off. See exactly what Tenure learns before it changes a single response. No surprises. No behavior changes. No trust required.

```
!inject off
```

Most users watch Tenure extract beliefs for a week or two before turning injection on. When you open the panel and read what it captured, you edit what you want and delete what you do not. You own the state before it ever reaches the model.

## Govern what AI knows

### Scope isolation

Project A never bleeds into Project B. Scope is a hard filter, not a ranking signal. A session in `project:client-a` cannot surface beliefs from `project:client-b` regardless of how semantically close the content is. Out-of-scope beliefs are structurally absent from retrieval.

### Provenance

Every belief has an origin. Click any belief to see every session it was injected and the query that surfaced it each time. The record is complete and written as it happens, not reconstructed.

### Injection logs

See exactly which beliefs were in context for every turn. Not inferred. Per-turn injection log, written at the time it happened.

### Supersession

Old decisions retire instead of competing with the truth. Moved from Jest to Vitest? The old belief routes to the new one. The supersession chain records that the switch happened. The model does not reason over the conflict because the conflict was resolved when it occurred.

## Why memory systems drift

Most systems retrieve semantically similar context and hand the model a pile of candidates to reason over. Contradictions, alternatives, outdated context -- the model sorts it out. Until it cannot, or until you need to know why it said what it said.

|                     | Traditional memory | Tenure               |
| ------------------- | ------------------ | -------------------- |
| Retrieval           | Similarity search  | Structured beliefs   |
| Boundaries          | Probabilistic      | Hard scope isolation |
| Contradictions      | Model resolves     | Supersession         |
| Visibility          | Hidden             | Injection logs       |
| Drift score         | 0.94               | 0.00                 |
| Retrieval precision | 0.06               | 1.0                  |

Retrieval precision is load-bearing, not one metric among many. There is nothing downstream to compensate for noise. The belief that goes in is the instruction that comes out.

Benchmarks are reproducible. Dataset on HuggingFace. [Run it yourself](https://github.com/tenurehq/precisionMemBench).

## The problem in practice

A developer had already established: TypeScript, Fastify, MongoDB, raw driver, composition over inheritance. New session, they asked:

> How should I structure my repo?

200 lines of Python using SQLAlchemy. Wrong language. Wrong database. Wrong paradigm.

The next prompt becomes a correction instead of progress.

Same question, cold start, new session, with Tenure running:

```typescript
export function makeUserRepository(db: Db): UserRepository {
  const col: Collection<UserDoc> = db.collection("users");

  return {
    async findById(id, ctx) {
      const doc = await col.findOne(
        { _id: new ObjectId(id) },
        { session: ctx?.session }
      );
      return doc ? toUser(doc) : null;
    },
    async insert(data, ctx) {
      const doc: UserDoc = {
        _id: new ObjectId(),
        ...data,
        createdAt: new Date()
      };
      await col.insertOne(doc, { session: ctx?.session });
      return toUser(doc);
    }
  };
}
```

TypeScript. MongoDB raw driver. Factory function. No re-explanation required.

## Works everywhere

One state layer. Every client.

- **IDE:** VS Code (native), Cursor, Windsurf, Continue, Cline
- **Chat:** Open WebUI, LibreChat, any OpenAI-compatible client
- **Mobile:** OpenClaw on WhatsApp/Telegram -- aha moments on a walk land in the same belief store your IDE reads from tomorrow
- **Claude Code:** full Anthropic wire format, works today
- **Teams:** Helm chart, OIDC, SCIM, audit trails

One port. Every client. Same state.

## Architecture

Tenure is on the belief system side, not the retrieval system side.

Most memory systems store what you said and search it at inference time, handing the model a pile of candidates to reason over. Tenure does the work earlier. Every belief is extracted at write time, when the full reasoning chain is present: what was decided, what was rejected, and why.

The `why_it_matters` field is not a note. It is a pre-computed instruction for how future responses should act on that fact.

Scope is detected automatically from your first message or set explicitly:

```
!scope domain:code
!scope project:my-app
!scope domain:code/typescript
```

Sub-domain scopes expand automatically. Setting `domain:code/typescript` includes `domain:code` without listing it separately.

If you have a character named Redis in your novel and Redis the cache in your codebase, the right belief surfaces based on the active scope, not on which one scores higher in a similarity search.

## Fully local

- No cloud
- No accounts
- No telemetry
- Encrypted at rest
- Export your entire state as an encrypted archive anytime
- MIT licensed

## Further reading

- [How memory is structured](docs/beliefs.md)
- [Supported models](docs/models.md)
- [Prompt caching and token efficiency](docs/prompt-caching.md)
- [Retrieval details](docs/retrieval.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](docs/contributing.md)

MIT
