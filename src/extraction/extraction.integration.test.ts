import anyTest, { type TestFn } from "ava";
import { randomUUID } from "node:crypto";
import {
  setupIntegrationEnv,
  type IntegrationEnv,
  type LLMSpy
} from "../integration-tests/setup.js";
import type { ExtractionJob } from "../types/job.js";
import type { Belief } from "../types/belief.js";

const test = anyTest.serial as TestFn<{ env: IntegrationEnv }>;

const USER_ID = "integration-test-user";
const SESSION_ID = "integration-test-session";

async function retryUntilReady<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(
    `${label} did not succeed within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

function makeSidecar(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [],
    belief_updates: [],
    new_open_questions: [],
    ...overrides
  });
}

function makeNewBelief(overrides: Record<string, unknown> = {}) {
  return {
    type: "preference",
    canonical_name:
      (overrides.canonical_name as string) ??
      `belief_${randomUUID().slice(0, 8)}`,
    content: "Content worth persisting across sessions",
    why_it_matters: "Avoids re-explanation next session",
    scope: ["coding"],
    confidence: 0.8,
    aliases: [],
    epistemic_status: "active",
    ...overrides
  };
}

function makeJob(overrides: Partial<ExtractionJob> = {}): ExtractionJob {
  return {
    _id: randomUUID(),
    type: "extract_beliefs",
    status: "pending",
    user_id: USER_ID,
    team_id: null,
    org_id: null,
    agent_id: null,
    session_id: SESSION_ID,
    turn_id: randomUUID(),
    attempts: 0,
    max_attempts: 3,
    run_after: new Date(Date.now() - 1000),
    created_at: new Date(),
    updated_at: new Date(),
    last_error: null,
    completed_at: null,
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar(),
      source_model: "anthropic:claude-haiku"
    },
    ...overrides
  } as ExtractionJob;
}

function makeBelief(overrides: Partial<Belief> = {}): Belief {
  const now = new Date();
  return {
    _id: randomUUID(),
    user_id: USER_ID,
    type: "preference",
    canonical_name:
      overrides.canonical_name ?? `belief_${randomUUID().slice(0, 8)}`,
    aliases: [],
    content: "Default content",
    why_it_matters: "Default reason",
    scope: ["coding"],
    provenance: {
      session_id: SESSION_ID,
      turn_id: "seed",
      extracted_at: now,
      source_model: "test"
    },
    epistemic_status: "active",
    confidence: 0.8,
    reinforcement_count: 0,
    last_reinforced_at: now,
    pinned: false,
    user_edited: false,
    resolved_at: null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    change_log: [],
    subtype: null,
    agent_id: null,
    ...overrides
  } as Belief;
}

test.before(async (t) => {
  t.context.env = await setupIntegrationEnv();
});

test.after.always(async (t) => {
  await t.context.env.teardown();
});

test.beforeEach(async (t) => {
  await t.context.env.reset();
});

test("contradictory higher-confidence incoming content is flagged, not silently dropped", async (t) => {
  const { cols, makeWorker } = t.context.env;
  const canonicalName = `content_clash_${randomUUID().slice(0, 8)}`;

  await cols.beliefs.insertOne(
    makeBelief({
      canonical_name: canonicalName,
      content: "Old stale content that was previously extracted",
      confidence: 0.3
    })
  );

  const job = makeJob({
    payload: {
      user_message: "Actually I prefer TypeScript over JavaScript now",
      assistant_message: "Got it, I will remember that.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            content: "Prefers TypeScript over JavaScript for all new projects",
            confidence: 0.9
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");

  const belief = await cols.beliefs.findOne({
    canonical_name: canonicalName,
    user_id: USER_ID
  });
  t.is(belief!.content, "Old stale content that was previously extracted");
  t.is(belief!.confidence, 0.3);
});

test("contradictory lower-confidence incoming content is skipped without updating", async (t) => {
  const { cols, makeWorker } = t.context.env;
  const canonicalName = `content_clash_low_${randomUUID().slice(0, 8)}`;

  await cols.beliefs.insertOne(
    makeBelief({
      canonical_name: canonicalName,
      content: "Strongly prefers Rust for systems programming",
      confidence: 0.9
    })
  );

  const job = makeJob({
    payload: {
      user_message: "I guess Go is okay too for some things",
      assistant_message: "Noted.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            content: "Might prefer Go for systems programming",
            confidence: 0.25
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const belief = await cols.beliefs.findOne({
    canonical_name: canonicalName,
    user_id: USER_ID
  });
  t.is(belief!.content, "Strongly prefers Rust for systems programming");
  t.is(belief!.confidence, 0.9);
  t.is(belief!.reinforcement_count, 0);
});

test("close-confidence conflicting content is flagged as a contradiction", async (t) => {
  const { cols, makeWorker } = t.context.env;
  const canonicalName = `content_clash_close_${randomUUID().slice(0, 8)}`;

  await cols.beliefs.insertOne(
    makeBelief({
      canonical_name: canonicalName,
      content: "Uses tabs for indentation in all files",
      confidence: 0.6
    })
  );

  const job = makeJob({
    payload: {
      user_message: "I actually prefer spaces, forget what I said about tabs",
      assistant_message: "Okay, spaces it is.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            content: "Uses spaces for indentation",
            confidence: 0.55
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const belief = await cols.beliefs.findOne({
    canonical_name: canonicalName,
    user_id: USER_ID
  });
  t.is(belief!.content, "Uses tabs for indentation in all files");
});

test("reflective mode does not persist any beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "reflective" } },
    { upsert: true }
  );

  const job = makeJob({
    payload: {
      user_message: "I love coding in Python",
      assistant_message: "Python is great!",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [makeNewBelief(), makeNewBelief()]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);
});

test("reflective mode does not persist style signals", async (t) => {
  const { cols, makeWorker } = t.context.env;

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "reflective" } },
    { upsert: true }
  );

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [],
        new_open_questions: [],
        style_signals: [
          {
            observation: "Uses terse phrasing",
            pattern_type: "communication_style",
            confidence: "medium",
            requires_confirmation: false,
            scope: ["global"]
          }
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  t.is(
    await cols.db
      .collection("style_signals")
      .countDocuments({ user_id: USER_ID }),
    0
  );
});

test("reflective mode returns zero IDs while autonomous mode persists beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "reflective" } },
    { upsert: true }
  );

  const reflectiveJob = makeJob({
    payload: {
      user_message: "Hi",
      assistant_message: "Hello",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "should_not_persist",
            content: "Ghost belief that should not persist",
            confidence: 0.9
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(reflectiveJob);

  const worker = makeWorker();
  await worker.processById(reflectiveJob._id as string);

  t.deepEqual(
    (await cols.jobs.findOne({ _id: reflectiveJob._id }))!.result_belief_ids,
    []
  );
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "autonomous" } }
  );

  const autonomousJob = makeJob({
    payload: {
      user_message: "Hi again",
      assistant_message: "Hello again",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "should_persist",
            content: "Real belief that should persist",
            confidence: 0.9
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(autonomousJob);
  await worker.processById(autonomousJob._id as string);

  t.is(
    (await cols.jobs.findOne({ _id: autonomousJob._id }))!.result_belief_ids!
      .length,
    1
  );
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 1);
});

test("curated mode persists suggestions rather than beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "curated" } },
    { upsert: true }
  );

  const job = makeJob({
    payload: {
      user_message: "I prefer dark mode in my editor",
      assistant_message: "Noted, dark mode.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "prefers_dark_mode",
            content: "Prefers dark mode in editor",
            confidence: 0.85
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);
  t.is(await cols.belief_suggestions.countDocuments({ user_id: USER_ID }), 1);
});

test("inject_only mode does not persist any beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  await cols.config.updateOne(
    { key: "memory_mode" },
    { $set: { value: "inject_only" } },
    { upsert: true }
  );

  const job = makeJob({
    payload: {
      user_message: "I use Neovim as my primary editor",
      assistant_message: "Neovim, got it.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "uses_neovim",
            content: "Uses Neovim",
            confidence: 0.8
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  t.deepEqual(
    (await cols.jobs.findOne({ _id: job._id }))!.result_belief_ids,
    []
  );
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);
});

test("fuzzy match via Atlas Search finds existing belief by alias and reinforces", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const existing = makeBelief({
    canonical_name: "prefers_typescript",
    aliases: ["typescript_fan", "ts_preference"],
    content: "Prefers TypeScript",
    confidence: 0.7
  });
  await cols.beliefs.insertOne(existing);

  const job = makeJob({
    payload: {
      user_message: "I like TypeScript",
      assistant_message: "Noted.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "ts_preference",
            content: "Prefers TypeScript",
            confidence: 0.75
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);

  const belief = await cols.beliefs.findOne({ _id: existing._id });
  t.is(belief!.reinforcement_count, 1);
});

test("canonical name collision in compaction does not crash the entire batch", async (t) => {
  const { cols, makeCompactionRunner, createLLMSpy } = t.context.env;

  const existingActive = makeBelief({
    canonical_name: "typescript_preference",
    content: "Pre-existing active belief about TypeScript"
  });

  const b1 = makeBelief();
  const b2 = makeBelief();
  const b3 = makeBelief();
  const b4 = makeBelief();
  const fillers = Array.from({ length: 11 }, () => makeBelief());
  await cols.beliefs.insertMany([existingActive, b1, b2, b3, b4, ...fillers]);

  const llmSpy = createLLMSpy([
    {
      merges: [
        {
          keep_id: b1._id,
          retire_ids: [b2._id],
          merged_content: "This canonical name collides with existing active",
          merged_canonical_name: "typescript_preference",
          merged_aliases: [],
          compaction_note: "Should not crash the batch",
          belief_type: "preference"
        },
        {
          keep_id: b3._id,
          retire_ids: [b4._id],
          merged_content: "This merge is safe and should succeed",
          merged_canonical_name: "safe_merge",
          merged_aliases: [],
          compaction_note: "Fine",
          belief_type: "preference"
        }
      ],
      contradictions: [],
      no_action_ids: fillers.map((f) => f._id)
    }
  ]);

  const runner = makeCompactionRunner(llmSpy);
  await t.notThrowsAsync(() => runner.run(USER_ID));

  t.true(
    llmSpy.call.calledOnce,
    "LLM should have been called exactly once for the compaction"
  );

  const callArgs = llmSpy.call.firstCall.args;
  t.is(
    callArgs[0],
    "test-model",
    "LLM should be called with the correct model ID"
  );
  t.truthy(callArgs[1], "LLM should receive a system prompt");
  t.truthy(callArgs[2], "LLM should receive messages");

  const collisionMerged = await cols.beliefs.findOne({
    canonical_name: "typescript_preference",
    superseded_by: null
  });
  t.is(collisionMerged!._id, existingActive._id);
  t.is(collisionMerged!.content, "Pre-existing active belief about TypeScript");

  const safeMerged = await cols.beliefs.findOne({
    canonical_name: "safe_merge",
    superseded_by: null
  });
  t.truthy(safeMerged);

  const retired1 = await cols.beliefs.findOne({ _id: b1._id });
  t.is(retired1!.epistemic_status, "superseded");
  t.is(retired1!.superseded_by, existingActive._id);
});

test("full extraction to compaction lifecycle works end to end", async (t) => {
  const { cols, makeWorker, makeCompactionRunner, createLLMSpy } =
    t.context.env;

  const canonicalA = `lifecycle_a_${randomUUID().slice(0, 8)}`;
  const canonicalB = `lifecycle_b_${randomUUID().slice(0, 8)}`;

  const job1 = makeJob({
    payload: {
      user_message:
        "I use Prettier for formatting and prefer 2-space indentation",
      assistant_message: "Got it.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalA,
            content: "Uses Prettier",
            confidence: 0.85
          }),
          makeNewBelief({
            canonical_name: canonicalB,
            content: "Prefers 2-space indent",
            confidence: 0.8
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job1);

  const worker = makeWorker();
  await worker.processById(job1._id as string);

  const doc1 = await cols.jobs.findOne({ _id: job1._id });
  t.is(doc1!.status, "done");
  t.is(doc1!.result_belief_ids!.length, 2);

  const beliefA = await cols.beliefs.findOne({
    canonical_name: canonicalA,
    user_id: USER_ID
  });
  t.truthy(beliefA);
  t.is(beliefA!.content, "Uses Prettier");
  t.is(beliefA!.reinforcement_count, 0);

  const job2 = makeJob({
    payload: {
      user_message: "I use prettier as my formatter",
      assistant_message: "Cool.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalA,
            content: "Uses Prettier",
            confidence: 0.8
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job2);
  await worker.processById(job2._id as string);

  const beliefA2 = await cols.beliefs.findOne({
    canonical_name: canonicalA,
    user_id: USER_ID
  });
  t.is(beliefA2!.reinforcement_count, 1);

  const fillerCount = 14;
  const fillers = Array.from({ length: fillerCount }, () =>
    makeBelief({ scope: ["coding"] })
  );
  await cols.beliefs.insertMany(fillers);

  const allBeliefs = [
    beliefA2!,
    (await cols.beliefs.findOne({
      canonical_name: canonicalB,
      user_id: USER_ID
    }))!,
    ...fillers
  ];
  t.is(allBeliefs.length, 16);

  const allIds = allBeliefs
    .filter((b): b is Belief => b !== null)
    .map((b) => b._id);

  const llmSpy = createLLMSpy([
    {
      merges: [],
      contradictions: [],
      no_action_ids: allIds
    }
  ]);

  const runner = makeCompactionRunner(llmSpy);
  const count = await cols.beliefs.countDocuments({
    user_id: USER_ID,
    scope: { $in: ["coding"] },
    type: "preference",
    resolved_at: null,
    superseded_by: null
  });

  await runner.run(USER_ID);

  t.true(
    llmSpy.call.calledOnce,
    "LLM should be called exactly once for the lifecycle compaction"
  );

  t.is(await cols.compaction_log.countDocuments({ user_id: USER_ID }), 1);

  const finalA = await cols.beliefs.findOne({
    canonical_name: canonicalA,
    user_id: USER_ID
  });
  t.truthy(finalA);
  t.is(finalA!.reinforcement_count, 1);
});

test("invalid sidecar safely parses with skipped beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        new_beliefs: [
          {
            type: "preference",
            canonical_name: "good_belief",
            content: "Valid content",
            scope: ["coding"],
            confidence: 0.8,
            why_it_matters: "Good reason",
            aliases: []
          },
          {
            type: "invalid_type",
            canonical_name: "bad_belief",
            scope: ["coding"],
            confidence: 0.8,
            why_it_matters: "Should be skipped"
          }
        ],
        belief_updates: [],
        new_open_questions: []
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");

  const skipped = (doc!.payload as any).skipped_beliefs;
  t.truthy(skipped);
  t.is(skipped.length, 1);
  t.is(skipped[0].index, 1);

  t.is(doc!.result_belief_ids!.length, 1);
  const persisted = await cols.beliefs.findOne({
    canonical_name: "good_belief",
    user_id: USER_ID
  });
  t.truthy(persisted);
});

test("malformed sidecar JSON fails gracefully", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: "not valid json at all {{{",
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "pending");
  t.truthy(doc!.last_error);
  t.truthy((doc!.payload as any).validation_error);
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);
});

test("parse_status missing returns empty without processing", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["coding"],
      parse_status: "missing",
      sidecar: makeSidecar({
        new_beliefs: [makeNewBelief()]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
  t.is(await cols.beliefs.countDocuments({ user_id: USER_ID }), 0);
});

test("compaction with no qualifying partitions does not call the LLM", async (t) => {
  const { cols, makeCompactionRunner, createLLMSpy } = t.context.env;

  const llmSpy = createLLMSpy([
    { merges: [], contradictions: [], no_action_ids: [] }
  ]);

  const runner = makeCompactionRunner(llmSpy);
  await runner.run(USER_ID);

  t.is(
    llmSpy.call.callCount,
    0,
    "LLM should not be called when no partitions qualify for compaction"
  );
});

test("compaction logs a run entry even when no merges occur", async (t) => {
  const { cols, makeCompactionRunner, createLLMSpy } = t.context.env;

  const fillers = Array.from({ length: 15 }, () =>
    makeBelief({ scope: ["coding"] })
  );
  await cols.beliefs.insertMany(fillers);

  const allIds = fillers.map((b) => b._id);

  const llmSpy = createLLMSpy([
    {
      merges: [],
      contradictions: [],
      no_action_ids: allIds
    }
  ]);

  const runner = makeCompactionRunner(llmSpy);
  await runner.run(USER_ID);

  const logEntry = await cols.compaction_log.findOne({ user_id: USER_ID });
  t.truthy(logEntry);
  t.is(logEntry!.merged_count, 0);
});

test("onboarding extraction marks onboarding complete and sets user_edited on all beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    type: "onboarding_extraction",
    payload: {
      user_message: "",
      assistant_message: "",
      scope: ["user:universal"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "onboarding_pref",
            content: "Uses VSCode",
            confidence: 0.9,
            scope: ["user:universal"]
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.is(doc!.result_belief_ids!.length, 1);

  const belief = await cols.beliefs.findOne({
    canonical_name: "onboarding_pref",
    user_id: USER_ID
  });
  t.truthy(belief);
  t.true(belief!.user_edited);

  const onboardingCfg = await cols.config.findOne({ key: "onboarding_status" });
  t.is(onboardingCfg!.value, "completed");
});

test("import extraction sets user_edited on all beliefs", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    type: "import_extraction",
    payload: {
      user_message: "",
      assistant_message: "",
      scope: ["user:universal"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: "imported_pref",
            content: "Uses Vim",
            confidence: 0.85,
            scope: ["user:universal"]
          })
        ]
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.is(doc!.result_belief_ids!.length, 1);

  const belief = await cols.beliefs.findOne({
    canonical_name: "imported_pref",
    user_id: USER_ID
  });
  t.truthy(belief);
  t.true(belief!.user_edited);
});

test("job retries on failure up to max_attempts", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: "completely broken {{{ not even close",
      source_model: "anthropic:claude-haiku"
    }
  });
  job.attempts = 2;
  job.max_attempts = 3;
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "failed");
  t.is(doc!.attempts, 3);
  t.truthy(doc!.last_error);
});

test("orientation tax reinforces matching beliefs and stamps the audit record", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const canonicalName = `tax_pref_${randomUUID().slice(0, 8)}`;
  await cols.beliefs.insertOne(
    makeBelief({
      canonical_name: canonicalName,
      content: "Prefers dark theme",
      confidence: 0.7,
      scope: ["coding"]
    })
  );

  const turnId = randomUUID();
  await cols.injection_audit.insertOne({
    _id: randomUUID(),
    user_id: USER_ID,
    request_id: turnId,
    session_id: SESSION_ID,
    scope: ["coding"],
    injected_beliefs: { pinned_facts: [], relevant_beliefs: [] },
    orientation_tax: false,
    created_at: new Date()
  } as any);

  const job = makeJob({
    payload: {
      user_message: "Like I said, I prefer dark theme",
      assistant_message: "Understood, dark theme.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        orientation_tax: true,
        new_beliefs: [
          {
            type: "preference",
            canonical_name: canonicalName,
            content: "Prefers dark theme",
            scope: ["coding"],
            confidence: 0.7,
            why_it_matters: "Avoids light theme",
            aliases: [],
            epistemic_status: "active"
          }
        ],
        belief_updates: [],
        new_open_questions: []
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  job.turn_id = turnId;
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const doc = await cols.jobs.findOne({ _id: job._id });
  t.is(doc!.status, "done");

  const belief = await cols.beliefs.findOne({
    canonical_name: canonicalName,
    user_id: USER_ID
  });
  t.is(belief!.reinforcement_count, 2);

  const audit = await cols.injection_audit.findOne({
    request_id: turnId,
    user_id: USER_ID
  });
  t.true(audit!.orientation_tax);
  t.truthy(audit!.orientation_tax_at);
});

test("enriched belief update appends content to existing belief", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const belief = makeBelief({
    canonical_name: "enrich_me",
    content: "Uses Rust",
    confidence: 0.75
  });
  await cols.beliefs.insertOne(belief);

  const job = makeJob({
    payload: {
      user_message: "Also I prefer async Rust",
      assistant_message: "Got it.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [
          {
            belief_id: belief._id,
            change: "enriched",
            new_content: "prefers async over sync"
          }
        ],
        new_open_questions: []
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const updated = await cols.beliefs.findOne({ _id: belief._id });
  t.is(updated!.content, "Uses Rust; prefers async over sync");
});

test("contradicted belief update flags the belief as a conflict", async (t) => {
  const { cols, makeWorker } = t.context.env;

  const belief = makeBelief({
    canonical_name: "contradict_me",
    content: "Prefers dark theme",
    confidence: 0.8
  });
  await cols.beliefs.insertOne(belief);

  const job = makeJob({
    payload: {
      user_message: "Actually I prefer light theme",
      assistant_message: "Light theme it is.",
      scope: ["coding"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [
          {
            belief_id: belief._id,
            change: "contradicted"
          }
        ],
        new_open_questions: []
      }),
      source_model: "anthropic:claude-haiku"
    }
  });
  await cols.jobs.insertOne(job);

  const worker = makeWorker();
  await worker.processById(job._id as string);

  const updated = await cols.beliefs.findOne({ _id: belief._id });
  t.is(updated!.content, "Prefers dark theme");
});
