# Observability & Telemetry Guide

## Overview

Tenure ships with native OpenTelemetry instrumentation so teams gain full visibility into system health, request latency, and database interactions. When you configure an OTLP collector endpoint, traces and metrics are exported automatically without requiring sidecars or manual code changes.

## Architecture & Components

The telemetry stack is powered by the OpenTelemetry Node SDK. It initializes automatically whenever the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable is present.

Key components include:

- OTLP Trace Exporter - Exports distributed traces in OTLP/Proto format.
- OTLP Metric Exporter - Sends application metrics through a periodic reader.
- OTLP Log Exporter - Emits log records via a batch processor.
- PeriodicExportingMetricReader - Flushes metrics at a fixed 60-second interval.
- Auto-Instrumentations - Covers Node.js core modules, HTTP frameworks, and MongoDB drivers.

## Configuration

Telemetry is configured entirely through Helm values. Provide your OTLP collector endpoint under the `observability` block:

```yaml
observability:
  otlpEndpoint: "https://otel-collector.monitoring.svc:4317"
```

During chart rendering, the deployment template injects this value as `OTEL_EXPORTER_OTLP_ENDPOINT` and hardcodes `OTEL_SERVICE_NAME` to `tenure`.

No application restart logic or command-line flags are required; the SDK bootstraps itself on application startup.

## Automatic Instrumentation

### HTTP & Framework Instrumentation

Tenure uses Fastify as its HTTP layer. Through `@opentelemetry/auto-instrumentations-node`, incoming requests, outgoing calls, and framework-specific spans are captured automatically.

### MongoDB Instrumentation

All MongoDB commands are instrumented via `MongoDBInstrumentation`. By default, command shapes are serialized to JSON and attached to trace spans.

### Disabled Instrumentations

File-system instrumentation is explicitly disabled to reduce span noise and avoid leaking local path structures.

## Security & Data Sanitization

Tenure applies a strict sanitization layer to every MongoDB command before it is attached to a trace span. The `sanitizeCommand` helper recursively replaces every leaf value with the literal string `[redacted]`.

This guarantees that:

- Belief content never appears in trace data.
- API token hashes and bearer tokens are never written to spans.
- Document structures and field names remain visible for debugging, but all values are stripped.

Because of this design, even a misconfigured OTLP backend or trace sampler will not expose sensitive memory content.

## Custom Attributes & Tracing

Beyond auto-instrumentation, Tenure enriches spans with domain-specific attributes:

- **`user.id`** - On every authenticated request, the active OpenTelemetry span is annotated with the Tenure user ID. This occurs for proxy-authenticated sessions, root token access, and PAT-authenticated requests alike.

This attribution makes it straightforward to correlate trace waterfalls with specific users or API clients during incident response.

## Disabling Telemetry

If you prefer to run without OpenTelemetry, simply omit `observability.otlpEndpoint` from your `values.yaml` or leave it empty. The SDK initialization is skipped entirely when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.

There is no separate boolean toggle required.

## Operational Notes

- **Signal handling** - The SDK gracefully shuts down on `SIGTERM` and `SIGINT`, ensuring pending spans and metrics are flushed before the container exits.
- **Version consistency** - The Helm chart uses the `appVersion` declared in `Chart.yaml` to pull a matching container image, so telemetry behavior is consistent across chart upgrades.
- **Replica sets** - If your MongoDB deployment is a replica set, Tenure starts a change stream for real-time belief synchronization. This activity is captured by the MongoDB instrumentation as ordinary operation spans.

## Summary

| Concern                  | Implementation                              |
| ------------------------ | ------------------------------------------- |
| **Protocol**             | OTLP/Proto over HTTP                        |
| **Traces**               | Node SDK + OTLP Trace Exporter              |
| **Metrics**              | Periodic export every 60 seconds            |
| **Auto-instrumentation** | HTTP, Fastify, MongoDB                      |
| **Sensitive data**       | Command values redacted; structure retained |
| **User attribution**     | `user.id` added to auth spans               |
| **Enablement**           | Set `observability.otlpEndpoint`            |
| **Logs**                 | Batch export via OTLP Log Exporter          |

For related deployment and access-control guidance, see the Authentication Guide.
