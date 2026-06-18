import test from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db, type Collection } from "mongodb";
import { getCollections } from "../db/collections.js";
import type { Collections } from "../db/collections.js";
import {
  registerScimRoutes,
  getGroupsForUser,
  getScimUserIdByUserName,
  type ScimDeps
} from "./scim.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test-scim");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await db.collection("scim_users").deleteMany({});
  await db.collection("scim_groups").deleteMany({});
  await db.collection("api_tokens").deleteMany({});
  await db.collection("sessions").deleteMany({});
});

function getDeps(): ScimDeps {
  return {
    db,
    cols: getCollections(db),
    getToken: async () => process.env.TENURE_SCIM_TOKEN
  };
}

function withEnv(mode?: string, token?: string) {
  const prevMode = process.env.TENURE_MODE;
  const prevToken = process.env.TENURE_SCIM_TOKEN;

  if (mode !== undefined) process.env.TENURE_MODE = mode;
  else delete process.env.TENURE_MODE;

  if (token !== undefined) process.env.TENURE_SCIM_TOKEN = token;
  else delete process.env.TENURE_SCIM_TOKEN;

  return () => {
    if (prevMode === undefined) delete process.env.TENURE_MODE;
    else process.env.TENURE_MODE = prevMode;

    if (prevToken === undefined) delete process.env.TENURE_SCIM_TOKEN;
    else process.env.TENURE_SCIM_TOKEN = prevToken;
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function buildApp(): Promise<{ app: FastifyInstance; deps: ScimDeps }> {
  const app = Fastify({ logger: false });
  const deps = getDeps();
  registerScimRoutes(app, deps);
  return { app, deps };
}

async function seedUsers(col: Collection<any>, count: number) {
  const docs = Array.from({ length: count }).map((_, i) => ({
    _id: crypto.randomUUID(),
    userName: `user-${i}`,
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  }));
  await col.insertMany(docs);
  return docs;
}

test.serial(
  "getGroupsForUser returns empty array when no groups exist",
  async (t) => {
    const groups = await getGroupsForUser(db, "nonexistent-user-id");
    t.deepEqual(groups, []);
  }
);

test.serial(
  "getGroupsForUser returns group ids that contain the user",
  async (t) => {
    const g1 = crypto.randomUUID();
    const g2 = crypto.randomUUID();
    const uid = "user-abc";

    await db.collection("scim_groups").insertMany([
      {
        _id: g1,
        displayName: "A",
        members: [{ value: uid }],
        meta: {
          resourceType: "Group",
          created: new Date().toISOString(),
          lastModified: new Date().toISOString()
        }
      },
      {
        _id: g2 as any,
        displayName: "B",
        members: [{ value: "other" }],
        meta: {
          resourceType: "Group",
          created: new Date().toISOString(),
          lastModified: new Date().toISOString()
        }
      }
    ]);

    const groups = await getGroupsForUser(db, uid);
    t.deepEqual(groups, [g1]);
  }
);

test.serial("getScimUserIdByUserName returns null when missing", async (t) => {
  const id = await getScimUserIdByUserName(db, "nobody@example.com");
  t.is(id, null);
});

test.serial("getScimUserIdByUserName returns _id when found", async (t) => {
  const uid = crypto.randomUUID();
  await db.collection("scim_users").insertOne({
    _id: uid as any,
    userName: "alice@example.com",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const id = await getScimUserIdByUserName(db, "alice@example.com");
  t.is(id, uid);
});

test.serial(
  "registerScimRoutes registers no routes when not in teams mode",
  async (t) => {
    const restore = withEnv("solo", "token");
    const { app } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/ServiceProviderConfig",
      headers: auth("token")
    });
    t.is(res.statusCode, 404);

    restore();
  }
);

test.serial(
  "SCIM endpoint returns 503 when TENURE_SCIM_TOKEN is unset",
  async (t) => {
    const restore = withEnv("teams", undefined);
    const { app } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/ServiceProviderConfig",
      headers: auth("whatever")
    });
    t.is(res.statusCode, 503);
    t.true(res.payload.includes("SCIM not configured"));

    restore();
  }
);

test.serial("SCIM endpoint returns 401 for invalid bearer token", async (t) => {
  const restore = withEnv("teams", "correct-token");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/ServiceProviderConfig",
    headers: auth("wrong-token")
  });
  t.is(res.statusCode, 401);

  restore();
});

