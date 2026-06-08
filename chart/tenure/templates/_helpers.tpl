{{/*
Expand the name of the chart.
*/}}
{{- define "tenure.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "tenure.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "tenure.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tenure.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Validation helpers
*/}}
{{- define "tenure.validate" -}}
{{- if not (has .Values.mode (list "bundled" "external")) }}
{{- fail "mode must be either 'bundled' or 'external'" }}
{{- end }}
{{- if gt (int .Values.replicaCount) 1 }}
{{- fail "replicaCount > 1 is not yet supported. Tenure requires distributed job locking, a shared websocket bus, and a search-index init hook before it can run multiple API replicas. See docs/scaling.md" }}
{{- end }}
{{- end }}