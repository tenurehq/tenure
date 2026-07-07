import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

export const DEPLOY_MODE = process.env.TENURE_MODE ?? "single";

export interface BootstrapConfig {
  mongodb_uri: string;
  mongodb_db: string;
  port: number;
  user_id: string;
  master_key_path: string;
}

const TENURE_HOME = process.env.TENURE_HOME ?? resolve(homedir(), ".tenure");
const CONFIG_PATH = resolve(TENURE_HOME, "config.toml");

const DEFAULT: BootstrapConfig = {
  mongodb_uri:
    process.env.MONGODB_URI ?? "mongodb://mongo:27017/?directConnection=true",
  mongodb_db: process.env.TENURE_MONGODB_DB ?? "tenure",
  port: 5757,
  user_id: process.env.TENURE_USER_ID ?? "local",
  master_key_path:
    process.env.TENURE_MASTER_KEY_PATH ?? resolve(TENURE_HOME, "master.key")
};

const CONFIG_TOML = (c: BootstrapConfig) => `mongodb_uri = "${c.mongodb_uri}"
mongodb_db = "${c.mongodb_db}"
port = ${c.port}
user_id = "${c.user_id}"
master_key_path = "${c.master_key_path}"
`;

function validateConfig(raw: Record<string, unknown>): BootstrapConfig {
  const merged = { ...DEFAULT, ...raw };

  if (typeof merged.mongodb_uri !== "string")
    throw new Error("config: mongodb_uri must be a string");
  if (typeof merged.mongodb_db !== "string")
    throw new Error("config: mongodb_db must be a string");
  if (typeof merged.port !== "number")
    throw new Error("config: port must be a number");
  if (typeof merged.user_id !== "string")
    throw new Error("config: user_id must be a string");
  if (typeof merged.master_key_path !== "string")
    throw new Error("config: master_key_path must be a string");

  return merged as BootstrapConfig;
}

export function loadBootstrapConfig(path = CONFIG_PATH): BootstrapConfig {
  let config: BootstrapConfig;

  if (!existsSync(path)) {
    console.log(`No config found at ${path}, generating defaults...`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CONFIG_TOML(DEFAULT));

    config = DEFAULT;
  } else {
    const raw = parseToml(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    config = validateConfig(raw);
  }

  const envPort = process.env.TENURE_PORT ?? process.env.PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) config.port = parsed;
  }

  const envMongoUri = process.env.MONGODB_URI;
  if (envMongoUri) {
    config.mongodb_uri = envMongoUri;
  }

  const envMongoDb = process.env.TENURE_MONGODB_DB;
  if (envMongoDb) config.mongodb_db = envMongoDb;

  const envUserId = process.env.TENURE_USER_ID;
  if (envUserId) config.user_id = envUserId;

  const envMasterKeyPath = process.env.TENURE_MASTER_KEY_PATH;
  if (envMasterKeyPath) config.master_key_path = envMasterKeyPath;

  return config;
}
