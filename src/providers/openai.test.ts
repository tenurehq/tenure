import test from "ava";
import sinon from "sinon";
import { OpenAIAdapter, ProviderError } from "./openai.js";

const MOCK_BODY = {
  model: "gpt-4o",
  choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

test.afterEach.always(() => sinon.restore());

test.serial("call() maps response to NormalizedResponse", async (t) => {
  sinon.stub(globalThis, "fetch").resolves(jsonResponse(MOCK_BODY));
  const result = await new OpenAIAdapter("key").call(
    "gpt-4o",
    "",
    [{ role: "user", content: "Hi" }],
    {}
  );

  t.is(result.content, "Hello!");

  t.is(result.finish_reason, "stop");
  t.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test.serial("call() sets Bearer authorization header", async (t) => {
  const fetchStub = sinon
    .stub(globalThis, "fetch")
    .resolves(jsonResponse(MOCK_BODY));
  await new OpenAIAdapter("my-secret").call(
    "gpt-4o",
    "",
    [{ role: "user", content: "Hi" }],
    {}
  );

  const headers = fetchStub.firstCall.args[1]?.headers as Record<
    string,
    string
  >;
  t.is(headers["authorization"], "Bearer my-secret");
});

test.serial(
  "call() merges injected system prompt with existing system message",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      "Injected",
      [
        { role: "system", content: "Base" },
        { role: "user", content: "Hi" }
      ],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].role, "system");
    t.is(body.messages[0].content, "Injected\n\nBase");
  }
);

test.serial(
  "call() omits system message when both system sources are empty",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].role, "user");
  }
);

test.serial(
  "call() forwards model, temperature, max_tokens, stream=false",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      { temperature: 0.1, max_tokens: 256 }
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.model, "gpt-4o");
    t.is(body.temperature, 0.7);
    t.is(body.max_tokens, 256);
    t.false(body.stream);
  }
);

test.serial("call() throws ProviderError on non-2xx response", async (t) => {
  sinon.stub(globalThis, "fetch").resolves(jsonResponse({ error: "bad" }, 400));
  const err = await t.throwsAsync(
    () =>
      new OpenAIAdapter("key").call(
        "gpt-4o",
        "",
        [{ role: "user", content: "Hi" }],
        {}
      ),
    { instanceOf: ProviderError }
  );
  t.regex(err!.message, /400/);
});

test.serial("call() uses custom baseUrl instead of default", async (t) => {
  const fetchStub = sinon
    .stub(globalThis, "fetch")
    .resolves(jsonResponse(MOCK_BODY));
  await new OpenAIAdapter("key", "https://custom.api.com/v1").call(
    "gpt-4o",
    "",
    [{ role: "user", content: "Hi" }],
    {}
  );

  const url = fetchStub.firstCall.args[0] as string;
  t.is(url, "https://custom.api.com/v1/chat/completions");
});

test.serial(
  "call() adds prompt_caching for bedrock-access-gateway flavor",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key", undefined, "bedrock-access-gateway").call(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.deepEqual(body.prompt_caching, { system: true, messages: true });
  }
);

test.serial(
  "call() does not add prompt_caching for generic flavor",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.prompt_caching, undefined);
  }
);

test.serial(
  "call() throws ProviderError when choices array is empty",
  async (t) => {
    sinon.stub(globalThis, "fetch").resolves(
      jsonResponse({
        model: "gpt-4o",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0 }
      })
    );

    const err = await t.throwsAsync(
      () =>
        new OpenAIAdapter("key").call(
          "gpt-4o",
          "",
          [{ role: "user", content: "Hi" }],
          {}
        ),
      { instanceOf: ProviderError }
    );
    t.regex(err!.message, /empty choices/);
  }
);

test.serial(
  "call() flattens SystemPromptParts into a single string",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      {
        static: "You are helpful.",
        beliefs: "User likes cats.",
        dynamic: "Today is Monday."
      },
      [{ role: "user", content: "Hi" }],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].role, "system");
    t.is(
      body.messages[0].content,
      "You are helpful.\n\nUser likes cats.\n\nToday is Monday."
    );
  }
);

test.serial(
  "call() handles content-part array in existing system message",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      "gpt-4o",
      "Injected",
      [
        {
          role: "system",
          content: [
            { type: "text", text: "Part A" },
            { type: "text", text: "Part B" }
          ]
        },
        { role: "user", content: "Hi" }
      ],
      {}
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].content, "Injected\n\nPart A\nPart B");
  }
);

