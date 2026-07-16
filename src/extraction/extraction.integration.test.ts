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
    agent_id: null,
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
  if (t.context.env) {
    await t.context.env.teardown();
  }
});

test.beforeEach(async (t) => {
  await t.context.env.resetAll();
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

  await cols.injection_audit.insertOne({
    _id: randomUUID(),
    user_id: USER_ID,
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
