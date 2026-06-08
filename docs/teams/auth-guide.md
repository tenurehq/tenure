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
2. Your ingress controller, OAuth2 Proxy, Istio, or API gateway intercepts the request and performs the corporate SSO dance.
3. Upon success, the proxy forwards the request to Tenure with an identiy header such as:

   ```
   x-user-id: alice@company.com
   ```

4. Tenure trusts this header implicitly and treats the request as authenticated for that user.

### Critical Requirement

The value your proxy sends in the identity header **must match** the `userName` attribute your identity provider sends via SCIM (see Section 5). If these identifiers diverge, offboarding will not work.

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

## 5. User Lifecycle & SCIM 2.0 Deprovisioning

The standard practice for deprovisioning is **SCIM 2.0 inbound provisioning**, not cron jobs or manual scripting.

### Behavior

When an employee is removed from your IdP, the IdP sends a SCIM `PATCH` request:

```http
PATCH /scim/v2/Users/{id}
{
  "Operations": [{
    "op": "replace",
    "value": { "active": false }
  }]
}
```

Tenure receives this event and **immediately revokes every PAT** and **terminates every session** belonging to that `userName`. The user is locked out of the dashboard and all API calls stop working within seconds.

### Connector Settings for IT

| Field          | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| SCIM Endpoint  | `https://<tenure-host>/scim/v2`                                |
| Authentication | Bearer Token (`TENURE_SCIM_TOKEN`)                             |
| User Mapping   | SCIM `userName` must equal the proxy header value (e.g. email) |

If your IdP supports group-based provisioning, note that Tenure implements SCIM User resources only; group membership must be managed within your existing identities.

## 6. Security & Storage

### Why Hashes, Not Encryption

PATs are stored as SHA-256 hashes, not encrypted ciphertext, because:

- **Verify-only:** We never need to recover the original token after issuance; we only compare the presented value.
- **Breach isolation:** A database dump reveals only irreversible hashes. Even with the application encryption keys, an attacker cannot reconstruct a working bearer token.
- **Operational simplicity:** Hash comparison avoids cipher context initialization, key rotation ceremony, and deterministic-encryption index constraints.

The existing `CredentialVault` / CSFLE system protects third-party provider API keys (OpenAI, Anthropic), which must be recoverable in plaintext. That system is intentionally **not** repurposed for PATs.

### Root Token

In teams mode, the `TENURE_API_TOKEN` loaded from Kubernetes secrets still exists, but it is a bootstrap credential. It grants full administrative access and should be rotated only via secret management pipelines, never shared with end users.

## 7. Deployment Requirements for IT

### Environment Variables

| Variable            | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `TENURE_MODE`       | Must be set to `teams`                                                                    |
| `OIDC_PROXY_HEADER` | The lowercase header name carrying the trusted user ID from your proxy (e.g. `x-user-id`) |
| `TENURE_SCIM_TOKEN` | Bearer token shared with your IdP's SCIM connector                                        |

### Reverse Proxy Checklist

- Strip any incoming `x-user-id` headers at the perimeter so end users cannot spoof identity.
- Ensure the IdP `userName` claim and the proxy header use the same identifier (typically email).
- Restrict the Tenure service endpoint to the corporate VPN or private VPC.

## 8. Conditional UI Behavior

- **Teams mode:** The dashboard displays the **Access Tokens** self-service section and hides the single-user root-token rotation card.
- **Single mode:** The dashboard shows the root-token rotation UI and hides PAT management entirely. Root token auth covers all endpoints.

## 9. Callouts for Security Reviews

| Concern             | Mitigation                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Shared secrets      | Eliminated. Every user/service account gets a unique PAT.                                 |
| Revocation          | Instant per-token revocation via dashboard; bulk revocation via SCIM on IdP deactivate.   |
| Audit               | `last_used_at` is updated on every authenticated PAT request.                             |
| IdP integration     | Zero bespoke IdP code; works with any SCIM 2.0 provider and any OIDC-aware reverse proxy. |
| Session termination | SCIM deactivation clears both PATs and web sessions.                                      |
| Horizontal access   | PATs are forbidden from admin routes by server-side enforcement.                          |
