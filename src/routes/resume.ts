import type { FastifyInstance } from "fastify";
import type { ProjectResumeService } from "../context/projectResume.js";

export interface ResumeRouteDeps {
  projectResume: ProjectResumeService;
}

export function registerResumeRoutes(
  app: FastifyInstance,
  deps: ResumeRouteDeps
): void {
  app.post("/v1/resume/generate", async (req, reply) => {
    try {
      const snapshot = await deps.projectResume.generate(req.tenureUserId);
      return { snapshot };
    } catch (err) {
      req.log.warn({ err }, "resume generation failed");
      return reply
        .code(400)
        .send({ error: { message: (err as Error).message } });
    }
  });
}
