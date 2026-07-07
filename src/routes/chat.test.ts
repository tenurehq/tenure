import test from "ava";
import {
  SIDECAR_BEGIN,
  SIDECAR_END,
  splitSidecar
} from "../sidecar/splitter.js";

function extractLatestUserMessage(
  messages: Array<{ role: string; content: string }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

test("extractLatestUserMessage returns the last user message", (t) => {
  const msgs = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" }
  ];
  t.is(extractLatestUserMessage(msgs), "second");
});

test("extractLatestUserMessage skips trailing assistant messages", (t) => {
  const msgs = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" }
  ];
  t.is(extractLatestUserMessage(msgs), "hello");
});

test("extractLatestUserMessage returns empty string when no user messages", (t) => {
  const msgs = [{ role: "assistant", content: "I'll start" }];
  t.is(extractLatestUserMessage(msgs), "");
});

test("extractLatestUserMessage returns empty string for empty array", (t) => {
  t.is(extractLatestUserMessage([]), "");
});

test("extractLatestUserMessage handles single user message", (t) => {
  t.is(
    extractLatestUserMessage([{ role: "user", content: "only one" }]),
    "only one"
  );
});
