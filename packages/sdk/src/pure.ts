/**
 * Dependency-free protocol surface of `@tell-ai/sdk`.
 *
 * Everything re-exported here is pure: no provider import, no `node:*`
 * builtin, no `process.env`, no network. It is the only SDK surface the
 * core's runtime wiring may depend on, because the core's browser entry
 * has to stay self-contained (zero bare imports) and small.
 *
 * The same source modules back the main entry and the browser entry — this
 * file adds no second definition, only a second *entry point* over the same
 * owners (`./config`, `./custom`, `./systemPrompt`, `./tags`).
 */

/** Injected environment contract (keys, URLs, wire). */
export type { SDKConfig, SDKKeys, SDKUrls, WireApi } from './config';
/** Model→wire resolution constants (no provider, no network). */
export { is_wire_api, WIRE_APIS } from './custom';
/** Shared system prompt (the exec / no-exec variants). */
export { get_system_prompt, type PromptOptions } from './systemPrompt';
/** `<RUN>` / thinking tag handling. */
export { extract_runs, sanitize_reasoning, strip_markdown_code_blocks, strip_run_tags, strip_think_tags } from './tags';
