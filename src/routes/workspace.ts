import type { FastifyInstance } from "fastify";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";

export interface WorkspaceDeps {
  workspaceState: WorkspaceStateCache;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceDeps
): void {
  app.post("/v1/workspace/state", async (req, reply) => {
    const userId = req.tenureUserId;

    const body = req.body as {
      workspace_root?: string;
      project_name?: string;
      git_remote?: string | null;
      active_file?: string | null;
      active_language?: string | null;
    };

    if (!body.workspace_root || !body.project_name) {
      return reply.code(400).send({
        error: { message: "workspace_root and project_name are required" }
      });
    }

    await deps.workspaceState.set(userId, {
      workspace_root: body.workspace_root,
      project_name: body.project_name,
      git_remote: body.git_remote ?? null,
      active_file: body.active_file ?? null,
      active_language: body.active_language ?? null,
      updated_at: new Date()
    });

    return { ok: true };
  });

  app.get("/v1/workspace/state", async (req, _reply) => {
    const userId = req.tenureUserId;

    const state = await deps.workspaceState.load(userId);
    if (!state) {
      return { state: null };
    }
    return { state };
  });
}
