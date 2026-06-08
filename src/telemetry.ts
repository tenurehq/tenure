import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { MongoDBInstrumentation } from "@opentelemetry/instrumentation-mongodb";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";

function parseOtelHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "tenure",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "unknown",
    "deployment.environment": process.env.NODE_ENV || "production",
    "host.name": require("os").hostname()
  });

  const headers = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const timeoutMillis = parseInt(
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT || "15000",
    10
  );

  const traceExporter = new OTLPTraceExporter({ headers, timeoutMillis });
  const metricExporter = new OTLPMetricExporter({ headers, timeoutMillis });
  const logExporter = new OTLPLogExporter({ headers, timeoutMillis });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false }
      }),
      new MongoDBInstrumentation({
        dbStatementSerializer: (cmd) => JSON.stringify(sanitizeCommand(cmd)),
        enhancedDatabaseReporting: false
      })
    ]
  });

  sdk.start();
  process.on("SIGTERM", () => sdk.shutdown().catch(console.error));
  process.on("SIGINT", () => sdk.shutdown().catch(console.error));
}

function sanitizeCommand(
  cmd: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(cmd).map((k) => [
      k,
      typeof cmd[k] === "object" && cmd[k] !== null
        ? sanitizeCommand(cmd[k] as Record<string, unknown>)
        : "[redacted]"
    ])
  );
}
