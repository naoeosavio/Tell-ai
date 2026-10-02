import type { SDKConfig, WireApi } from './config';

export type { WireApi };

/** Vendor name for the user-supplied endpoint. */
export const CUSTOM_VENDOR = 'custom';

/** Every accepted value of the `CUSTOM_API` override, in display order. */
export const WIRE_APIS: readonly WireApi[] = ['chat', 'responses', 'messages'];

const DEFAULT_WIRE: WireApi = 'chat';

/**
 * Identifies the client to whoever serves the endpoint. Browsers silently drop
 * `User-Agent` — a forbidden header name — so this is a courtesy, never a
 * requirement.
 */
export const CUSTOM_USER_AGENT = 'tell-ai-sdk';

/**
 * Wire per model id prefix. Gateways that speak more than one protocol are the
 * exception, not the rule: Opencode, OpenRouter, vLLM, Ollama, HuggingFace, Fireworks,
 * LiteLLM and friends serve every model over Chat Completions, so `chat` is the
 * default and this list only redirects the families whose own protocol is known.
 * Override per deployment with `CUSTOM_API` when a gateway routes otherwise.
 */
const WIRE_PREFIXES: ReadonlyArray<readonly [string, WireApi]> = [
  ['gpt-', 'responses'],
  ['grok-', 'responses'],
  ['muse-', 'responses'],
  ['claude-', 'messages'],
];

export type CustomModelInfo = {
  id: string;
  wire: WireApi;
};

/**
 * Type guard for the `CUSTOM_API` override.
 *
 * @param value - Raw user input.
 * @returns True when the value names a supported wire protocol.
 */
export function is_wire_api(value: string): value is WireApi {
  return (WIRE_APIS as readonly string[]).includes(value);
}

/**
 * Resolves which wire a model id needs: prefix rule, then Chat Completions.
 *
 * @param model - Bare model id, e.g. `gpt-5.4-mini`.
 * @returns The wire protocol the model is called with.
 */
export function resolve_wire(model: string): WireApi {
  const normalized = model.trim().toLowerCase();
  for (const [prefix, wire] of WIRE_PREFIXES) {
    if (normalized.startsWith(prefix)) return wire;
  }
  return DEFAULT_WIRE;
}

/**
 * Headers merged into every request of a vendor — the escape hatch for
 * endpoints that need something the SDK does not model (routing ids, project or
 * tenant tags, gateway-specific auth). Injected from `CUSTOM_HEADERS`.
 *
 * @param config - Injected config.
 * @returns Headers for the custom vendor, empty when none are configured.
 */
export function custom_headers(config: SDKConfig): Record<string, string> {
  return { ...(config.headers?.[CUSTOM_VENDOR] ?? {}) };
}

/**
 * Lists the model ids an OpenAI-compatible endpoint exposes (`GET /models`),
 * annotated with the wire each one would be called with.
 *
 * @param config - Injected keys/urls; the custom key and URL must be present.
 * @returns Model ids sorted alphabetically.
 */
export async function list_custom_models(config: SDKConfig): Promise<CustomModelInfo[]> {
  const base_url = config.urls[CUSTOM_VENDOR];
  const api_key = config.keys[CUSTOM_VENDOR];
  if (!base_url) {
    throw new Error(`vendor "${CUSTOM_VENDOR}" requires urls.${CUSTOM_VENDOR} (CLI env: CUSTOM_BASE_URL)`);
  }
  if (!api_key) {
    throw new Error(`vendor "${CUSTOM_VENDOR}" requires keys.${CUSTOM_VENDOR} (CLI env: CUSTOM_API_KEY)`);
  }
  const response = await fetch(`${base_url}/models`, {
    headers: { Authorization: `Bearer ${api_key}`, 'User-Agent': CUSTOM_USER_AGENT, ...custom_headers(config) },
  });
  if (!response.ok) {
    throw new Error(`vendor "${CUSTOM_VENDOR}" model list failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort()
    .map((id) => ({ id, wire: resolve_wire(id) }));
}