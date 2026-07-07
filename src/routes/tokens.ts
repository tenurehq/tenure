import type { FastifyInstance } from "fastify";
import type { TokenService } from "../auth/tokenService.js";
import type {
  AgentCapability,
  ClientCapability,
  CreateTokenRequest
} from "../types/token.js";
import { CLIENT_CAPABILITIES, AGENT_CAPABILITIES } from "../types/token.js";

export interface TokenRouteDeps {
  tokenService: TokenService;
}

interface CreateClientTokenBody
  extends Omit<CreateTokenRequest, "kind" | "capabilities"> {
  capabilities: ClientCapability[];
}

interface CreateAgentTokenBody
  extends Omit<CreateTokenRequest, "kind" | "capabilities"> {
  capabilities: AgentCapability[];
}

export function registerTokenRoutes(
  app: FastifyInstance,
  deps: TokenRouteDeps
): void {
  app.get("/admin/tokens", async (req) => {
    const userId = req.tenureUserId;
    const tokens = await deps.tokenService.listTokens(userId);
    return { tokens };
  });

  app.post<{ Body: CreateClientTokenBody }>(
    "/admin/tokens/client",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "capabilities"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            capabilities: {
              type: "array",
              items: { type: "string", enum: CLIENT_CAPABILITIES },
              minItems: 1
            },
            project_scopes: {
              type: ["array", "null"],
              items: { type: "string" }
            },
            ttl_days: {
              type: ["number", "null"],
              minimum: 1
            }
          }
        }
      }
    },
    async (req, reply) => {
      const result = await deps.tokenService.issueToken(req.tenureUserId, {
        name: req.body.name,
        kind: "client",
        capabilities: req.body.capabilities,
        project_scopes: req.body.project_scopes,
        ttl_days: req.body.ttl_days
      });

      return reply.code(201).send(result);
    }
  );

  app.post<{ Body: CreateAgentTokenBody }>(
    "/admin/tokens/agent",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "capabilities"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            capabilities: {
              type: "array",
              items: { type: "string", enum: AGENT_CAPABILITIES },
              minItems: 1
            },
            project_scopes: {
              type: ["array", "null"],
              items: { type: "string" }
            },
            ttl_days: {
              type: ["number", "null"],
              minimum: 1
            }
          }
        }
      }
    },
    async (req, reply) => {
      const result = await deps.tokenService.issueToken(req.tenureUserId, {
        name: req.body.name,
        kind: "agent",
        capabilities: req.body.capabilities,
        project_scopes: req.body.project_scopes,
        ttl_days: req.body.ttl_days
      });

      return reply.code(201).send(result);
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/tokens/:id",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const ok = await deps.tokenService.revokeToken(userId, req.params.id);

      if (!ok) {
        return reply
          .code(404)
          .send({ error: { message: "Token not found or already revoked" } });
      }

      return { revoked: true };
    }
  );
}
