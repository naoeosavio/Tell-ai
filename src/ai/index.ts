import { generateText } from 'ai';
import { getModel, MODELS, type ResolvedModelSpec, resolveModelSpec } from './models';

export type { ResolvedModelSpec };
export { MODELS, resolveModelSpec };

export interface AskInstance {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
}

export async function createAskAI(modelSpec: string): Promise<AskInstance> {
  const handle = await getModel(modelSpec);

  return {
    ask: async (message: string, options: { system: string; stream: false }) => {
      const { text } = await generateText({
        model: handle.model,
        instructions: options.system,
        prompt: message,
        reasoning: handle.reasoning as any,
      });
      return text;
    },
  };
}
