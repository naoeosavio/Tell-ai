import { type AskInstance, create_ask_ai } from './ask';
import type { SDKKeys, SDKUrls } from './config';
import { get_system_prompt } from './systemPrompt';
import { strip_run_tags, strip_think_tags } from './tags';

export type TellOptions = {
  /** Model alias or full spec (e.g. 'g', 'deepseek:deepseek-flash:high'). Defaults to 'g'. */
  model?: string;
  /** API keys by vendor; injected (never read from the environment). */
  keys?: SDKKeys;
  /** Custom base URLs per vendor (e.g. a CORS proxy). */
  urls?: SDKUrls;
  /** Allow command execution instructions in the prompt. Defaults to false (no-exec). */
  exec?: boolean;
  /** Working directory to announce in the system prompt (browsers have none). */
  cwd?: string;
  /** Platform string to announce in the system prompt (e.g. 'linux 6.8.0'). */
  platform?: string;
  /** Previous conversation to prepend as context. */
  context?: string;
  /** Override the system prompt entirely. */
  system?: string;
  /** Reuse an existing AskInstance instead of creating a new one. */
  ask?: AskInstance;
  /** Return the raw model response without stripping <think>/<RUN> tags or trimming. */
  raw?: boolean;
};

/**
 * `tell --no-exec` as a function: one-shot assistant call that builds the tell
 * system prompt (execution disabled by default), calls the model, and returns
 * the final answer with <think>/<RUN> tags stripped.
 */
export async function tell(message: string, options: TellOptions = {}): Promise<string> {
  const system =
    options.system ??
    get_system_prompt({
      ...(options.exec !== undefined ? { exec: options.exec } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
  const prompt = options.context ? `Previous context:\n${options.context}\n\nUser:\n${message}` : message;
  const ai =
    options.ask ?? (await create_ask_ai(options.model ?? 'g', { keys: options.keys ?? {}, urls: options.urls ?? {} }));
  const response = await ai.ask(prompt, { system, stream: false });
  return options.raw ? response : strip_run_tags(strip_think_tags(response)).trim();
}
