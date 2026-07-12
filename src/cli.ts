import { Command } from 'commander';
import { MODELS } from './ai';
import { DEFAULT_MODEL, isModelSpec, modelLabel, tell } from './tell';

const STDIN_TIMEOUT = 30_000;

type CliOptions = {
  model?: string;
  context?: boolean;
  yes?: boolean;
  chain?: boolean;
  exec?: boolean;
  input?: boolean;
};

type ParsedInput = { model: string; parts: string[]; readStdin: boolean };

function printModelHelp(): void {
  const rows: [string, string][] = Object.entries(MODELS).map(([alias, spec]) => [alias, modelLabel(spec)]);
  const aliasWidth = Math.max('Alias'.length, ...rows.map(([alias]) => alias.length));
  console.log('Usage: tell -m <model> "message"\n');
  console.log(`${'Alias'.padEnd(aliasWidth)}  Model`);
  console.log(`${'-'.repeat(aliasWidth)}  ${'-'.repeat(48)}`);
  for (const [alias, spec] of rows) console.log(`${alias.padEnd(aliasWidth)}  ${spec}`);
  console.log('\nFull specs are also accepted: vendor:model[:thinking]');
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`stdin read timed out after ${STDIN_TIMEOUT / 1000}s`));
    }, STDIN_TIMEOUT);

    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseArgs(args: string[], optModel: string | undefined, readPipedInput = false): ParsedInput {
  let model = optModel || DEFAULT_MODEL;
  let parts = args;
  const firstArg = args[0];
  const firstIsModel = !optModel && typeof firstArg === 'string' && isModelSpec(firstArg);
  if (firstIsModel) {
    model = firstArg;
    parts = args.slice(1);
  }
  return { model, parts, readStdin: !process.stdin.isTTY && (readPipedInput || parts.length === 0) };
}

function formatPrompt(userText: string, stdinText: string, opts: CliOptions): string {
  const trimmedUserText = userText.trim();
  const trimmedStdinText = stdinText.trim();
  if (!opts.input) return [trimmedUserText, trimmedStdinText].filter(Boolean).join('\n').trim();

  if (!trimmedStdinText) return trimmedUserText;
  if (!trimmedUserText) return trimmedStdinText;
  return [`User request:\n${trimmedUserText}`, `Input:\n${trimmedStdinText}`].filter(Boolean).join('\n\n');
}

function wantsModelHelp(argv: string[]): boolean {
  return argv.some((arg, index) => (arg === '-m' || arg === '--model') && argv[index + 1] === '--help');
}

function buildProgram(argv: string[]): Command {
  return new Command()
    .name('tell')
    .description('One-shot terminal assistant')
    .version('0.3.2')
    .argument('[input...]', 'optional model followed by the prompt, or just the prompt')
    .option('-m, --model <model>', 'model shortcode or full model spec (use -m --help to list)')
    .option('-c, --context', 'continue a persistent context for this cwd and model')
    .option('-y, --yes', 'execute requested commands without confirmation')
    .option('--chain', 'continue after command output until the assistant gives a final answer')
    .option('-i, --input', 'read stdin and include it with the prompt')
    .option('--no-exec', 'do not execute requested commands')
    .parse(argv);
}

function formatMissingPromptError(program: Command): string {
  return `error: missing prompt\n\n${program.helpInformation().trimEnd()}`;
}

async function main() {
  if (wantsModelHelp(process.argv)) {
    printModelHelp();
    return;
  }

  const program = buildProgram(process.argv);
  const opts = program.opts<CliOptions>();
  const input = parseArgs(program.args, opts.model, Boolean(opts.input));
  const stdinText = input.readStdin ? await readStdin().catch(() => '') : '';
  const prompt = formatPrompt(input.parts.join(' '), stdinText, opts);
  if (!prompt) {
    console.error(formatMissingPromptError(program));
    process.exitCode = 1;
    return;
  }

  try {
    await tell(input.model, prompt, {
      ...opts,
      silent: false,
    });
  } catch {
    process.exitCode = 1;
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main();
}
