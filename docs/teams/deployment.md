# Deployment Guide

## Overview

The Tenure Helm chart deploys the application in one of two top-level modes:

- **Bundled**: A self-contained MongoDB instance runs as a StatefulSet alongside Tenure. This is ideal for development, proofs of concept, or small teams that want to evaluate the platform quickly.
- **External**: Tenure connects to an existing MongoDB (such as MongoDB Atlas, Amazon DocumentDB, or a self-managed replica set). This is recommended for production or any shared instance where durability, backups, and scaling are managed independently.

Everything else — secrets, observability, ingress, and identity — is configured as a flat capability, not as a tier.

## Prerequisites

- Kubernetes 1.28+
- Helm 3.12+
- `kubectl` configured for your target cluster

## Quick Start (Bundled Mode)

Add the Tenure chart repository and install with defaults:

```bash
helm repo add tenure https://charts.tenureai.dev
helm repo update
helm install tenure tenure/tenure \
  --create-namespace \
  --namespace tenure
```

This deploys Tenure with a bundled MongoDB, auto-generated secrets, and `userId` defaulted to `team`.

## Key Configuration

### `mode`

Set this at the top level of `values.yaml`:

```yaml
mode: bundled # or external
```

### Database

- **Bundled**: Configure storage, resources, and root password under `database.bundled`.
- **External**: Provide `database.external.uri`. Enable TLS under `database.external.tls` if required.

```yaml
database:
  bundled:
    enabled: true
    password: tenure
    persistence:
      enabled: true
      size: 8Gi
  external:
    uri: ""
    tls:
      enabled: false
      caCertSecret: ""
```

### Secrets

Secret behavior depends on mode:

- **Bundled mode**: Helm generates a random Secret unless you provide `secrets.existingSecret` or explicitly set `secrets.apiToken`, `secrets.masterKey`, and `secrets.beliefKey`.
- **External mode**: You must provide `secrets.existingSecret`. The referenced Secret must contain exactly these keys: `api-token`, `master.key`, and `belief.key`.

```yaml
secrets:
  existingSecret: "" # Required in external mode
  apiToken: ""
  masterKey: ""
  beliefKey: ""
```

### Identity

`identity.userId` controls how the instance presents itself. It defaults to `team` for all Helm-based installations.

```yaml
identity:
  userId: ""
```

### Observability

OpenTelemetry traces and metrics are exported whenever an OTLP endpoint is provided. This works identically in bundled and external mode.

```yaml
observability:
  otlpEndpoint: "https://otel-collector.monitoring.svc:4317"
```

When set, the deployment automatically configures `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT`.

### Ingress

Expose Tenure externally with an ingress controller:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: tenure.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: tenure-tls
      hosts:
        - tenure.example.com
```

### Resources

Standard Kubernetes resource requests and limits:

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
```

## Team Configuration

Set `TENURE_MODE=teams` to enable multi-tenant mode. In this mode every incoming user must resolve to a `teamId` and an `orgId`. You control how this happens from the **Team Admin** page at `/admin/team`.

### Resolution strategies

The strategy dropdown on `/admin/team` selects how users are mapped. Only one strategy is active at a time.

| Strategy       | How it works                                                                                    | Best for                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Static**     | Everyone maps to the same default team and org.                                                 | First time setup, single-team deployments, or small orgs.   |
| **Header**     | Your SSO proxy or load balancer sends custom headers on every request.                          | Deployments behind an identity-aware proxy.                 |
| **SCIM Group** | The IdP provisions users and groups via the SCIM endpoint; you map SCIM groups to team/org IDs. | Okta, Azure AD, Google Workspace, or any SCIM 2.0 provider. |
| **Manual**     | Admins assign individual users to a team and org through the web UI.                            | Pilot groups, small teams, or fallback when no IdP exists.  |
| **Disabled**   | Reverts to single-user behavior.                                                                | Temporarily turning off teams without redeploying.          |

### Setting defaults at install time

Seed the default strategy and IDs through environment variables so the admin UI is pre-populated on first install:

```yaml
env:
  - name: TENURE_MODE
    value: teams
  - name: TENURE_DEFAULT_TEAM_ID
    value: team_main
  - name: TENURE_DEFAULT_ORG_ID
    value: org_main
```

These values are also editable at runtime in `/admin/team` and are stored in the configuration collection, so changes survive pod restarts.

### SCIM setup

To use the **SCIM Group** strategy:

1. Open `/admin/team` and choose **SCIM Group**.
2. Click **Generate new SCIM token**. Copy the token immediately; it is shown only once.
3. Copy the **SCIM base URL** displayed on the page (for example, `https://tenure.example.com/scim/v2`).
4. In your IdP, create a SCIM application using:
   - **SCIM endpoint**: the base URL from step 3
   - **Authorization**: Bearer token from step 2
   - **Supported operations**: Users and Groups (push and updates)
5. After users and groups sync, add mappings in the **Group-to-team mappings** table. For each SCIM `groupId`, enter the corresponding `teamId` and `orgId`, then save.

When a user authenticates, Tenure looks up their SCIM user record, finds the groups they belong to, and maps them to the first matching team/org pair.

### Header strategy

Choose the **Header** strategy if your proxy already knows the user's team and organization. The default header names are `x-team-id` and `x-org-id`, but you can rename them in `/admin/team`. If a request arrives without the headers, Tenure falls back to the default team and org IDs.

### Manual assignments

Choose the **Manual** strategy to assign users one at a time. Enter a `user_id` (typically the SSO email or subject), a `team_id`, and an `org_id`. The mapping takes effect on the user's next request. If a user is not mapped, Tenure falls back to the default team and org IDs.

### Onboarding wizard

During the first-run setup wizard, an IT admin is prompted to select a resolution strategy and enter default team and org IDs before reaching the main dashboard. This ensures the instance is tenant-aware from the first login.

### Multi-tenant data isolation

When team mode is enabled, all chat context, belief extraction, and compaction jobs carry the resolved `teamId` and `orgId`. Beliefs, sessions, and SCIM records are automatically scoped by tenant, so users in different teams or orgs cannot read or alter each other's data.

## Important Operational Notes

**Replica count**: `replicaCount` is currently limited to `1`. Tenure requires distributed job locking, a shared WebSocket bus, and search-index initialization hooks before it can safely run multiple API replicas.

**Secret lifecycle**: In bundled mode, auto-generated secrets are regenerated on every `helm template` render if values are left empty and no `existingSecret` is provided. For any installation you intend to keep, capture the generated Secret after the first install and pin the values on subsequent upgrades, or switch to `secrets.existingSecret`.

**TLS for external MongoDB**: If `database.external.tls.enabled` is true, `database.external.tls.caCertSecret` must reference a Secret in the same namespace containing the CA certificate.

## Full Reference

For a complete list of values, defaults, and type information, see `values.yaml` inside the chart and the inline comments in each template. For authentication, SSO proxy setup, and Personal Access Tokens, see the [Authentication Guide](./auth-guide.md).
