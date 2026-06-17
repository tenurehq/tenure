import test from "ava";
import sinon from "sinon";
import Anthropic from "@anthropic-ai/sdk";

import { AnthropicAdapter, type AnthropicCallRequest } from "./anthropic.js";

const BASE_REQ: AnthropicCallRequest = {
  model: "claude-3-5-sonnet-20241022",
  messages: [{ role: "user", content: "Hi" }]
};

const MOCK_RESPONSE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [{ type: "text", text: "Hello!" }],
  usage: { input_tokens: 10, output_tokens: 5 }
} as unknown as Anthropic.Message;

const makeSdkError = (Cls: {
  prototype: InstanceType<typeof Anthropic.APIError>;
}) => Object.create(Cls.prototype) as InstanceType<typeof Anthropic.APIError>;

const stubCreate = (adapter: AnthropicAdapter) =>
  sinon.stub((adapter as any).client.messages, "create");

test.afterEach(() => sinon.restore());

test("call() returns normalized response", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves(MOCK_RESPONSE);

  const result = await adapter.call(BASE_REQ, "You are helpful");

  t.is(result.content, "Hello!");
  t.is(result.model, "claude-3-5-sonnet-20241022");
  t.is(result.finish_reason, "stop");
  t.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test("call() filters system role messages out of conversation", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      messages: [
        { role: "system", content: "Should be filtered" },
        { role: "user", content: "Hi" }
      ]
    },
    "Injected"
  );

  const params = createStub.firstCall.args[0] as any;
  t.is(params.system, "Injected");
  t.is(params.messages.length, 1);
  t.is(params.messages[0].role, "user");
});

test("call() omits system field when both sources are empty", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(BASE_REQ, "");

  t.false("system" in createStub.firstCall.args[0]);
});

const stopReasonMacro = test.macro<[stopReason: string, expected: string]>(
  async (t, stopReason, expected) => {
    const adapter = new AnthropicAdapter("key");
    stubCreate(adapter).resolves({ ...MOCK_RESPONSE, stop_reason: stopReason });
    const result = await adapter.call(BASE_REQ, "");
    t.is(result.finish_reason, expected);
  }
);

test("stop_reason end_turn → stop", stopReasonMacro, "end_turn", "stop");
test(
  "stop_reason max_tokens → length",
  stopReasonMacro,
  "max_tokens",
  "length"
);
test(
  "stop_reason stop_sequence → stop",
  stopReasonMacro,
  "stop_sequence",
  "stop"
);
test(
  "stop_reason tool_use → tool_calls",
  stopReasonMacro,
  "tool_use",
  "tool_calls"
);

test("call() extracts tool_use blocks into toolCalls", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves({
    ...MOCK_RESPONSE,
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "tu_01",
        name: "get_weather",
        input: { location: "NYC" }
      }
    ]
  });

  const result = await adapter.call(BASE_REQ, "");
  const tc = (result.toolCalls as any[])[0];

  t.is(tc.id, "tu_01");
  t.is(tc.type, "function");
  t.is(tc.function.name, "get_weather");
  t.deepEqual(JSON.parse(tc.function.arguments), { location: "NYC" });
});

test("call() maps AuthenticationError to friendly message", async (t) => {
  const adapter = new AnthropicAdapter("bad-key");
  stubCreate(adapter).rejects(makeSdkError(Anthropic.AuthenticationError));

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /authentication failed/i);
});

test("call() maps RateLimitError to friendly message", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).rejects(makeSdkError(Anthropic.RateLimitError));

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /rate limit/i);
});

test("call() maps generic APIError with status code", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const sdkErr = Object.assign(makeSdkError(Anthropic.APIError), {
    status: 503,
    message: "Service unavailable"
  });
  stubCreate(adapter).rejects(sdkErr);

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /503/);
});

