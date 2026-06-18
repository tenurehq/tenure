import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { Collections } from "../db/collections.js";

export interface ScimDeps {
  db: Db;
  cols: Collections;
  getToken: () => Promise<string | undefined>;
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

interface ScimGroupMember {
  value: string;
  display?: string;
}

interface ScimGroup {
  _id: string;
  displayName: string;
  externalId?: string | undefined;
  members: ScimGroupMember[];
  meta: {
    resourceType: "Group";
    created: string;
    lastModified: string;
  };
}

const SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

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

function scimGroupResponse(doc: ScimGroup) {
  return {
    schemas: [SCIM_SCHEMA_GROUP],
    id: doc._id,
    displayName: doc.displayName,
    externalId: doc.externalId,
    members: doc.members,
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

/**
 * Returns the list of SCIM group _ids that contain the given scim_users._id.
 * Returns an empty array if none found or the collection doesn't exist yet.
 */
export async function getGroupsForUser(
  db: Db,
  scimUserId: string
): Promise<string[]> {
  const col = db.collection<ScimGroup>("scim_groups");
  const groups = await col
    .find({ "members.value": scimUserId }, { projection: { _id: 1 } })
    .toArray();
  return groups.map((g) => g._id);
}

/**
 * Returns the scim_users._id for a given userName, or null if not found.
 * Useful for callers that only have the proxy header value (userName / email).
 */
export async function getScimUserIdByUserName(
  db: Db,
  userName: string
): Promise<string | null> {
  const col = db.collection<ScimUser>("scim_users");
  const doc = await col.findOne({ userName }, { projection: { _id: 1 } });
  return doc?._id ?? null;
}

export function registerScimRoutes(app: FastifyInstance, deps: ScimDeps): void {
  const isTeams = process.env.TENURE_MODE === "teams";

  if (!isTeams) return;

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/scim/v2")) return;
    const scimToken = await deps.getToken();
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
        location: `/scim/v2/Schemas/${SCIM_SCHEMA_USER}`
      }
    },
    {
      id: SCIM_SCHEMA_GROUP,
      name: "Group",
      description: "Group",
      attributes: [
        {
          name: "displayName",
          type: "string",
          multiValued: false,
          required: true
        },
        { name: "members", type: "complex", multiValued: true, required: false }
      ],
      meta: {
        resourceType: "Schema",
        location: `/scim/v2/Schemas/${SCIM_SCHEMA_GROUP}`
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
    },
    {
      id: "Group",
      name: "Group",
      endpoint: "/scim/v2/Groups",
      description: "Group",
      schema: SCIM_SCHEMA_GROUP,
      schemaExtensions: [],
      meta: {
        resourceType: "ResourceType",
        location: "/scim/v2/ResourceTypes/Group"
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

    const externalIdMatch = filterStr.match(/externalId\s+eq\s+"([^"]+)"/i);
    if (externalIdMatch) filter.externalId = externalIdMatch[1];

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

  app.post<{ Body: Partial<ScimUser> & { externalId?: string } }>(
    "/scim/v2/Users",
    async (req, reply) => {
      const col = deps.db.collection<ScimUser>("scim_users");
      const body = req.body ?? {};
      if (!body.userName) return scimError(reply, 400, "userName is required");

      // Idempotent: if the user already exists (matched by userName or
      // externalId), return the existing record with 200 rather than 409.
      // This is what Okta expects during initial sync / re-sync — it will
      // then issue a PUT to reconcile any field differences.
      const existing = await col.findOne(
        body.externalId
          ? {
              $or: [
                { userName: body.userName },
                { externalId: body.externalId }
              ]
            }
          : { userName: body.userName }
      );
      if (existing) return reply.code(200).send(scimUserResponse(existing));

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
      await deps.db
        .collection<ScimGroup>("scim_groups")
        .updateMany(
          { "members.value": req.params.id },
          { $pull: { members: { value: req.params.id } } as any }
        );
      return reply.code(204).send();
    }
  );

  app.get<{
    Querystring: { filter?: string; startIndex?: string; count?: string };
  }>("/scim/v2/Groups", async (req) => {
    const col = deps.db.collection<ScimGroup>("scim_groups");
    const filter: Record<string, unknown> = {};
    const filterStr = req.query.filter ?? "";

    const displayNameMatch = filterStr.match(/displayName\s+eq\s+"([^"]+)"/i);
    if (displayNameMatch) filter.displayName = displayNameMatch[1];

    const externalIdMatch = filterStr.match(/externalId\s+eq\s+"([^"]+)"/i);
    if (externalIdMatch) filter.externalId = externalIdMatch[1];

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
      Resources: docs.map(scimGroupResponse)
    };
  });

  app.get<{ Params: { id: string } }>(
    "/scim/v2/Groups/:id",
    async (req, reply) => {
      const col = deps.db.collection<ScimGroup>("scim_groups");
      const doc = await col.findOne({ _id: req.params.id });
      if (!doc) return scimError(reply, 404, "Group not found");
      return scimGroupResponse(doc);
    }
  );

