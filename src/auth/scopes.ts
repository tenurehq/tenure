import type { FastifyRequest, FastifyReply } from "fastify";

export function requireCapability(...capabilities: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.tenureTokenKind === "root") return;

    const tokenCapabilities = req.tenureTokenCapabilities ?? [];
    const hasCapability = capabilities.some((c) =>
      tokenCapabilities.includes(c)
    );

    if (!hasCapability) {
      return reply.code(403).send({
        error: {
          message: `This endpoint requires one of: ${capabilities.join(", ")}`,
          required_capabilities: capabilities,
          token_capabilities: tokenCapabilities
        }
      });
    }
  };
}
