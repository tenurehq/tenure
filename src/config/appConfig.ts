import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Db } from "mongodb";
import type { CredentialVault } from "./encryption.js";
import { DEFAULTS } from "./runtime.js";

export interface AppConfig {
  api_token: string;
}

export interface AppConfigBootstrap {
  onFirstRun?: (token: string, path: string) => void;
  port?: number;
  vault: CredentialVault;
}

export async function loadAppConfig(
  db: Db,
  bootstrap: AppConfigBootstrap
): Promise<AppConfig> {
  const col = db.collection<{
    key?: string;
    value?: unknown;
    encrypted?: boolean;
    api_token?: string;
  }>("config");

  const newFormat = await col.findOne({ key: "api_token" });
  if (newFormat && newFormat.encrypted && typeof newFormat.value === "string") {
    return { api_token: bootstrap.vault.decrypt(newFormat.value) };
  }

  const oldFormat = await col.findOne({ api_token: { $exists: true } } as any);
  if (oldFormat && oldFormat.api_token) {
    const plaintextToken = oldFormat.api_token;

    const encrypted = bootstrap.vault.encrypt(plaintextToken);
    await col.updateOne(
      { key: "api_token" },
      {
        $set: {
          key: "api_token",
          value: encrypted,
          encrypted: true,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await col
      .deleteOne({ api_token: { $exists: true } } as any)
      .catch(() => {});

    return { api_token: plaintextToken };
  }

  const token =
    process.env.TENURE_API_TOKEN ??
    `mp_${randomBytes(24).toString("base64url")}`;

  const encryptedToken = bootstrap.vault.encrypt(token);
  await col.updateOne(
    { key: "api_token" },
    {
      $set: {
        key: "api_token",
        value: encryptedToken,
        encrypted: true,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  const configCol = db.collection<{
    key: string;
    value: unknown;
    encrypted: boolean;
    updatedAt: Date;
  }>("config");

  await configCol.insertMany(
    Object.entries(DEFAULTS)
      .filter(
        ([key]) =>
          ![
            "openai_api_key",
            "anthropic_api_key",
            "default_model",
            "openai_base_url",
            "anthropic_base_url",
            "openai_endpoint_flavor",
            "api_token",
            "token_hmac_key",
            "scim_token"
          ].includes(key)
      )
      .map(([key, value]) => ({
        key,
        value: key === "scope_auto_detect" ? true : value,
        encrypted: false,
        updatedAt: new Date()
      }))
  );

  const tokenDir = process.env.TENURE_HOME ?? resolve(homedir(), ".tenure");
  const tokenPath = resolve(tokenDir, "token");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  bootstrap.vault.encryptToFile(token, tokenPath);
  bootstrap.onFirstRun?.(token, tokenPath);

  return { api_token: token };
}

export async function rotateApiToken(
  db: Db,
  vault: CredentialVault
): Promise<string> {
  const token = `mp_${randomBytes(24).toString("base64url")}`;
  const col = db.collection<{
    key: string;
    value: unknown;
    encrypted: boolean;
    updatedAt: Date;
  }>("config");
  const encrypted = vault.encrypt(token);
  await col.updateOne(
    { key: "api_token" },
    {
      $set: {
        key: "api_token",
        value: encrypted,
        encrypted: true,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  const tokenDir = process.env.TENURE_HOME ?? resolve(homedir(), ".tenure");
  const tokenPath = resolve(tokenDir, "token");
  vault.encryptToFile(token, tokenPath);

  return token;
}

export function writeTokenAndPrintBanner(
  token: string,
  tokenPath: string,
  port: number
): void {
  printBanner(token, tokenPath, port);
}

function printBanner(token: string, tokenPath: string, port: number): void {
  console.log("");
  console.log("━".repeat(60));
  console.log("  First-run setup complete.");
  console.log("");
  console.log(`  API token: ${token}`);
  console.log(`  Saved to:  ${tokenPath}`);
  console.log("");
  console.log("  ┌─ Point your client here ───────────────────────────┐");
  console.log(`  │  Base URL:  http://localhost:${port}/v1`);
  console.log(`  │  API Key:   ${token}`);
  console.log("  └────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  Setup UI: http://localhost:${port}/onboarding?token=${token}`);
  console.log("━".repeat(60));
  console.log("");
}
