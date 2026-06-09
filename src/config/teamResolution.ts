export type TeamResolutionStrategy =
  | "disabled" // individual mode, no team features
  | "static" // everyone maps to the same team/org (env vars)
  | "header" // proxy sends x-team-id / x-org-id headers
  | "manual" // admin maps users in UI (future)
  | "scim_group"; // future: SCIM Group inbound

export interface TeamRuntimeConfig {
  team_resolution_strategy: TeamResolutionStrategy;
  default_team_id?: string;
  default_org_id?: string;
  team_header_name?: string;
  org_header_name?: string;
}
