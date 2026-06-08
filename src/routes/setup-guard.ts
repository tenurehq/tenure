import type { FastifyRequest, FastifyReply } from "fastify";

export async function requireRootToken(
  req: FastifyRequest,
  reply: FastifyReply
) {
  if (process.env.TENURE_MODE === "teams" && req.tenureAuthMethod !== "root") {
    return reply.code(403).send({
      error: {
        message: "This action requires the root token in teams mode."
      }
    });
  }
}
