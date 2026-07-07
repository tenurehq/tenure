import type { Collections } from "../db/collections.js";
import type { CredentialVault } from "./encryption.js";

export type OnboardingStatus =
  | "pending"
  | "in_progress"
  | "awaiting_confirmation"
  | "completed";

export type OpenAIEndpointFlavor =
  | "generic"
  | "bedrock-access-gateway"
  | "litellm"
  | null;

export interface RuntimeConfig {
  default_provider: "openai" | "anthropic" | "bedrock" | "ollama";
  default_model: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  always_on_token_target: number;
  buffered_mode: true;
  error_retention_days: number;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  openai_endpoint_flavor: OpenAIEndpointFlavor;
  onboarding_status: OnboardingStatus;
  strict_model_tiers: boolean;
  extraction_enabled: boolean;
  injection_enabled: boolean;
  scope_auto_detect: boolean;
  ide_extraction_enabled: boolean;
  api_token: string | null;
  token_hmac_key: string | null;
}

export const DEFAULTS: RuntimeConfig = {
  default_provider: "openai",
  default_model: null,
  openai_api_key: null,
  anthropic_api_key: null,
  always_on_token_target: 400,
  buffered_mode: true,
  error_retention_days: 30,
  openai_base_url: null,
  anthropic_base_url: null,
  openai_endpoint_flavor: null,
  onboarding_status: "pending",
  strict_model_tiers: true,
  extraction_enabled: true,
  injection_enabled: true,
  scope_auto_detect: true,
  ide_extraction_enabled: true,
  api_token: null,
  token_hmac_key: null
};

const ENCRYPTED_KEYS = new Set<keyof RuntimeConfig>([
  "openai_api_key",
  "anthropic_api_key",
  "api_token",
  "token_hmac_key"
]);

export class RuntimeConfigStore {
  constructor(
    private readonly cols: Collections,
    private readonly vault: CredentialVault
  ) {}

  async load(): Promise<RuntimeConfig> {
    const docs = await this.cols.config.find({}).toArray();
    const cfg: RuntimeConfig = { ...DEFAULTS };
    for (const doc of docs) {
      const key = doc.key as keyof RuntimeConfig;
      if (!(key in DEFAULTS)) continue;
      const value =
        doc.encrypted && typeof doc.value === "string"
          ? this.vault.decrypt(doc.value)
          : doc.value;
      (cfg as unknown as Record<string, unknown>)[key] = value;
    }
    return cfg;
  }

  async set<K extends keyof RuntimeConfig>(
    key: K,
    value: RuntimeConfig[K]
  ): Promise<void> {
    const encrypted = ENCRYPTED_KEYS.has(key) && typeof value === "string";
    const stored = encrypted ? this.vault.encrypt(value as string) : value;
    await this.cols.config.updateOne(
      { key },
      { $set: { key, value: stored, encrypted, updatedAt: new Date() } },
      { upsert: true }
    );
  }
}