test.serial("SCIM endpoint succeeds with correct bearer token", async (t) => {
  const restore = withEnv("teams", "correct-token");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/ServiceProviderConfig",
    headers: auth("correct-token")
  });
  t.is(res.statusCode, 200);

  restore();
});

test.serial(
  "GET /scim/v2/ServiceProviderConfig returns expected shape",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/ServiceProviderConfig",
      headers: auth("tok")
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.deepEqual(body.schemas, [
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
    ]);
    t.is(body.authenticationSchemes[0].type, "oauthbearertoken");

    restore();
  }
);

test.serial(
  "GET /scim/v2/Schemas returns User and Group schemas",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/Schemas",
      headers: auth("tok")
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.length, 2);
    t.true(body.some((s: any) => s.name === "User"));
    t.true(body.some((s: any) => s.name === "Group"));

    restore();
  }
);

test.serial("GET /scim/v2/ResourceTypes returns User and Group", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/ResourceTypes",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.length, 2);
  t.true(body.some((r: any) => r.id === "User"));

  restore();
});

test.serial("GET /scim/v2/Users returns empty list", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.totalResults, 0);
  t.deepEqual(body.Resources, []);

  restore();
});

test.serial("GET /scim/v2/Users filters by userName", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  await db.collection("scim_users").insertMany([
    {
      _id: crypto.randomUUID() as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    },
    {
      _id: crypto.randomUUID(),
      userName: "bob",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    }
  ]);

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users?filter=userName%20eq%20%22alice%22",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.totalResults, 1);
  t.is(body.Resources[0].userName, "alice");

  restore();
});

test.serial("GET /scim/v2/Users filters by externalId", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  await db.collection("scim_users").insertOne({
    _id: crypto.randomUUID() as any,
    userName: "alice",
    externalId: "ext-1",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users?filter=externalId%20eq%20%22ext-1%22",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.totalResults, 1);

  restore();
});

test.serial(
  "GET /scim/v2/Users pagination obeys startIndex and count",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const col = db.collection("scim_users");
    await seedUsers(col, 5);

    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/Users?startIndex=2&count=2",
      headers: auth("tok")
    });
    const body = JSON.parse(res.payload);

    t.is(body.totalResults, 5);
    t.is(body.startIndex, 2);
    t.is(body.itemsPerPage, 2);

    restore();
  }
);

test.serial("GET /scim/v2/Users count clamped to max 100", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const col = db.collection("scim_users");
  await seedUsers(col, 105);

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users?count=200",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.itemsPerPage, 100);

  restore();
});

test.serial("GET /scim/v2/Users startIndex clamped to minimum 1", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const col = db.collection("scim_users");
  await seedUsers(col, 3);

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users?startIndex=0&count=10",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.startIndex, 1);
  t.is(body.itemsPerPage, 3);

  restore();
});

test.serial("GET /scim/v2/Users/:id returns 404 when missing", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: `/scim/v2/Users/${crypto.randomUUID()}`,
    headers: auth("tok")
  });
  t.is(res.statusCode, 404);

  restore();
});

test.serial("GET /scim/v2/Users/:id returns existing user", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_users").insertOne({
    _id: id as any,
    userName: "alice",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "GET",
    url: `/scim/v2/Users/${id}`,
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.id, id);

  restore();
});

test.serial("POST /scim/v2/Users creates user and returns 201", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/scim/v2/Users",
    headers: auth("tok"),
    payload: { userName: "alice", active: true }
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 201);
  t.is(body.userName, "alice");
  t.truthy(body.id);

  const doc = await db.collection("scim_users").findOne({ userName: "alice" });
  t.truthy(doc);

  restore();
});

test.serial(
  "POST /scim/v2/Users is idempotent by userName returning 200",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: auth("tok"),
      payload: { userName: "alice", active: false }
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.id, id);

    restore();
  }
);

test.serial(
  "POST /scim/v2/Users is idempotent by externalId returning 200",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      externalId: "okta-123",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: auth("tok"),
      payload: { userName: "bob", externalId: "okta-123" }
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.id, id);

    restore();
  }
);

test.serial("POST /scim/v2/Users rejects missing userName", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/scim/v2/Users",
    headers: auth("tok"),
    payload: { active: true }
  });

  t.is(res.statusCode, 400);

  restore();
});

test.serial("PUT /scim/v2/Users/:id updates existing user", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_users").insertOne({
    _id: id as any,
    userName: "alice",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "PUT",
    url: `/scim/v2/Users/${id}`,
    headers: auth("tok"),
    payload: { userName: "alice2", active: true }
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.userName, "alice2");

  restore();
});