test("call() produces structured TextBlockParam[] system with SystemPromptParts", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(BASE_REQ, {
    static: "You are helpful.",
    beliefs: "User likes cats.",
    dynamic: "Today is Monday."
  });

  const params = createStub.firstCall.args[0] as any;
  t.true(Array.isArray(params.system));
  t.is(params.system.length, 3);

  t.is(params.system[0].type, "text");
  t.is(params.system[0].text, "You are helpful.");
  t.deepEqual(params.system[0].cache_control, { type: "ephemeral" });

  t.is(params.system[1].type, "text");
  t.is(params.system[1].text, "User likes cats.");
  t.deepEqual(params.system[1].cache_control, { type: "ephemeral" });

  t.is(params.system[2].type, "text");
  t.is(params.system[2].text, "Today is Monday.");
  t.is(params.system[2].cache_control, undefined);
});

test("call() forwards temperature when provided", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call({ ...BASE_REQ, temperature: 0.8 }, "");

  const params = createStub.firstCall.args[0] as any;
  t.is(params.temperature, 0.8);
});

test("call() uses max_tokens from request or defaults to 120000", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call({ ...BASE_REQ, max_tokens: 4096 }, "");
  t.is((createStub.firstCall.args[0] as any).max_tokens, 4096);

  createStub.resetHistory();
  createStub.resolves(MOCK_RESPONSE);
  await adapter.call(BASE_REQ, "");
  t.is((createStub.firstCall.args[0] as any).max_tokens, 120000);
});

test("call() passes native Anthropic tools through verbatim", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  const nativeTools = [
    {
      name: "get_weather",
      description: "Get current weather",
      input_schema: { type: "object", properties: {} }
    }
  ];

  await adapter.call({ ...BASE_REQ, passThrough: { tools: nativeTools } }, "");

  const params = createStub.firstCall.args[0] as any;
  t.deepEqual(params.tools, nativeTools);
});

test("call() passes native Anthropic tool_choice through verbatim", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      passThrough: {
        tools: [
          { name: "fn1", input_schema: { type: "object", properties: {} } }
        ],
        tool_choice: { type: "any" }
      }
    },
    ""
  );

  const params = createStub.firstCall.args[0] as any;
  t.deepEqual(params.tool_choice, { type: "any" });
});

test("call() passes top_p and stop_sequences through verbatim", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      passThrough: { top_p: 0.9, stop_sequences: ["END", "HALT"] }
    },
    ""
  );

  const params = createStub.firstCall.args[0] as any;
  t.is(params.top_p, 0.9);
  t.deepEqual(params.stop_sequences, ["END", "HALT"]);
});

test("call() throws when model is empty", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves(MOCK_RESPONSE);

  const err = await t.throwsAsync(() =>
    adapter.call({ ...BASE_REQ, model: "" }, "")
  );
  t.regex(err!.message, /No model specified/);
});

test("callPositional() delegates to call() correctly", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves(MOCK_RESPONSE);

  const result = await adapter.callPositional(
    "claude-3-5-sonnet-20241022",
    "Be helpful",
    [{ role: "user", content: "Hi" }],
    { temperature: 0.1 }
  );

  t.is(result.content, "Hello!");
  t.is(result.model, "claude-3-5-sonnet-20241022");
  t.is(result.finish_reason, "stop");
  t.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

const stubStream = (adapter: AnthropicAdapter) =>
  sinon.stub((adapter as any).client.messages, "stream");

function makeMockStream(events: any[], finalMessage: any) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    },
    finalMessage() {
      return Promise.resolve(finalMessage);
    }
  };
}

test("callStream() yields content_delta events from text_delta", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const streamStub = stubStream(adapter);

  streamStub.returns(
    makeMockStream(
      [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" }
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" }
        }
      ],
      { ...MOCK_RESPONSE, model: "claude-3-5-sonnet-20241022" }
    )
  );

  const events: import("./types.js").StreamEvent[] = [];
  for await (const event of adapter.callStream(BASE_REQ, "")) {
    events.push(event);
  }

  const contentEvents = events.filter((e) => e.type === "content_delta");
  t.is(contentEvents.length, 2);
  t.is(contentEvents[0].delta, "Hello");
  t.is(contentEvents[1].delta, " world");
});

