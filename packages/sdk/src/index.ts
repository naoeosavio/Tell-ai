import { generateText } from 'ai';
import type { SDKConfig } from './config';
import { get_model, MODELS, type ResolvedModelSpec, resolve_model_spec } from './models';
import { extract_runs, strip_markdown_code_blocks, strip_run_tags, strip_think_tags } from './tags';

export type { SDKConfig, SDKKeys, SDKUrls } from './config';
export type { ResolvedModelSpec };
export { MODELS, resolve_model_spec };
export { extract_runs, strip_markdown_code_blocks, strip_run_tags, strip_think_tags };
export { summarize_context } from './summarize';

export interface AskInstance {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
}

export async function create_ask_ai(modelSpec: string, config: SDKConfig): Promise<AskInstance> {
  const handle = await get_model(modelSpec, config);
  const reasoning = handle.fast ? 'none' : handle.reasoning;

  return {
    ask: async (message: string, options: { system: string; stream: false }) => {
      const gen_options: any = {
        model: handle.model,
        instructions: options.system,
        prompt: message,
      };
      if (handle.reasoningEffort) {
        gen_options.reasoning_effort = handle.reasoningEffort;
      } else {
        gen_options.reasoning = reasoning;
      }
      const result = await generateText(gen_options);
      const model_reasoning = result.finalStep.reasoningText;
      return model_reasoning ? `<think>${model_reasoning}</think>\n${result.text}` : result.text;
    },
  };
}
