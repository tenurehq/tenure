export type TokenKind = "root" | "client" | "agent";

export type TokenCapability =
  | "chat"
  | "beliefs:read"
  | "beliefs:write"
  | "extraction"
  | "injection"
  | "admin";

export type RootCapability = "admin";

export type ClientCapability = Exclude<TokenCapability, "admin">;

export type AgentCapability = Extract<
  TokenCapability,
  "chat" | "extraction" | "injection"
>;

export const ROOT_CAPABILITIES: RootCapability[] = ["admin"];

export const CLIENT_CAPABILITIES: ClientCapability[] = [
  "chat",
  "beliefs:read",
  "beliefs:write",
  "extraction",
  "injection"
];

export const AGENT_CAPABILITIES: AgentCapability[] = [
  "chat",
  "extraction",
  "injection"
];

export const CAPABILITY_DESCRIPTIONS: Record<TokenCapability, string> = {
  chat: "Chat completions - use /v1/chat/completions and /v1/messages",
  "beliefs:read": "Read beliefs - list, search, and inspect beliefs",
  "beliefs:write":
    "Manual belief CRUD - create, update, delete beliefs via API. Only available on client tokens.",
  extraction:
    "Auto-extract beliefs from chat turns. Only available on client and agent tokens.",
  injection:
    "Inject beliefs into chat context. Only available on client and agent tokens.",
  admin:
    "Admin access - manage config, providers, and system settings. Root token only."
};

export interface CreateTokenRequest {
  name: string;
  kind: Exclude<TokenKind, "root">;
  capabilities: ClientCapability[] | AgentCapability[];
  project_scopes?: string[] | null | undefined;
  ttl_days?: number | null | undefined;
}

export interface TokenResponse {
  id: string;
  kind: TokenKind;
  name: string;
  token_prefix: string;
  capabilities: TokenCapability[];
  project_scopes: string[] | null;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  expires_at?: string | null;
}

export interface CreateTokenResponse {
  token: string;
  token_info: TokenResponse;
}
