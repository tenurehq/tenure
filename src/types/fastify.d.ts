import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenureUserId: string;
    tenureAuthMethod: "token";
    tenureTokenId?: string;
    tenureTokenName?: string;
    tenureTokenCapabilities?: string[];
    tenureTokenProjectScopes?: string[] | null;
    tenureTokenKind?: "client" | "agent" | "root";
    tenureTokenExtractionEnabled?: boolean;
    tenureTokenInjectionEnabled?: boolean;
  }
}
