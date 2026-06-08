# Deployment Guide

## Overview

The Tenure Helm chart deploys the application in one of two top-level modes:

- **Bundled**: A self-contained MongoDB instance runs as a StatefulSet alongside Tenure. This is ideal for development, proofs of concept, or small teams that want to evaluate the platform quickly.
- **External**: Tenure connects to an existing MongoDB (such as MongoDB Atlas, Amazon DocumentDB, or a self-managed replica set). This is recommended for production or any shared instance where durability, backups, and scaling are managed independently.

Everything else, secrets, observability, ingress, and identity, is configured as a flat capability, not as a tier.

## Prerequisites

- Kubernetes 1.28+
- Helm 3.12+
- `kubectl` configured for your target cluster

## Quick Start (Bundled Mode)

Install the chart with defaults:

```bash
helm upgrade --install tenure ./chart \
  --create-namespace \
  --namespace tenure
```

This deploys Tenure with a bundled MongoDB, auto-generated secrets, and `userId` defaulted to `local`.

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
- **External mode**: You must provide `secrets.existingSecret`, and the referenced Secret must contain keys `api-token`, `master.key`, and `belief.key`.

```yaml
secrets:
  existingSecret: "" # Required in external mode
  apiToken: ""
  masterKey: ""
  beliefKey: ""
```

### Identity

`identity.userId` controls how the instance presents itself. It defaults to `local` in bundled mode and `team` in external mode. Team mode enables the dashboard and access-token features described in the Authentication Guide [1].

```yaml
identity:
  userId: "" # Defaults to local (bundled) or team (external)
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

## Important Operational Notes

**Replica count**: `replicaCount` is currently limited to `1`. Tenure requires distributed job locking, a shared WebSocket bus, and search-index initialization hooks before it can safely run multiple API replicas.

**Secret lifecycle**: In bundled mode, auto-generated secrets are regenerated on every `helm template` render if not explicitly provided. For any installation you intend to keep, capture the generated Secret after the first install and pin the values on subsequent upgrades, or switch to `secrets.existingSecret`.

**TLS for external MongoDB**: If `database.external.tls.enabled` is true, `database.external.tls.caCertSecret` must reference a Secret in the same namespace containing the CA certificate.

## Full Reference

For a complete list of values, defaults, and type information, see `values.yaml` inside the chart and the inline comments in each template. For authentication, SSO proxy setup, and Personal Access Tokens, see the Authentication Guide [1].