test.serial("PUT /scim/v2/Users/:id upserts when user not found", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  const res = await app.inject({
    method: "PUT",
    url: `/scim/v2/Users/${id}`,
    headers: auth("tok"),
    payload: { userName: "ghost", active: true }
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.id, id);
  t.is(body.userName, "ghost");

  const doc = await db.collection("scim_users").findOne({ _id: id as any });
  t.truthy(doc);

  restore();
});

test.serial(
  "PUT /scim/v2/Users/:id revokes tokens on deactivation",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app, deps } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    await deps.cols.api_tokens.insertOne({
      _id: crypto.randomUUID(),
      token_hash: "hash1",
      name: "tk",
      user_id: "alice",
      created_at: new Date(),
      revoked_at: null
    });
    await deps.cols.sessions.insertOne({
      userId: "alice",
      createdAt: new Date()
    } as any);

    const res = await app.inject({
      method: "PUT",
      url: `/scim/v2/Users/${id}`,
      headers: auth("tok"),
      payload: { userName: "alice", active: false }
    });
    t.is(res.statusCode, 200);

    const tok = await deps.cols.api_tokens.findOne({ user_id: "alice" });
    t.not(tok?.revoked_at, null);

    const sess = await deps.db
      .collection("sessions")
      .countDocuments({ user_id: "alice" });
    t.is(sess, 0);

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Users/:id updates active via boolean value with no path",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Users/${id}`,
      headers: auth("tok"),
      payload: { Operations: [{ op: "replace", value: false }] }
    });
    const body = JSON.parse(res.payload);

    t.is(body.active, false);

    restore();
  }
);

test.serial("PATCH /scim/v2/Users/:id updates active via path", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_users").insertOne({
    _id: id as any,
    userName: "alice",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Users/${id}`,
    headers: auth("tok"),
    payload: { Operations: [{ op: "replace", path: "active", value: false }] }
  });
  const body = JSON.parse(res.payload);

  t.is(body.active, false);

  restore();
});

test.serial(
  "PATCH /scim/v2/Users/:id updates active via object value",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Users/${id}`,
      headers: auth("tok"),
      payload: { Operations: [{ op: "replace", value: { active: false } }] }
    });
    const body = JSON.parse(res.payload);

    t.is(body.active, false);

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Users/:id revokes tokens on deactivation",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app, deps } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: id as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    await deps.cols.api_tokens.insertOne({
      _id: crypto.randomUUID(),
      token_hash: "hash",
      name: "tk",
      user_id: "alice",
      created_at: new Date(),
      revoked_at: null
    });
    await deps.db.collection("sessions").insertOne({ user_id: "alice" } as any);

    await app.inject({
      method: "PATCH",
      url: `/scim/v2/Users/${id}`,
      headers: auth("tok"),
      payload: { Operations: [{ op: "replace", path: "active", value: false }] }
    });

    const tok = await deps.cols.api_tokens.findOne({ user_id: "alice" });
    t.not(tok?.revoked_at, null);
    t.is(
      await deps.db.collection("sessions").countDocuments({ user_id: "alice" }),
      0
    );

    restore();
  }
);