function sseStream(lines: string[]): Response {
  const text = lines.map((l) => `data: ${l}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test.serial(
  "callStream() yields content_delta events for each SSE chunk",
  async (t) => {
    sinon.stub(globalThis, "fetch").resolves(
      sseStream([
        JSON.stringify({
          choices: [{ delta: { content: "Hello" } }]
        }),
        JSON.stringify({
          choices: [{ delta: { content: " world" } }]
        }),
        "[DONE]"
      ])
    );

    const events: import("./types.js").StreamEvent[] = [];
    for await (const event of new OpenAIAdapter("key").callStream(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      {}
    )) {
      events.push(event);
    }

    t.is(events.length, 3);
    t.is(events[0].type, "content_delta");
    t.is(events[0].delta, "Hello");
    t.is(events[1].type, "content_delta");
    t.is(events[1].delta, " world");
    t.is(events[2].type, "stream_end");
    t.is(events[2].finish_reason, "stop");
    t.deepEqual(events[2].usage, { input_tokens: 0, output_tokens: 0 });
  }
);

test.serial("callStream() stops on [DONE] marker", async (t) => {
  sinon
    .stub(globalThis, "fetch")
    .resolves(
      sseStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        "[DONE]",
        JSON.stringify({ choices: [{ delta: { content: "ignored" } }] })
      ])
    );

  const events: import("./types.js").StreamEvent[] = [];
  for await (const event of new OpenAIAdapter("key").callStream(
    "gpt-4o",
    "",
    [{ role: "user", content: "Hi" }],
    {}
  )) {
    events.push(event);
  }

  t.is(events.length, 2);
  t.is(events[0].type, "content_delta");
  t.is(events[0].delta, "Hi");
  t.is(events[1].type, "stream_end");
  t.is(events[1].finish_reason, "stop");
});

test.serial(
  "callStream() throws ProviderError on non-2xx response",
  async (t) => {
    sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse({ error: "bad" }, 500));

    const err = await t.throwsAsync(
      async () => {
        for await (const _ of new OpenAIAdapter("key").callStream(
          "gpt-4o",
          "",
          [{ role: "user", content: "Hi" }],
          {}
        )) {
        }
      },
      { instanceOf: ProviderError }
    );
    t.regex(err!.message, /500/);
  }
);

test.serial(
  "callStream() throws ProviderError when response body is null",
  async (t) => {
    sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(null, { status: 200 }));

    const err = await t.throwsAsync(
      async () => {
        for await (const _ of new OpenAIAdapter("key").callStream(
          "gpt-4o",
          "",
          [{ role: "user", content: "Hi" }],
          {}
        )) {
        }
      },
      { instanceOf: ProviderError }
    );
    t.regex(err!.message, /empty stream body/);
  }
);

test.serial(
  "callStream() skips malformed JSON lines without throwing",
  async (t) => {
    sinon
      .stub(globalThis, "fetch")
      .resolves(
        sseStream([
          "not valid json",
          JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
          "[DONE]"
        ])
      );

    const events: import("./types.js").StreamEvent[] = [];
    for await (const event of new OpenAIAdapter("key").callStream(
      "gpt-4o",
      "",
      [{ role: "user", content: "Hi" }],
      {}
    )) {
      events.push(event);
    }

    t.is(events.length, 2);
    t.is(events[0].type, "content_delta");
    t.is(events[0].delta, "ok");
    t.is(events[1].type, "stream_end");
    t.is(events[1].finish_reason, "stop");
  }
);

test.serial("listModels() returns model list on success", async (t) => {
  sinon.stub(globalThis, "fetch").resolves(
    jsonResponse({
      data: [
        {
          id: "gpt-4o",
          object: "model",
          created: 1700000000,
          owned_by: "openai"
        },
        {
          id: "gpt-4o-mini",
          object: "model",
          created: 1700000001,
          owned_by: "openai"
        }
      ]
    })
  );

  const models = await new OpenAIAdapter("key").listModels();
  t.is(models.length, 2);
  t.is(models[0].id, "gpt-4o");
  t.is(models[1].id, "gpt-4o-mini");
});

test.serial("listModels() throws ProviderError on 401 status", async (t) => {
  sinon
    .stub(globalThis, "fetch")
    .resolves(jsonResponse({ error: "unauthorized" }, 401));

  const err = await t.throwsAsync(
    () => new OpenAIAdapter("bad-key").listModels(),
    { instanceOf: ProviderError }
  );
  t.regex(err!.message, /authentication failed/i);
});

test.serial(
  "listModels() returns empty array on non-401 failure",
  async (t) => {
    sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse({ error: "server error" }, 500));

    const models = await new OpenAIAdapter("key").listModels();
    t.deepEqual(models, []);
  }
);
