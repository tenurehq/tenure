export const SIDECAR_BEGIN = '<<<SIDECAR_JSON>>>';
export const SIDECAR_END = '<<<END_SIDECAR>>>';

export interface SplitResult {
  visible: string;
  sidecarRaw: string | null;
  parseStatus: 'parsed' | 'needs_repair' | 'missing';
}

const SIDECAR_FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n```$/gm;

function unwrapSidecarFence(content: string): string {
  return content.replace(SIDECAR_FENCE_RE, (match, inner: string) => {
    if (inner.includes('SIDECAR_JSON') || inner.includes('END_SIDECAR')) {
      return inner;
    }
    return match;
  });
}

/**
 * Strip markdown fences that wrap the JSON object inside the sidecar region.
 * Repairs the common case where the model fences only the JSON, not the
 * surrounding markers, leaving sidecarRaw as ```json\n{...}\n```.
 */
function stripInnerFences(raw: string): string {
  return raw
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
}

/**
 * Extract the first well-balanced JSON object using brace depth.
 * Used when END_SIDECAR is missing to prevent trailing prose from
 * poisoning JSON.parse.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') depth--;

    if (depth === 0) return text.slice(start, i + 1);
  }

  return null;
}

function normalizeMarkers(content: string): string {
  return content
    .replace(/<<<\s*SIDECAR_JSON\s*>>>/g, SIDECAR_BEGIN)
    .replace(/<<<\s*END_SIDECAR\s*>>>/g, SIDECAR_END);
}

export function splitSidecar(content: string): SplitResult {
  const unwrapped = unwrapSidecarFence(content);
  const normalized = normalizeMarkers(unwrapped);

  const beginIdx = normalized.lastIndexOf(SIDECAR_BEGIN);
  if (beginIdx === -1) {
    return {
      visible: content.trimEnd(),
      sidecarRaw: null,
      parseStatus: 'missing'
    };
  }

  const afterBegin = beginIdx + SIDECAR_BEGIN.length;
  const endIdx = normalized.indexOf(SIDECAR_END, afterBegin);
  const visible = normalized.slice(0, beginIdx).trimEnd();

  const rawRegion =
    endIdx === -1
      ? normalized.slice(afterBegin)
      : normalized.slice(afterBegin, endIdx);

  let sidecarRaw = stripInnerFences(rawRegion.trim());

  if (endIdx === -1 && sidecarRaw) {
    const extracted = extractFirstJsonObject(sidecarRaw);
    if (extracted) sidecarRaw = extracted;
  }

  if (!sidecarRaw) {
    return { visible, sidecarRaw: null, parseStatus: 'needs_repair' };
  }

  return {
    visible,
    sidecarRaw,
    parseStatus: endIdx === -1 ? 'needs_repair' : 'parsed'
  };
}

/**
 * Trimmed to fields the prompts actually emit.
 * topic_shift, topic_label, and possible_alias_candidates are removed
 * as they are never populated by either the standard or IDE prompt paths.
 */
export interface SidecarPayload {
  orientation_tax?: boolean;
  new_beliefs?: unknown[];
  belief_updates?: unknown[];
  entity_updates?: unknown[];
  resolved_open_questions?: unknown[];
  new_open_questions?: unknown[];
  style_signals?: unknown[];
  [key: string]: unknown;
}

export function parseSidecar(raw: string | null): SidecarPayload | null {
  if (!raw) return null;
  const cleaned = stripInnerFences(raw.trim());
  try {
    return JSON.parse(cleaned) as SidecarPayload;
  } catch {
    return null;
  }
}
