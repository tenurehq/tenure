import { randomBytes, createHmac } from "node:crypto";
import type { Collection } from "mongodb";
import type { TokenDoc } from "../db/collections.js";
import type {
  CreateTokenRequest,
  CreateTokenResponse,
  TokenCapability,
  TokenKind,
  TokenResponse
} from "../types/token.js";
import {
  AGENT_CAPABILITIES,
  CLIENT_CAPABILITIES,
  ROOT_CAPABILITIES
} from "../types/token.js";

const TOKEN_PREFIX_BY_KIND: Record<TokenKind, string> = {
  root: "mp_",
  client: "pat_",
  agent: "agt_"
};
const RAW_TOKEN_BYTES = 24;

function hashToken(token: string, hmacKey: Buffer): string {
  return createHmac("sha256", hmacKey).update(token).digest("hex");
}

function generateToken(
  hmacKey: Buffer,
  kind: TokenKind
): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const prefix = TOKEN_PREFIX_BY_KIND[kind];
  const raw = `${prefix}${randomBytes(RAW_TOKEN_BYTES).toString("base64url")}`;
  const hash = hashToken(raw, hmacKey);
  return { raw, hash, prefix };
}

function resolveExpiry(ttlDays?: number | null): Date | null {
  if (ttlDays == null) return null;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return null;
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
}

function validateCapabilities(
  kind: Exclude<TokenKind, "root">,
  capabilities: TokenCapability[]
): void {
  const allowed = new Set(
    kind === "agent" ? AGENT_CAPABILITIES : CLIENT_CAPABILITIES
  );
  if (capabilities.length === 0) {
    throw new Error("At least one capability is required");
  }
  for (const capability of capabilities) {
    if (!allowed.has(capability as any)) {
      throw new Error(
        `Capability ${capability} is not allowed for ${kind} tokens`
      );
    }
  }
}

function docToResponse(doc: TokenDoc): TokenResponse {
  return {
    id: doc._id,
    kind: doc.kind,
    name: doc.name,
    token_prefix: doc.token_prefix,
    capabilities: doc.capabilities,
    project_scopes: doc.project_scopes ?? null,
    created_at: doc.created_at.toISOString(),
    last_used_at: doc.last_used_at?.toISOString() ?? null,
    revoked_at: doc.revoked_at?.toISOString() ?? null,
    expires_at: doc.expires_at?.toISOString() ?? null
  };
}

export class TokenService {
  private readonly hmacKey: Buffer;

  constructor(
    private readonly tokenCol: Collection<TokenDoc>,
    hmacKey: Buffer
  ) {
    this.hmacKey = hmacKey;
  }

  async ensureRootToken(userId: string, rawToken: string): Promise<void> {
    const hash = hashToken(rawToken, this.hmacKey);
    const now = new Date();

    const existing = await this.tokenCol.findOne({ token_hash: hash });
    if (existing) {
      await this.tokenCol.updateOne(
        { _id: existing._id },
        {
          $set: {
            kind: "root",
            token_prefix: "mp_",
            name: existing.name || "Root Token",
            user_id: userId,
            capabilities: ROOT_CAPABILITIES,
            active_scope: existing.active_scope ?? null,
            project_scopes: null,
            revoked_at: null
          }
        }
      );
      return;
    }

    const doc: TokenDoc = {
      _id: randomBytes(12).toString("hex"),
      kind: "root",
      token_hash: hash,
      token_prefix: "mp_",
      name: "Root Token",
      user_id: userId,
      capabilities: ROOT_CAPABILITIES,
      active_scope: null,
      project_scopes: null,
      created_at: now,
      expires_at: null,
      encrypted_value: null
    };

    await this.tokenCol.insertOne(doc);
  }

  async issueToken(
    userId: string,
    req: CreateTokenRequest
  ): Promise<CreateTokenResponse> {
    validateCapabilities(req.kind, req.capabilities);
    const { raw, hash, prefix } = generateToken(this.hmacKey, req.kind);
    const expiresAt = resolveExpiry(req.ttl_days);

    const doc: TokenDoc = {
      _id: randomBytes(12).toString("hex"),
      kind: req.kind,
      token_hash: hash,
      token_prefix: prefix,
      name: req.name,
      user_id: userId,
      capabilities: req.capabilities,
      active_scope: null,
      project_scopes: req.project_scopes ?? null,
      created_at: new Date(),
      expires_at: expiresAt,
      encrypted_value: null
    };

    await this.tokenCol.insertOne(doc);

    return {
      token: raw,
      token_info: docToResponse(doc)
    };
  }

  async validate(raw: string): Promise<{ doc: TokenDoc } | null> {
    const hash = hashToken(raw, this.hmacKey);
    const now = new Date();
    const doc = await this.tokenCol.findOne({ token_hash: hash });

    if (!doc) return null;
    if (doc.revoked_at) return null;
    if (doc.expires_at && doc.expires_at <= now) return null;

    return { doc };
  }

  async touch(id: string): Promise<void> {
    await this.tokenCol
      .updateOne({ _id: id }, { $set: { last_used_at: new Date() } })
      .catch(() => {});
  }

  async listTokens(userId: string): Promise<TokenResponse[]> {
    const docs = await this.tokenCol
      .find({ user_id: userId })
      .sort({ created_at: -1 })
      .toArray();

    return docs.map(docToResponse);
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const result = await this.tokenCol.updateOne(
      { _id: tokenId, user_id: userId, revoked_at: null },
      { $set: { revoked_at: new Date() } }
    );

    return result.modifiedCount > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.tokenCol.updateMany(
      { user_id: userId, revoked_at: null },
      { $set: { revoked_at: new Date() } }
    );
    return result.modifiedCount;
  }
  async getActiveScope(
    userId: string,
    tokenId: string
  ): Promise<string[] | null> {
    const doc = await this.tokenCol.findOne(
      { _id: tokenId, user_id: userId, revoked_at: null },
      { projection: { active_scope: 1 } }
    );
    return doc?.active_scope ?? null;
  }

  async setActiveScope(
    userId: string,
    tokenId: string,
    scope: string[]
  ): Promise<void> {
    const result = await this.tokenCol.updateOne(
      { _id: tokenId, user_id: userId, revoked_at: null },
      { $set: { active_scope: [...new Set(scope)] } }
    );
    if (result.matchedCount !== 1) {
      throw new Error("Token not found or not owned by user");
    }
  }

}
