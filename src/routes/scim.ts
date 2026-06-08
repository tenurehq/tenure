import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { Collections } from "../db/collections.js";

export interface ScimDeps {
  db: Db;
  cols: Collections;
}

interface ScimUser {
  _id: string;
  userName: string;
  active: boolean;
  externalId?: string | undefined;
  name?: { givenName?: string; familyName?: string } | undefined;
  emails?:
    | Array<{ value: string; type?: string; primary?: boolean }>
    | undefined;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
  };
}

const SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";

function nowIso(): string {
  return new Date().toISOString();
}

function scimUserResponse(doc: ScimUser) {
  return {
    schemas: [SCIM_SCHEMA_USER],
    id: doc._id,
    userName: doc.userName,
    active: doc.active,
    externalId: doc.externalId,
    name: doc.name,
    emails: doc.emails,
    meta: doc.meta
  };
}

function scimError(reply: any, status: number, detail: string) {
  return reply.code(status).send({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status,
    detail
  });
}

export function registerScimRoutes(app: FastifyInstance, deps: ScimDeps): void {
  const scimToken = process.env.TENURE_SCIM_TOKEN;
  const isTeams = process.env.TENURE_MODE === "teams";

  if (!isTeams) return;

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/scim/v2")) return;
    if (!scimToken) {
      return scimError(reply, 503, "SCIM not configured");
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${scimToken}`) {
      return scimError(reply, 401, "Unauthorized");
    }
  });

  app.get("/scim/v2/ServiceProviderConfig", async () => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Bearer token authentication",
        specUri: "",
        documentationUri: ""
      }
    ]
  }));

  app.get("/scim/v2/Schemas", async () => [
    {
      id: SCIM_SCHEMA_USER,
      name: "User",
      description: "User Account",
      attributes: [
        {
          name: "userName",
          type: "string",
          multiValued: false,
          required: true
        },
        { name: "name", type: "complex", multiValued: false, required: false },
        { name: "emails", type: "complex", multiValued: true, required: false },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false
        },
        { name: "active", type: "boolean", multiValued: false, required: false }
      ],
      meta: {
        resourceType: "Schema",
        location: "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User"
      }
    }
  ]);

  app.get("/scim/v2/ResourceTypes", async () => [
    {
      id: "User",
      name: "User",
      endpoint: "/scim/v2/Users",
      description: "User Account",
      schema: SCIM_SCHEMA_USER,
      schemaExtensions: [],
      meta: {
        resourceType: "ResourceType",
        location: "/scim/v2/ResourceTypes/User"
      }
    }
  ]);

  app.get<{
    Querystring: { filter?: string; startIndex?: string; count?: string };
  }>("/scim/v2/Users", async (req) => {
    const col = deps.db.collection<ScimUser>("scim_users");
    const filter: Record<string, unknown> = {};
    const filterStr = req.query.filter ?? "";
    const userNameMatch = filterStr.match(/userName\s+eq\s+"([^"]+)"/i);
    if (userNameMatch) filter.userName = userNameMatch[1];

    const startIndex = Math.max(1, parseInt(req.query.startIndex ?? "1", 10));
    const count = Math.min(
      100,
      Math.max(1, parseInt(req.query.count ?? "100", 10))
    );
    const skip = startIndex - 1;

    const total = await col.countDocuments(filter);
    const docs = await col.find(filter).skip(skip).limit(count).toArray();

    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: total,
      startIndex,
      itemsPerPage: docs.length,
      Resources: docs.map(scimUserResponse)
    };
  });

  app.get<{ Params: { id: string } }>(
    "/scim/v2/Users/:id",
    async (req, reply) => {
      const col = deps.db.collection<ScimUser>("scim_users");
      const doc = await col.findOne({ _id: req.params.id });
      if (!doc) return scimError(reply, 404, "User not found");
      return scimUserResponse(doc);
    }
  );

  app.post<{ Body: Partial<ScimUser> }>(
    "/scim/v2/Users",
    async (req, reply) => {
      const col = deps.db.collection<ScimUser>("scim_users");
      const body = req.body ?? {};
      if (!body.userName) return scimError(reply, 400, "userName is required");

      const existing = await col.findOne({ userName: body.userName });
      if (existing) return scimError(reply, 409, "User already exists");

      const id = randomUUID();
      const doc: ScimUser = {
        _id: id,
        userName: body.userName,
        active: body.active ?? true,
        externalId: body.externalId,
        name: body.name,
        emails: body.emails,
        meta: {
          resourceType: "User",
          created: nowIso(),
          lastModified: nowIso()
        }
      };

      await col.insertOne(doc);
      return reply.code(201).send(scimUserResponse(doc));
    }
  );

  app.put<{ Params: { id: string }; Body: Partial<ScimUser> }>(
    "/scim/v2/Users/:id",
    async (req) => {
      const col = deps.db.collection<ScimUser>("scim_users");
      const existing = await col.findOne({ _id: req.params.id });
      const body = req.body ?? {};

      const resolvedUserName =
        body.userName ?? existing?.userName ?? req.params.id;
      const active = body.active ?? true;
      const wasActive = existing?.active ?? true;

      const update: Record<string, unknown> = {
        userName: resolvedUserName,
        active,
        name: body.name ?? existing?.name,
        emails: body.emails ?? existing?.emails,
        "meta.lastModified": nowIso()
      };
      if (body.externalId !== undefined || existing?.externalId !== undefined) {
        update.externalId = body.externalId ?? existing?.externalId;
      }

      await col.updateOne(
        { _id: req.params.id },
        { $set: update },
        { upsert: true }
      );

      if (wasActive && !active) {
        await revokeUserTokens(deps, resolvedUserName);
      }

      const doc = await col.findOne({ _id: req.params.id });
      return scimUserResponse(doc!);
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      Operations?: Array<{ op: string; path?: string; value?: unknown }>;
    };
  }>("/scim/v2/Users/:id", async (req, reply) => {
    const col = deps.db.collection<ScimUser>("scim_users");
    const existing = await col.findOne({ _id: req.params.id });
    if (!existing) return scimError(reply, 404, "User not found");

    let active = existing.active;
    const ops = req.body?.Operations ?? [];

    for (const operation of ops) {
      const op = operation.op?.toLowerCase();
      if (op === "replace") {
        if (!operation.path && typeof operation.value === "boolean") {
          active = operation.value;
        } else if (
          operation.path === "active" &&
          typeof operation.value === "boolean"
        ) {
          active = operation.value;
        } else if (
          typeof operation.value === "object" &&
          operation.value !== null &&
          "active" in operation.value
        ) {
          const v = (operation.value as any).active;
          if (typeof v === "boolean") active = v;
        }
      }
    }

    if (existing.active && !active) {
      await revokeUserTokens(deps, existing.userName);
    }

    await col.updateOne(
      { _id: req.params.id },
      { $set: { active, "meta.lastModified": nowIso() } }
    );

    const updated = await col.findOne({ _id: req.params.id });
    return scimUserResponse(updated!);
  });

  app.delete<{ Params: { id: string } }>(
    "/scim/v2/Users/:id",
    async (req, reply) => {
      const col = deps.db.collection<ScimUser>("scim_users");
      const existing = await col.findOneAndDelete({ _id: req.params.id });
      if (existing?.userName) {
        await revokeUserTokens(deps, existing.userName);
      }
      return reply.code(204).send();
    }
  );
}

async function revokeUserTokens(
  deps: ScimDeps,
  userName?: string
): Promise<void> {
  if (!userName) return;
  if (deps.cols.api_tokens) {
    await deps.cols.api_tokens.updateMany(
      { user_id: userName, revoked_at: { $exists: false } },
      { $set: { revoked_at: new Date() } }
    );
  }
  await deps.db.collection("sessions").deleteMany({ user_id: userName });
}
