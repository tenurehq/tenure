# Authentication Guide

## 1. Architecture Overview

Tenure supports two authentication paths simultaneously:

| Path                      | Purpose                       | Credential Type               |
| ------------------------- | ----------------------------- | ----------------------------- |
| Browser / Admin Dashboard | Human users via corporate SSO | IdP cookie session (proxied)  |
| Programmatic Clients      | VSCode, Chat Clients, etc.    | Personal Access Tokens (PATs) |

In teams mode, **no one should use the bootstrap root token for daily work.** It exists only for emergency recovery and initial installation. Standard practice is:

- **Browser traffic** is authenticated by your existing IdP (Okta, Microsoft Entra ID, etc.) via a reverse proxy or API gateway that terminates OIDC and passes a trusted header to Tenure.
- **API clients** authenticate with revocable, per-user Personal Access Tokens generated from the settings dashboard.

## 2. Browser & Admin Access (SSO Proxy)

Tenure does not implement OIDC directly. Instead, it accepts identity assertions from a trusted reverse proxy running inside your VPC.

### How It Works

1. A user navigates to Tenure.
2. Your ingress controller, OAuth2 Proxy, Istio, or API gateway intercepts the request and performs the corporate SSO flow.
3. Upon success, the proxy forwards the request to Tenure with an identity header such as:

   ```
   x-user-id: alice@company.com
   ```

4. Tenure trusts this header implicitly and treats the request as authenticated for that user.

### Critical Requirement

The value your proxy sends in the identity header **must match** the `userName` attribute your identity provider sends via SCIM (see Section 5). If these identifiers diverge, offboarding and team resolution will not work.

## 3. Programmatic Access (Personal Access Tokens)

PATs are the only supported way for external clients to call the OpenAI-compatible API endpoints.

### Scope Enforcement

PATs are strictly scoped. A valid PAT permits access **only** to:

- `/v1/chat/completions`
- `/v1/messages`
- `/v1/models`
- WebSocket belief extraction routes

A PAT **cannot** access the admin UI, admin API routes, configuration endpoints, token rotation, or backup operations. Any attempt returns HTTP 403.

## 4. Self-Service Token Generation

After a user logs into the dashboard via SSO, they can generate PATs without filing tickets.

1. Navigate to **Settings**.
2. In the **Access Tokens** section, enter a descriptive name (e.g. "VSCode MacBook").
3. Click **Generate**.
4. Copy the token immediately. It is displayed **only once**. Tenure stores a SHA-256 hash; the plaintext is never retrievable again.
5. Paste the token into the API key field of VSCode, OpenWebUI, or any OpenAI-compatible client.

### Super Admin Controls

While users generate their own tokens, administrators can revoke tokens in two ways:

- **Direct revocation:** A super admin can call the revoke endpoint or manipulate the `api_tokens` collection directly.
- **Bulk deprovisioning:** Via SCIM (see Section 5).

## 5. User Lifecycle & SCIM 2.0 Provisioning

The standard practice for both provisioning and deprovisioning is **SCIM 2.0 inbound provisioning**, not cron jobs or manual scripting.

### Supported Resources

Tenure implements both SCIM **User** and **Group** resources. Groups are the basis for team resolution (see Section 6).

| Resource | Endpoint          | Operations                    |
| -------- | ----------------- | ----------------------------- |
| User     | `/scim/v2/Users`  | GET, POST, PUT, PATCH, DELETE |
| Group    | `/scim/v2/Groups` | GET, POST, PUT, PATCH, DELETE |

### Initial Sync (Existing Employees)

When you first connect your IdP, it performs a full directory sync to provision all assigned users and groups. Tenure's SCIM endpoints are **idempotent**: if a user or group already exists (matched by `userName`/`displayName` or `externalId`), a `POST` returns `200` with the existing record rather than `409`. The IdP interprets this as "already exists, reconcile via PUT" — meaning re-running a full sync is always safe.

**Steps for IT:**

1. Configure the SCIM connector in your IdP (see connector settings below).
2. Assign the Tenure SCIM app to the groups you want to provision.
3. Click **Start Provisioning** / **Provision on demand**. Okta and Entra ID will walk the full directory and POST every assigned user and group.
4. Verify records appear in the `scim_users` and `scim_groups` collections.
5. Set `team_resolution_strategy` to `scim_group` in Tenure's runtime config (admin dashboard).

### Deprovisioning Behavior

When an employee is removed from your IdP, the IdP sends a SCIM `PATCH`:

```http
PATCH /scim/v2/Users/{id}
{
  "Operations": [{
    "op": "replace",
    "value": { "active": false }
  }]
}
```

Tenure receives this event and **immediately revokes every PAT** and **terminates every session** belonging to that `userName`. The user is locked out of the dashboard and all API calls stop working within seconds. If the IdP sends a `DELETE` instead, the user record is removed and they are also purged from all groups.

### Connector Settings for IT

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| SCIM Endpoint      | `https://<tenure-host>/scim/v2`                                    |
| Authentication     | Bearer Token (`TENURE_SCIM_TOKEN`)                                 |
| User Mapping       | SCIM `userName` must equal the proxy header value (e.g. email)     |
| Provisioning scope | Push Users + Push Groups                                           |
| Unique identifier  | `userName` (Okta); `externalId` is also indexed for reconciliation |

## 6. Team Resolution

Tenure maps each authenticated user to a team and organization context on every request. The strategy is configured via `team_resolution_strategy` in the admin runtime config.

