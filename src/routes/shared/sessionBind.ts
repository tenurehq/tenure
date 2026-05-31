import type { FastifyBaseLogger } from "fastify";
import type { SessionManager, Session } from "../../session/manager.js";
import type { ProviderAdapter } from "../../providers/types.js";

export interface BoundSession extends Session {
  providerId: string;
  model: string;
}

export interface SessionBindDeps {
  sessions: SessionManager;
}

export async function bindSessionToModel(
  sessionId: string,
  userId: string,
  adapter: ProviderAdapter,
  requestedModel: string,
  deps: SessionBindDeps,
  logger: FastifyBaseLogger,
): Promise<BoundSession | null> {
  try {
    const raw = await deps.sessions.getOrCreate(sessionId, userId);
    const needsBind =
      !raw.providerId || !raw.model || raw.model !== requestedModel;

    if (!needsBind) {
      return raw as BoundSession;
    }

    const updated = await deps.sessions.update(sessionId, userId, {
      providerId: adapter.id,
      model: requestedModel,
    });

    if (updated?.providerId && updated?.model) {
      return updated as BoundSession;
    }

    return null;
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "session bind failed — proceeding without session",
    );
    return null;
  }
}
