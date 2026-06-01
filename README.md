Persistent AI memory that follows you across every tool, session, and interface. Fully local.

![Build](https://github.com/tenurehq/tenure/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)
![arXiv](https://img.shields.io/badge/arXiv-2605.11325-b31b1b.svg)

---

Every AI session starts from zero. You re-explain your stack. You restate your voice. You re-establish decisions you made weeks ago. And when you don't re-explain, when you just ask the question, you get a confident, detailed answer that completely misses the point.

A developer had already established: TypeScript, Fastify, MongoDB, raw driver, composition over inheritance. New session, they asked:

> _How should I structure my repo?_

200 lines of Python using SQLAlchemy. Wrong language. Wrong database. Wrong paradigm.

The next prompt becomes a correction instead of progress.

## What Tenure does

You spend an hour in a chat interface thinking through an architecture
problem. You explore options, rule some out, land on a direction. Then
you open your IDE to start building.

Tenure is already there. It knows what you decided, what you rejected,
and why. You don't re-explain anything. You just build.

It sits between your clients and your AI provider and quietly learns
from your conversations. Every tool that routes through it shares the
same belief store, so context you establish in one place is already
present when you switch to another. After a month, most users have
eliminated more than 80% of the correction turns they used to pay.

Same question, cold start, new session, with Tenure running:

```typescript
export function makeUserRepository(db: Db): UserRepository {
  const col: Collection<UserDoc> = db.collection("users");

  return {
    async findById(id, ctx) {
      const doc = await col.findOne(
        { _id: new ObjectId(id) },
        { session: ctx?.session },
      );
      return doc ? toUser(doc) : null;
    },
    async insert(data, ctx) {
      const doc: UserDoc = {
        _id: new ObjectId(),
        ...data,
        createdAt: new Date(),
      };
      await col.insertOne(doc, { session: ctx?.session });
      return toUser(doc);
    },
  };
}
```

TypeScript. MongoDB raw driver. Factory function. No re-explanation required.

## What actually goes wrong without it

Memory problems don't always announce themselves. They show up as wasted cycles.

**Old decisions resurface as suggestions.** You switched from Jest to Vitest three months ago. The model recommends Jest. You correct it. You move on. It happens again next week.

**Ruled-out approaches keep coming back.** You evaluated Mongoose, decided against it, and explained why. Without memory of that decision, it will be suggested again. And again.

**Context resets mid-project.** A writer shouldn't re-explain a character's voice in session four. A researcher shouldn't re-litigate a ruled-out approach. A consultant switching between clients shouldn't re-brief from scratch.

**Different tools behave differently.** You establish preferences in one client. A second client starts cold. Your tools give inconsistent answers to the same question.

Tenure addresses all of these by keeping a structured, evolving model of how you work, across sessions, across clients, across time.

## Who it's for

Tenure is for anyone whose work compounds across sessions.

**Engineers** -- stop re-explaining that you hate ORMs, use Vitest, and prefer explicit error returns over exceptions.

**Writers** -- character voices, world details, and open plot threads stay consistent across every session.

**Researchers** -- your thesis angle, ruled-out sources, and advisor feedback don't reset mid-project.

**Consultants** -- switch cleanly between client contexts without re-briefing from scratch.

## Works where you already work

Any OpenAI-compatible client works out of the box. Point it at `http://localhost:5757/v1` and it routes through Tenure automatically.

Native integrations are available for [OpenClaw](docs/clients.md#openclaw) and [VS Code](docs/clients.md#vs-code). Open WebUI and most other chat interfaces work without any integration. See [docs/clients.md](docs/clients.md) for the full list and setup instructions.

## Get started

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.ps1 | iex
```

After install, open [http://localhost:5757/onboarding](http://localhost:5757/onboarding) to connect a provider, pick a model, and answer a few questions to seed your memory. Then point your client at `http://localhost:5757/v1` with your bearer token.

Full instructions: [docs/quickstart.md](docs/quickstart.md)

## One container, one port

Tenure runs as a single Docker container on localhost. No graph store, no
embedding pipeline, no separate vector database, no MCP-only interface with
no API fallback. One port: `http://localhost:5757`.

The footprint matters at retrieval time too. Systems that bundle on-device
embedding models and cross-encoder rerankers carry that weight on every
query. Tenure's retrieval is BM25 over a structured index — 13ms mean
latency, no model inference in the read path.

Tenure speaks both OpenAI and Anthropic wire formats. Point any
OpenAI-compatible client at `http://localhost:5757/v1` and it routes through
Tenure automatically. For Anthropic clients, point at
`http://localhost:5757/anthropic` — which means Claude Code works out of the
box, with full memory across every coding session, today.

The API is available for both formats for scripted access, backups, and
automation.

## Try it before you commit

Run Tenure with extraction on and injection off for a week or two.
See exactly what it learned about how you work before it ever changes
a single response. No risk. No behavior change. No surprises.

The audit log at `/audit` shows which beliefs would have been injected
into each request. Review them. Correct anything that's wrong. When
you're confident the memory reflects how you actually work, turn
injection on.

To start in observation mode, type `!inject off` in any chat window.
If you're in the IDE, use the injection toggle in the Tenure sidebar.
Details: [docs/audit.md](docs/audit.md)

## Private by design

Everything runs on your machine. Your context never leaves localhost. Belief content is encrypted at rest. Every memory is visible, editable, and correctable at `/beliefs`. Nothing is hidden. You can export your entire memory as an encrypted archive and restore it on any machine.

To pause memory for a session, type `!extract off` in your chat.

Details: [docs/security.md](docs/security.md)

## Audit trail

Tenure logs every context injection: which beliefs were retrieved and
injected into each request, and which would have been injected in
observation mode. The full trail is available at `/audit`.

Tenure tracks your **orientation tax** (the re-explanations, corrections, and context resets that memory should have prevented) and shows you on your dashboard whether that number is going down.

Use `/beliefs` to edit what Tenure knows. Use `/audit` to see what
that knowledge is doing for you.

Details: [docs/audit.md](docs/audit.md)

## The ramp

The first session will be good. The tenth noticeably better. The
improvement isn't just a feeling: Tenure tracks it. Your memory
coverage rate (re-explanations prevented divided by total that would
have been required) starts at zero and climbs as beliefs accumulate.
Most users reach 80%+ within a month.

Your dashboard shows the running count: "Tenure prevented 47
re-explanations this week." The audit log at `/audit` is the source
of that number, so you can inspect any entry and see exactly which
belief did the work.

If you import an existing preferences file or complete onboarding,
the first session is already informed. Starting cold, Tenure learns
from every exchange and gets more precise over time.

More on how retrieval works and how to get the most out of it:
[docs/retrieval.md](docs/retrieval.md)

## Two ways to build memory

Vector search, top-k, reranking — that's the retrieval system side.
Tenure is on the belief system side.

Most memory systems store what you said and search it at inference time,
handing the model a pile of candidates to reason over. Contradictions,
alternatives, outdated context — the model sorts it out. When retrieval
is noisy, the model compensates. Until it can't, or until you're not
using a frontier model that can.

Tenure does the work earlier. Every belief is extracted at write time,
when the full reasoning chain is present: what was decided, what was
rejected, and why. The `why_it_matters` field isn't a note, it's a
pre-computed instruction for how future responses should act on that
fact. The model receives a resolved belief, not raw material to
re-derive.

This is why retrieval precision is load-bearing rather than one metric
among many. There's nothing downstream to compensate for noise. The
belief that goes in is the instruction that comes out.

It also changes what "handling contradictions" means. A belief store
that has already resolved a decision doesn't need to surface
alternatives at inference time. When you moved from Jest to Vitest,
the old term became a retrieval surface for the new belief. The
supersession chain records that the switch happened. The model doesn't
reason over the conflict because the conflict was resolved when it
occurred, not deferred to the next session.

## Scope

Beliefs are scoped to a context boundary. A belief about your TypeScript
conventions only surfaces in code sessions. A belief about a character's
voice only surfaces in writing sessions. A belief marked `user:universal`
surfaces everywhere.

Scope is a hard filter, not a ranking signal. A session in `project:client-a`
cannot surface beliefs from `project:client-b` regardless of how semantically
close the content is. There is no probabilistic suppression; out-of-scope
beliefs are structurally absent from retrieval.

This matters in practice. If you have a character named Redis in your novel
and Redis the cache in your codebase, the right belief surfaces based on the
active scope, not on which one scores higher in a similarity search.

Scope is detected automatically from your first message or set explicitly:

    !scope domain:code
    !scope project:my-app
    !scope domain:code/typescript

Sub-domain scopes expand automatically — setting `domain:code/typescript`
includes `domain:code` without listing it separately.

Details: [docs/beliefs.md](docs/beliefs.md)

## Further reading

- [How memory is structured](docs/beliefs.md)
- [Supported models](docs/models.md)
- [Prompt caching and token efficiency](docs/prompt-caching.md)
- [Retrieval details](docs/retrieval.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](docs/contributing.md)

## License

MIT