test.serial("PATCH /scim/v2/Users/:id returns 404 when missing", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Users/${crypto.randomUUID()}`,
    headers: auth("tok"),
    payload: { Operations: [{ op: "replace", path: "active", value: false }] }
  });

  t.is(res.statusCode, 404);

  restore();
});

test.serial(
  "DELETE /scim/v2/Users/:id removes user and group memberships",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const uid = crypto.randomUUID();
    await db.collection("scim_users").insertOne({
      _id: uid as any,
      userName: "alice",
      active: true,
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    await db.collection("scim_groups").insertMany([
      {
        _id: crypto.randomUUID() as any,
        displayName: "G1",
        members: [{ value: uid }, { value: "other" }],
        meta: {
          resourceType: "Group",
          created: new Date().toISOString(),
          lastModified: new Date().toISOString()
        }
      },
      {
        _id: crypto.randomUUID(),
        displayName: "G2",
        members: [{ value: uid }],
        meta: {
          resourceType: "Group",
          created: new Date().toISOString(),
          lastModified: new Date().toISOString()
        }
      }
    ]);

    const res = await app.inject({
      method: "DELETE",
      url: `/scim/v2/Users/${uid}`,
      headers: auth("tok")
    });
    t.is(res.statusCode, 204);

    const user = await db.collection("scim_users").findOne({ _id: uid as any });
    t.is(user, null);

    const g1 = await db
      .collection("scim_groups")
      .findOne({ displayName: "G1" });
    t.is(g1!.members.length, 1);
    t.is(g1!.members[0].value, "other");

    const g2 = await db
      .collection("scim_groups")
      .findOne({ displayName: "G2" });
    t.is(g2!.members.length, 0);

    restore();
  }
);

test.serial("DELETE /scim/v2/Users/:id revokes tokens", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app, deps } = await buildApp();

  const uid = crypto.randomUUID();
  await db.collection("scim_users").insertOne({
    _id: uid as any,
    userName: "alice",
    active: true,
    meta: {
      resourceType: "User",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  await deps.cols.api_tokens.insertOne({
    _id: crypto.randomUUID(),
    token_hash: "h",
    name: "tk",
    user_id: "alice",
    created_at: new Date(),
    revoked_at: null
  });
  await deps.db.collection("sessions").insertOne({ user_id: "alice" } as any);

  await app.inject({
    method: "DELETE",
    url: `/scim/v2/Users/${uid}`,
    headers: auth("tok")
  });

  const tok = await deps.cols.api_tokens.findOne({ user_id: "alice" });
  t.not(tok?.revoked_at, null);
  t.is(
    await deps.db.collection("sessions").countDocuments({ user_id: "alice" }),
    0
  );

  restore();
});

test.serial(
  "DELETE /scim/v2/Users/:id returns 204 even if user missing",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/scim/v2/Users/${crypto.randomUUID()}`,
      headers: auth("tok")
    });
    t.is(res.statusCode, 204);

    restore();
  }
);

test.serial("GET /scim/v2/Groups returns empty list", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Groups",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.totalResults, 0);

  restore();
});

test.serial("GET /scim/v2/Groups filters by displayName", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  await db.collection("scim_groups").insertMany([
    {
      _id: crypto.randomUUID() as any,
      displayName: "admins",
      members: [],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    },
    {
      _id: crypto.randomUUID() as any,
      displayName: "users",
      members: [],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    }
  ]);

  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Groups?filter=displayName%20eq%20%22admins%22",
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(body.totalResults, 1);
  t.is(body.Resources[0].displayName, "admins");

  restore();
});

test.serial("GET /scim/v2/Groups/:id returns 404 when missing", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "GET",
    url: `/scim/v2/Groups/${crypto.randomUUID()}`,
    headers: auth("tok")
  });
  t.is(res.statusCode, 404);

  restore();
});

test.serial("GET /scim/v2/Groups/:id returns existing group", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_groups").insertOne({
    _id: id as any,
    displayName: "admins",
    members: [],
    meta: {
      resourceType: "Group",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "GET",
    url: `/scim/v2/Groups/${id}`,
    headers: auth("tok")
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.id, id);

  restore();
});

test.serial("POST /scim/v2/Groups creates group and returns 201", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/scim/v2/Groups",
    headers: auth("tok"),
    payload: {
      displayName: "admins",
      members: [{ value: "u1", display: "Alice" }]
    }
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 201);
  t.is(body.displayName, "admins");
  t.is(body.members.length, 1);

  restore();
});

test.serial(
  "POST /scim/v2/Groups is idempotent by displayName returning 200",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: auth("tok"),
      payload: { displayName: "admins", members: [{ value: "u1" }] }
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.id, id);

    restore();
  }
);

test.serial("POST /scim/v2/Groups rejects missing displayName", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "POST",
    url: "/scim/v2/Groups",
    headers: auth("tok"),
    payload: { members: [] }
  });

  t.is(res.statusCode, 400);

  restore();
});

test.serial("PUT /scim/v2/Groups/:id updates existing group", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_groups").insertOne({
    _id: id as any,
    displayName: "admins",
    members: [],
    meta: {
      resourceType: "Group",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "PUT",
    url: `/scim/v2/Groups/${id}`,
    headers: auth("tok"),
    payload: { displayName: "super-admins", members: [{ value: "u1" }] }
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.displayName, "super-admins");
  t.is(body.members.length, 1);

  restore();
});

test.serial("PUT /scim/v2/Groups/:id returns 404 when missing", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const res = await app.inject({
    method: "PUT",
    url: `/scim/v2/Groups/${crypto.randomUUID()}`,
    headers: auth("tok"),
    payload: { displayName: "admins" }
  });

  t.is(res.statusCode, 404);

  restore();
});