test("callStream() yields text_block_start on new text block", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const streamStub = stubStream(adapter);

  streamStub.returns(
    makeMockStream(
      [
        {
          type: "content_block_start",
          content_block: { type: "text", text: "" }
        }
      ],
      MOCK_RESPONSE
    )
  );

  const events: import("./types.js").StreamEvent[] = [];
  for await (const event of adapter.callStream(BASE_REQ, "")) {
    events.push(event);
  }

  const blockStarts = events.filter((e) => e.type === "text_block_start");
  t.is(blockStarts.length, 1);
});

test("callStream() yields tool_call_delta on tool_use blocks", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const streamStub = stubStream(adapter);

  streamStub.returns(
    makeMockStream(
      [
        {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "toolu_01",
            name: "get_weather",
            input: {}
          }
        },
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"loc' }
        },
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '":"NYC"}' }
        }
      ],
      {
        ...MOCK_RESPONSE,
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "get_weather",
            input: { loc: "NYC" }
          }
        ]
      }
    )
  );

  const events: import("./types.js").StreamEvent[] = [];
  for await (const event of adapter.callStream(BASE_REQ, "")) {
    events.push(event);
  }

  const toolDeltas = events.filter((e) => e.type === "tool_call_delta");
  t.true(toolDeltas.length >= 1);
  t.is(toolDeltas[0].toolCallId, "toolu_01");
  t.is(toolDeltas[0].toolCallName, "get_weather");
});

test("callStream() emits stream_end with model, finish_reason, and usage", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const streamStub = stubStream(adapter);

  streamStub.returns(
    makeMockStream(
      [
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi" }
        }
      ],
      {
        ...MOCK_RESPONSE,
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 10 }
      }
    )
  );

  const events: import("./types.js").StreamEvent[] = [];
  for await (const event of adapter.callStream(BASE_REQ, "")) {
    events.push(event);
  }

  const endEvent = events.find((e) => e.type === "stream_end");
  t.truthy(endEvent);
  t.is(endEvent!.model, "claude-3-5-sonnet-20241022");
  t.is(endEvent!.finish_reason, "stop");
  t.deepEqual(endEvent!.usage, { input_tokens: 20, output_tokens: 10 });
});

test("callStream() passes abortSignal to the SDK stream call", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const streamStub = stubStream(adapter);

  streamStub.returns(makeMockStream([], MOCK_RESPONSE));

  const controller = new AbortController();
  const req = { ...BASE_REQ, abortSignal: controller.signal };

  for await (const _ of adapter.callStream(req, "")) {
  }

  const params = streamStub.firstCall.args[0] as any;
  t.is(params.signal, controller.signal);
});

const stubListModels = (adapter: AnthropicAdapter) =>
  sinon.stub((adapter as any).client.models, "list");

test("listModels() returns mapped model list on success", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubListModels(adapter).resolves({
    data: [
      { id: "claude-3-5-sonnet-20241022", created_at: "2024-10-22T00:00:00Z" },
      { id: "claude-3-haiku-20240307", created_at: "2024-03-07T00:00:00Z" }
    ]
  });

  const models = await adapter.listModels();
  t.is(models.length, 2);
  t.is(models[0].id, "claude-3-5-sonnet-20241022");
  t.is(models[0].owned_by, "anthropic");
  t.is(models[0].object, "model");
});

test("listModels() re-throws AuthenticationError", async (t) => {
  const adapter = new AnthropicAdapter("bad-key");
  stubListModels(adapter).rejects(makeSdkError(Anthropic.AuthenticationError));

  const err = await t.throwsAsync(() => adapter.listModels());
  t.regex(err!.message, /authentication failed/i);
});

test("listModels() returns empty array on non-auth failures", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubListModels(adapter).rejects(new Error("network timeout"));

  const models = await adapter.listModels();
  t.deepEqual(models, []);
});
