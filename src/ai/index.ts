import { generateText } from 'ai';
import { getModel, MODELS, type ResolvedModelSpec, resolveModelSpec } from './models';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

export type { ResolvedModelSpec };
export { MODELS, resolveModelSpec };

export interface AskInstance {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
}

export async function createAskAI(modelSpec: string): Promise<AskInstance> {
  const handle = await getModel(modelSpec);
  const reasoning = handle.fast ? 'none' : handle.reasoning;

  return {
    ask: async (message: string, options: { system: string; stream: false }) => {
      const genOptions: any = {
        model: handle.model,
        instructions: options.system,
        prompt: message,
      };
      if (handle.reasoningEffort) {
        genOptions.reasoning_effort = handle.reasoningEffort;
      } else {
        genOptions.reasoning = reasoning;
      }
      const { text } = await generateText(genOptions);
      return text;
    },
  };
}
