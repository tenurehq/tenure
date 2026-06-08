import type { Collection, ResumeToken } from "mongodb";
import type { Belief } from "../types/belief.js";
import { redactForClient, registry } from "../routes/beliefs-ws.js";

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function startBeliefChangeStream(
  col: Collection<Belief>,
  encryptedCol: Collection<Belief>
): () => void {
  let stopped = false;
  let resumeToken: ResumeToken | undefined;
  let attempt = 0;

  function open(): void {
    if (stopped) return;
    const pipeline = [
      {
        $match: {
          $or: [
            { operationType: "insert" },
            { operationType: "update" },
            { operationType: "replace" }
          ]
        }
      }
    ];

    const stream = col.watch(pipeline, {
      fullDocument: "updateLookup",
      ...(resumeToken ? { resumeAfter: resumeToken } : {})
    });

    stream.on("change", async (event) => {
      resumeToken = event._id;
      attempt = 0;

      if (event.operationType === "insert") {
        const doc = await encryptedCol.findOne({
          _id: event.documentKey._id
        });
        if (!doc) return;
        registry.broadcast(doc.user_id, {
          type: "belief_upserted",
          belief: redactForClient(doc)
        });
        return;
      }

      if (
        event.operationType === "update" ||
        event.operationType === "replace"
      ) {
        const doc = await encryptedCol.findOne({
          _id: event.documentKey._id
        });
        if (!doc) return;

        if (doc.superseded_by != null) {
          registry.broadcast(doc.user_id, {
            type: "belief_superseded",
            id: doc._id
          });
        } else {
          registry.broadcast(doc.user_id, {
            type: "belief_upserted",
            belief: redactForClient(doc)
          });
        }
        return;
      }
    });

    stream.on("error", (err) => {
      console.error("[BeliefChangeStream] error, will retry:", err.message);
      stream.close().catch(() => {});
      scheduleReopen();
    });

    stream.on("close", () => {
      scheduleReopen();
    });
  }

  function scheduleReopen(): void {
    if (stopped) return;
    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, attempt), MAX_RETRY_MS);
    attempt++;
    setTimeout(open, delay);
  }

  open();

  return () => {
    stopped = true;
  };
}
