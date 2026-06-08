# Backup & Disaster Recovery Guide

## Overview

Tenure stores your world model in MongoDB and protects belief content at rest using MongoDB Client-Side Field Level Encryption (CSFLE) and the CredentialVault for provider keys. For team deployments, you should treat backups as a critical operational practice from day one. Tenure never phones home; recovery depends entirely on your own artifacts.

This guide covers logical exports via the Tenure API, MongoDB-level dumps, and the Kubernetes-native concerns (Secrets, PVCs, and Ingress) that a restore requires.

## What Gets Backed Up

A logical export captures:

- Active and superseded beliefs
- Sessions, turns, and runtime configuration
- Persona cache and compaction history
- Provider credentials (exported from the CredentialVault in plaintext, then encrypted inside the archive)
- File metadata and topic indexes

The archive is a single passphrase-encrypted bundle. It is safe to run multiple times; existing beliefs are skipped on import rather than duplicated.

## Backup Methods

### Method 1: Logical Export (Recommended for Teams)

The application exposes `/v1/backup/export` and `/v1/backup/import`. In team mode, only requests authenticated via SSO proxy or the bootstrap root token can reach these endpoints. Personal Access Tokens are explicitly scoped away from admin and backup routes, so plan to run exports from a pod or browser session authenticated through your IdP proxy.

```bash
# From inside the cluster or via port-forward
curl -X POST http://tenure:5757/v1/backup/export \
  -H "Authorization: Bearer <root-or-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"passphrase": "<strong-passphrase>"}' \
  --output tenure-backup-$(date +%F).enc
```

Store the passphrase in a secrets manager separate from the archive itself.

**Important:** The application optionally exports and imports based on the environment variables `TENURE_BACKUP_EXPORTS_ENABLED` and `TENURE_BACKUP_IMPORTS_ENABLED`, which are controlled from `values.yaml` under `backup.exportsEnabled` and `backup.importsEnabled`. If exports are disabled, the API returns a failure.

### Method 2: MongoDB Dump

For external MongoDB (Atlas, DocumentDB, self-managed), use your provider's snapshot tooling or `mongodump` against the connection string you provided in `database.external.uri`. Because Tenure uses CSFLE, `mongodump` captures ciphertext for encrypted fields. A raw restore requires the **same** `belief.key` and `master.key` that were current when the backup was taken.

For bundled MongoDB, run `mongodump` against the StatefulSet service:

```bash
kubectl exec -i tenure-mongo-0 -- mongodump --uri="mongodb://tenure:<password>@localhost:27017/tenure?authSource=admin" --archive > tenure-mongo.archive
```

### Method 3: Volume Snapshots (Bundled Mode Only)

If you use the bundled MongoDB StatefulSet with a PVC, you can also protect the data plane with Kubernetes volume snapshots or your cloud provider's block storage backups. Snapshots capture the entire data directory but are less portable than logical exports. They are best used as a fast recovery layer for the same cluster, not for cross-cluster migration.

## Restoring

### Restoring from a Logical Export

Use the UI at `/admin/backup` or the API:

```bash
ARCHIVE=$(base64 < tenure-backup-2025-01-15.enc)
curl -X POST http://tenure:5757/v1/backup/import \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"passphrase\": \"<passphrase>\", \"archive\": \"$ARCHIVE\"}"
```

A successful restore preserves beliefs, credentials, and persona state. No re-onboarding is required.

### Restoring to a New Helm Release

If you are recovering into a fresh cluster or namespace:

1. Recreate the Kubernetes Secret referenced by `secrets.existingSecret` (or let the chart regenerate one if you are in bundled mode without an existing secret).
2. Ensure the new instance can reach the same MongoDB (or restore the database first via Method 2).
3. Run the logical import. The import process writes decrypted content back into MongoDB through the app's CSFLE client, so the new instance's `belief.key` and `master.key` will re-encrypt data automatically.

## Secret Management and Disaster Recovery

A complete DR plan must account for the encryption boundary. Tenure relies on two local keys:

- **CredentialVault master key** (`master.key`) — decrypts provider API keys at runtime.
- **CSFLE belief master key** (`belief.key`) — unwraps the MongoDB DEK that encrypts belief content.

These keys are mounted from the Kubernetes Secret into `/mnt/secrets`. If you lose the namespace or the Secret, but still have a logical API export, you are protected because the export is decrypted by the running app and then re-encrypted with your passphrase.

If you rely on raw MongoDB dumps or volume snapshots, you **must** preserve the original `master.key` and `belief.key`. Without them, the data is unreadable.

## Operational Checklist

- [ ] Enable or disable exports/imports via `values.yaml` depending on your security posture.
- [ ] Store the API token or root credential required to run exports in a break-glass location.
- [ ] Store backup archives and passphrases in separate locations.
- [ ] For bundled mode, snapshot the MongoDB PVC on a schedule independent of the application.
- [ ] For external mode, enable your provider's point-in-time recovery.
- [ ] Document which Kubernetes Secret contains `master.key` and `belief.key` so it can be restored before the app starts.