test.serial("PATCH /scim/v2/Groups/:id adds members", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_groups").insertOne({
    _id: id as any,
    displayName: "admins",
    members: [{ value: "u1" }],
    meta: {
      resourceType: "Group",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Groups/${id}`,
    headers: auth("tok"),
    payload: {
      Operations: [
        { op: "add", path: "members", value: [{ value: "u2", display: "Bob" }] }
      ]
    }
  });
  const body = JSON.parse(res.payload);

  t.is(body.members.length, 2);
  t.true(body.members.some((m: any) => m.value === "u2"));

  restore();
});

test.serial("PATCH /scim/v2/Groups/:id removes members by list", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_groups").insertOne({
    _id: id as any,
    displayName: "admins",
    members: [{ value: "u1" }, { value: "u2" }, { value: "u3" }],
    meta: {
      resourceType: "Group",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Groups/${id}`,
    headers: auth("tok"),
    payload: {
      Operations: [
        {
          op: "remove",
          path: "members",
          value: [{ value: "u1" }, { value: "u2" }]
        }
      ]
    }
  });
  const body = JSON.parse(res.payload);

  t.is(body.members.length, 1);
  t.is(body.members[0].value, "u3");

  restore();
});

test.serial(
  "PATCH /scim/v2/Groups/:id removes all members when value is null",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [{ value: "u1" }, { value: "u2" }],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Groups/${id}`,
      headers: auth("tok"),
      payload: {
        Operations: [{ op: "remove", path: "members" }]
      }
    });
    const body = JSON.parse(res.payload);

    t.deepEqual(body.members, []);

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Groups/:id removes member by path filter",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [{ value: "u1" }, { value: "u2" }],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Groups/${id}`,
      headers: auth("tok"),
      payload: {
        Operations: [{ op: "remove", path: 'members[value eq "u1"]' }]
      }
    });
    const body = JSON.parse(res.payload);

    t.is(body.members.length, 1);
    t.is(body.members[0].value, "u2");

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Groups/:id replaces members with no path",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [{ value: "u1" }],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Groups/${id}`,
      headers: auth("tok"),
      payload: {
        Operations: [{ op: "replace", value: { members: [{ value: "u9" }] } }]
      }
    });
    const body = JSON.parse(res.payload);

    t.is(body.members.length, 1);
    t.is(body.members[0].value, "u9");

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Groups/:id replaces members with path=members",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [{ value: "u1" }],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Groups/${id}`,
      headers: auth("tok"),
      payload: {
        Operations: [
          { op: "replace", path: "members", value: [{ value: "u9" }] }
        ]
      }
    });
    const body = JSON.parse(res.payload);

    t.is(body.members.length, 1);
    t.is(body.members[0].value, "u9");

    restore();
  }
);

test.serial(
  "PATCH /scim/v2/Groups/:id ignores duplicates on add",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const id = crypto.randomUUID();
    await db.collection("scim_groups").insertOne({
      _id: id as any,
      displayName: "admins",
      members: [{ value: "u1" }],
      meta: {
        resourceType: "Group",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Groups/${id}`,
      headers: auth("tok"),
      payload: {
        Operations: [
          {
            op: "add",
            path: "members",
            value: [{ value: "u1" }, { value: "u2" }]
          }
        ]
      }
    });
    const body = JSON.parse(res.payload);

    t.is(body.members.length, 2);

    restore();
  }
);

test.serial("DELETE /scim/v2/Groups/:id deletes group", async (t) => {
  const restore = withEnv("teams", "tok");
  const { app } = await buildApp();

  const id = crypto.randomUUID();
  await db.collection("scim_groups").insertOne({
    _id: id as any,
    displayName: "admins",
    members: [],
    meta: {
      resourceType: "Group",
      created: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }
  });

  const res = await app.inject({
    method: "DELETE",
    url: `/scim/v2/Groups/${id}`,
    headers: auth("tok")
  });
  t.is(res.statusCode, 204);

  const doc = await db.collection("scim_groups").findOne({ _id: id as any });
  t.is(doc, null);

  restore();
});

test.serial(
  "DELETE /scim/v2/Groups/:id returns 404 when missing",
  async (t) => {
    const restore = withEnv("teams", "tok");
    const { app } = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/scim/v2/Groups/${crypto.randomUUID()}`,
      headers: auth("tok")
    });
    t.is(res.statusCode, 404);

    restore();
  }
);