| Strategy     | How it works                                                                                                                                     | Best for                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `disabled`   | No team context attached. All users share a flat namespace.                                                                                      | Single-tenant or evaluation deployments                                 |
| `static`     | Every user resolves to `TENURE_DEFAULT_TEAM_ID` / `TENURE_DEFAULT_ORG_ID`.                                                                       | Simple installs with one team                                           |
| `header`     | Team and org IDs are read from proxy-injected headers (`x-team-id`, `x-org-id` by default). Falls back to `static` values if headers are absent. | Environments where the proxy can map groups to headers via token claims |
| `scim_group` | Team and org IDs are derived from the SCIM groups the user belongs to, as stored in `scim_groups`.                                               | Full enterprise IdP integration with Okta or Entra ID group push        |
| `manual`     | Admin-managed mapping in a `user_team_memberships` collection, editable from the admin UI.                                                       | Contractors or users outside the corporate IdP                          |

### Configuring `scim_group` Strategy

Each SCIM Group's `displayName` is mapped to a Tenure team. After provisioning:

1. In the admin dashboard, open **Teams** and link each SCIM group name to the corresponding internal team and org IDs.
2. Set `team_resolution_strategy` to `scim_group`.

When a user authenticates, Tenure looks up their SCIM user record by `userName`, finds which groups they belong to in `scim_groups`, and resolves the team context from the first matching group mapping. If no mapping is found, the request falls through to `static` defaults if configured.

### Configuring `header` Strategy

Your proxy must inject two headers on every authenticated request:

```
x-team-id: engineering
x-org-id: acme
```

The header names are configurable via `team_header_name` and `org_header_name` in the runtime config. This approach works well when your IdP token carries a `groups` claim and your proxy (OAuth2 Proxy, Istio, Kong) can map it to a header. It does not support multi-group membership — only a single team ID per request.

## 7. Security & Storage

### Why Hashes, Not Encryption

PATs are stored as SHA-256 hashes, not encrypted ciphertext, because:

- **Verify-only:** We never need to recover the original token after issuance; we only compare the presented value.
- **Breach isolation:** A database dump reveals only irreversible hashes. Even with the application encryption keys, an attacker cannot reconstruct a working bearer token.
- **Operational simplicity:** Hash comparison avoids cipher context initialization, key rotation ceremony, and deterministic-encryption index constraints.

The existing `CredentialVault` / CSFLE system protects third-party provider API keys (OpenAI, Anthropic), which must be recoverable in plaintext. That system is intentionally **not** repurposed for PATs.

### Root Token

In teams mode, the `TENURE_API_TOKEN` loaded from Kubernetes secrets still exists, but it is a bootstrap credential. It grants full administrative access and should be rotated only via secret management pipelines, never shared with end users.

## 8. Deployment Requirements for IT

### Environment Variables

| Variable                 | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `TENURE_MODE`            | Must be set to `teams`                                                                    |
| `OIDC_PROXY_HEADER`      | Lowercase header name carrying the trusted user ID from your proxy (e.g. `x-user-id`)     |
| `TENURE_SCIM_TOKEN`      | Bearer token shared with your IdP's SCIM connector — generate with `openssl rand -hex 32` |
| `TENURE_DEFAULT_TEAM_ID` | Fallback team ID used by `static` and `header` strategies                                 |
| `TENURE_DEFAULT_ORG_ID`  | Fallback org ID used by `static` and `header` strategies                                  |

### Required MongoDB Indexes

These are created automatically by `ensureIndexes()` on startup. Included here for reference during security review or manual provisioning:

```js
// scim_users
db.scim_users.createIndex({ userName: 1 }, { unique: true });
db.scim_users.createIndex({ externalId: 1 }, { sparse: true });

// scim_groups
db.scim_groups.createIndex({ displayName: 1 }, { unique: true });
db.scim_groups.createIndex({ externalId: 1 }, { sparse: true });
db.scim_groups.createIndex({ "members.value": 1 }); // required for scim_group strategy performance
```

### Reverse Proxy Checklist

- Strip any inbound identity header (e.g. `x-user-id`) at the perimeter so end users cannot spoof identity.
- Ensure the IdP `userName` claim and the proxy header use the **same identifier** — if Okta uses `alice@company.com` in SCIM but your proxy injects `alice`, deprovisioning and team resolution silently break.
- If using the `header` team strategy, ensure the proxy injects `x-team-id` and `x-org-id` (or your configured header names) on every authenticated request.
- Restrict the Tenure service endpoint to the corporate VPN or private VPC. The SCIM endpoint does not need to be publicly routable — most IdPs support SCIM push to internal URLs via an agent or network tunnel.

## 9. Conditional UI Behavior

- **Teams mode:** The dashboard displays the **Access Tokens** self-service section and hides the single-user root-token rotation card.
- **Single mode:** The dashboard shows the root-token rotation UI and hides PAT management entirely. Root token auth covers all endpoints.

## 10. Callouts for Security Reviews

| Concern             | Mitigation                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Shared secrets      | Eliminated. Every user/service account gets a unique PAT.                                 |
| Revocation          | Instant per-token revocation via dashboard; bulk revocation via SCIM on IdP deactivate.   |
| Audit               | `last_used_at` is updated on every authenticated PAT request.                             |
| IdP integration     | Zero bespoke IdP code; works with any SCIM 2.0 provider and any OIDC-aware reverse proxy. |
| Session termination | SCIM deactivation clears both PATs and web sessions.                                      |
| Horizontal access   | PATs are forbidden from admin routes by server-side enforcement.                          |
| Group drift         | SCIM group push keeps `scim_groups` in sync with the IdP in real time; no polling needed. |
| Re-sync safety      | Idempotent SCIM POST endpoints mean full directory re-syncs are always safe to trigger.   |