  app.post<{
    Body: {
      displayName?: string;
      externalId?: string;
      members?: ScimGroupMember[];
    };
  }>("/scim/v2/Groups", async (req, reply) => {
    const col = deps.db.collection<ScimGroup>("scim_groups");
    const body = req.body ?? {};
    if (!body.displayName)
      return scimError(reply, 400, "displayName is required");

    const existing = await col.findOne(
      body.externalId
        ? {
            $or: [
              { displayName: body.displayName },
              { externalId: body.externalId }
            ]
          }
        : { displayName: body.displayName }
    );
    if (existing) return reply.code(200).send(scimGroupResponse(existing));

    const id = randomUUID();
    const doc: ScimGroup = {
      _id: id,
      displayName: body.displayName,
      externalId: body.externalId,
      members: body.members ?? [],
      meta: {
        resourceType: "Group",
        created: nowIso(),
        lastModified: nowIso()
      }
    };

    await col.insertOne(doc);
    return reply.code(201).send(scimGroupResponse(doc));
  });

  app.put<{
    Params: { id: string };
    Body: {
      displayName?: string;
      externalId?: string;
      members?: ScimGroupMember[];
    };
  }>("/scim/v2/Groups/:id", async (req, reply) => {
    const col = deps.db.collection<ScimGroup>("scim_groups");
    const existing = await col.findOne({ _id: req.params.id });
    if (!existing) return scimError(reply, 404, "Group not found");

    const body = req.body ?? {};
    const update: Partial<ScimGroup> & Record<string, unknown> = {
      displayName: body.displayName ?? existing.displayName,
      members: body.members ?? existing.members,
      "meta.lastModified": nowIso()
    };
    if (body.externalId !== undefined || existing.externalId !== undefined) {
      update.externalId = body.externalId ?? existing.externalId;
    }

    await col.updateOne({ _id: req.params.id }, { $set: update });
    const doc = await col.findOne({ _id: req.params.id });
    return scimGroupResponse(doc!);
  });

  app.patch<{
    Params: { id: string };
    Body: {
      Operations?: Array<{ op: string; path?: string; value?: unknown }>;
    };
  }>("/scim/v2/Groups/:id", async (req, reply) => {
    const col = deps.db.collection<ScimGroup>("scim_groups");
    const existing = await col.findOne({ _id: req.params.id });
    if (!existing) return scimError(reply, 404, "Group not found");

    let members = [...existing.members];
    const ops = req.body?.Operations ?? [];

    for (const operation of ops) {
      const op = operation.op?.toLowerCase();

      if (op === "add" && operation.path === "members") {
        // value is an array of { value, display } member objects
        const toAdd = normalizeMemberList(operation.value);
        for (const m of toAdd) {
          if (!members.some((x) => x.value === m.value)) {
            members.push(m);
          }
        }
      } else if (op === "remove" && operation.path === "members") {
        if (operation.value == null) {
          members = [];
        } else {
          const toRemove = normalizeMemberList(operation.value).map(
            (m) => m.value
          );
          members = members.filter((m) => !toRemove.includes(m.value));
        }
      } else if (op === "remove" && operation.path?.startsWith("members[")) {
        const idMatch = operation.path.match(
          /members\[value\s+eq\s+"([^"]+)"\]/i
        );
        if (idMatch) {
          members = members.filter((m) => m.value !== idMatch[1]);
        }
      } else if (op === "replace" && !operation.path) {
        const val = operation.value as any;
        if (val?.members) members = normalizeMemberList(val.members);
      } else if (op === "replace" && operation.path === "members") {
        members = normalizeMemberList(operation.value);
      }
    }

    await col.updateOne(
      { _id: req.params.id },
      { $set: { members, "meta.lastModified": nowIso() } }
    );

    const updated = await col.findOne({ _id: req.params.id });
    return scimGroupResponse(updated!);
  });

  app.delete<{ Params: { id: string } }>(
    "/scim/v2/Groups/:id",
    async (req, reply) => {
      const col = deps.db.collection<ScimGroup>("scim_groups");
      const result = await col.deleteOne({ _id: req.params.id });
      if (result.deletedCount === 0)
        return scimError(reply, 404, "Group not found");
      return reply.code(204).send();
    }
  );
}

function normalizeMemberList(value: unknown): ScimGroupMember[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter((v) => v && typeof v === "object" && "value" in v)
      .map((v: any) => ({ value: String(v.value), display: v.display }));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "value" in (value as any)
  ) {
    const v = value as any;
    return [{ value: String(v.value), display: v.display }];
  }
  return [];
}

async function revokeUserTokens(
  deps: ScimDeps,
  userName?: string
): Promise<void> {
  if (!userName) return;
  if (deps.cols.api_tokens) {
    await deps.cols.api_tokens.updateMany(
      { user_id: userName, revoked_at: null },
      { $set: { revoked_at: new Date() } }
    );
  }
  await deps.db.collection("sessions").deleteMany({ user_id: userName });
}
