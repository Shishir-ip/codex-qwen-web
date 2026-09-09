/**
 * Qwen model-catalog additions for codex-qwen-web
 *
 * This module appends conservative model rows for chat.qwen.ai (chat-qwen/*)
 * into an existing native model catalog object. It does not modify upstream
 * rows but returns a new augmented catalog object.
 *
 * Notes:
 * - The context-window and token limits are conservative estimates for initial testing.
 * - Replace token estimates with measured values after running authenticated probes
 *   and measuring Qwen's reported limits.
 */

export type QwenModelRow = {
  id: string; // e.g. chat-qwen/light
  name: string;
  provider: string; // e.g. "qwen"
  effort: "light" | "medium" | "high" | "pro";
  backendModel?: string;
  description?: string;
  context_window: number; // tokens
  token_estimate_notes?: string;
  supports_images?: boolean;
};

const QWEN_DEFAULT_ROWS: QwenModelRow[] = [
  {
    id: "chat-qwen/light",
    name: "Qwen Web — Light",
    provider: "qwen",
    effort: "light",
    description: "Conservative Light Qwen Web row (smallest context) — unauthenticated probe recommended.",
    context_window: 8192,
    token_estimate_notes: "Estimate: 8k tokens. Replace with measured Qwen reported value.",
    supports_images: false,
  },
  {
    id: "chat-qwen/medium",
    name: "Qwen Web — Medium",
    provider: "qwen",
    effort: "medium",
    description: "Medium effort Qwen Web row; balanced context and cost.",
    context_window: 16384,
    token_estimate_notes: "Estimate: 16k tokens. Replace with measured Qwen reported value.",
    supports_images: false,
  },
  {
    id: "chat-qwen/high",
    name: "Qwen Web — High",
    provider: "qwen",
    effort: "high",
    description: "High-effort Qwen Web row with larger context for long-form tasks.",
    context_window: 32768,
    token_estimate_notes: "Estimate: 32k tokens. Replace with measured Qwen reported value.",
    supports_images: true,
  },
  {
    id: "chat-qwen/pro",
    name: "Qwen Web — Pro",
    provider: "qwen",
    effort: "pro",
    description: "Pro-tier Qwen Web row (if account exposes a Pro-like tier).",
    context_window: 65536,
    token_estimate_notes: "Estimate: 64k tokens. Replace with measured Qwen reported value.",
    supports_images: true,
  },
];

export interface AugmentOptions {
  namespacePrefix?: string; // default: "chat-qwen/"
  includeRows?: string[]; // list of ids to include; default: all
}

/**
 * augmentCatalogWithQwen(originalCatalog, opts)
 * - originalCatalog: the canonical model catalog object (JSON) produced by the upstream provider.
 * - opts.namespacePrefix: optional prefix if you prefer a different prefix.
 *
 * Returns a shallow-copied catalog with the Qwen rows appended under unique ids.
 */
export function augmentCatalogWithQwen(originalCatalog: Record<string, any>, opts: AugmentOptions = {}): Record<string, any> {
  const namespacePrefix = opts.namespacePrefix ?? "chat-qwen/";
  const include = opts.includeRows ?? QWEN_DEFAULT_ROWS.map(r => r.id);

  // Shallow clone to avoid mutating input
  const catalog = { ...(originalCatalog || {}) };
  try {
    // Ensure a models object exists (structure may vary by upstream catalog)
    if (!catalog.models || typeof catalog.models !== "object") catalog.models = {};

    for (const row of QWEN_DEFAULT_ROWS) {
      if (!include.includes(row.id)) continue;
      const key = row.id;
      // If upstream already has this id, skip or create a namespaced alias
      if (catalog.models[key]) {
        // do not override; prefer upstream. add a namespaced alias if needed.
        const alias = `${namespacePrefix}${key.split("/").pop()}`;
        if (!catalog.models[alias]) {
          catalog.models[alias] = {
            id: alias,
            name: row.name,
            provider: row.provider,
            description: row.description,
            context_window: row.context_window,
            _notes: row.token_estimate_notes,
            supports_images: row.supports_images,
          };
        }
        continue;
      }
      catalog.models[key] = {
        id: key,
        name: row.name,
        provider: row.provider,
        description: row.description,
        context_window: row.context_window,
        _notes: row.token_estimate_notes,
        supports_images: row.supports_images,
      };
    }
  } catch (error) {
    // If augmentation fails, return original catalog unchanged and surface a note in _qwen_augment_error
    return { ...originalCatalog, _qwen_augment_error: String(error) };
  }
  return catalog;
}

export default { augmentCatalogWithQwen, QWEN_DEFAULT_ROWS };
