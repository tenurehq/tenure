import { loadBootstrapConfig } from "./config/bootstrap.js";
import { buildApp } from "./app.js";
import { CredentialVault } from "./config/encryption.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";

const subcommand = process.argv[2];

if (subcommand === "token") {
  const config = loadBootstrapConfig();
  const vault = new CredentialVault(config.master_key_path);

  const tokenDir = process.env.TENURE_HOME ?? resolve(homedir(), ".tenure");
  const tokenPath = resolve(tokenDir, "token");

  if (existsSync(tokenPath)) {
    try {
      const token = vault.decryptFromFile(tokenPath);
      console.log(token);
      process.exit(0);
    } catch {}
  }

  const client = new MongoClient(config.mongodb_uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.mongodb_db)
      .collection<{ key: string; value: unknown; encrypted: boolean }>("config")
      .findOne({ key: "api_token" });
    if (!doc) {
      console.error("No token found. Has Tenure been started at least once?");
      process.exit(1);
    }
    const token = doc.encrypted
      ? vault.decrypt(doc.value as string)
      : (doc.value as string);
    console.log(token);
  } finally {
    await client.close();
  }
  process.exit(0);
}

try {
  const config = loadBootstrapConfig();
  const { server, close } = await buildApp(config);
  await server.listen({ port: config.port, host: "0.0.0.0" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await close();
      process.exit(0);
    });
  }
} catch (err) {
  console.error("Failed to start server:", err);
  process.exit(1);
}
