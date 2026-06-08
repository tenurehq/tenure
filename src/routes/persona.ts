import type { FastifyInstance } from "fastify";
import type { PersonaCache } from "../context/personaCache.js";
import type { PersonaSummaryService } from "../context/personaSummary.js";

export interface PersonaDeps {
  persona: PersonaCache;
  personaSummary: PersonaSummaryService;
}

export function registerPersonaRoutes(
  app: FastifyInstance,
  deps: PersonaDeps
): void {
  app.get("/v1/persona", async (req) => {
    const userId = req.tenureUserId;

    const doc = await deps.persona.get(userId);
    return {
      universal: doc?.universal ?? null,
      generated_at: doc?.generated_at ?? null
    };
  });

  app.post("/v1/persona/regenerate", async (req) => {
    const userId = req.tenureUserId;

    await deps.personaSummary.regenerate(userId);
    return { ok: true };
  });
}
