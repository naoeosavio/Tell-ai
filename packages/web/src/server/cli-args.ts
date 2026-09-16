import path from 'node:path';

export interface CliArgs {
  /** Resolved absolute working directory for the sandbox. */
  cwd: string;
  /** Optional initial prompt used to pre-seed the first chat message. */
  initialPrompt?: string | undefined;
  /** Whether automatic execution of AI-generated commands is enabled. Defaults to true (unless --no-exec). */
  autoExecute: boolean;
  /** Model shortcode or full spec (`-m/--model`). */
  model: string;
  /** Whether to continue after command output until the AI gives a final answer. */
  chain: boolean;
  /** Whether command execution is auto-confirmed (autoExecute on). */
  yes: boolean;
  /** Whether the Require Approval toggle is seeded on the client's first visit (`--require-approval`). */
  requireApproval: boolean;
  /** Whether responses are streamed to the browser as they are generated (`--stream`). */
  stream: boolean;
  /** Whether reasoning headers start expanded (`--think`; collapse persists). */
  think: boolean;
  /** TCP port for the web server (`--port`). Overrides PORT env. */
  port?: number | undefined;
  /** Bind address for the web server (`--host`). Defaults to 127.0.0.1. */
  host?: string | undefined;
  /** Per-command execution timeout in ms (`--exec-timeout`). Defaults to 120000. */
  execTimeout?: number | undefined;
  /** Whether `--help` was requested. */
  help: boolean;
}

/** A token that looks like another flag, not a value (e.g. `--cwd --prompt x`). */
function looksLikeFlag(token: string | undefined): boolean {
  return typeof token === 'string' && token.startsWith('-') && token !== '-';
}

function argValue(argv: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const i = argv.indexOf(flag);
    if (i >= 0) {
      const next = argv[i + 1];
      if (next !== undefined && !looksLikeFlag(next)) return next;
    }
  }
  return undefined;
}

function has(argv: string[], ...flags: string[]): boolean {
  return flags.some((flag) => argv.includes(flag));
}

export function parseCliArgs(argv: string[], defaultCwd: string): CliArgs {
  const argCwd = argValue(argv, '--cwd');
  const initialPrompt = argValue(argv, '--prompt');
  const model = argValue(argv, '-m', '--model') || '';
  const chain = has(argv, '--chain');
  const yes = has(argv, '-y', '--yes');
  const noExec = has(argv, '--no-exec');
  const requireApproval = has(argv, '--require-approval');
  const stream = has(argv, '--stream');
  const think = has(argv, '--think');
  const portRaw = argValue(argv, '--port');
  const port = portRaw !== undefined ? Number(portRaw) : undefined;
  const host = argValue(argv, '--host');
  const execTimeoutRaw = argValue(argv, '--exec-timeout');
  const execTimeout = execTimeoutRaw !== undefined ? Number(execTimeoutRaw) : undefined;
  return {
    cwd: path.resolve(argCwd || defaultCwd),
    initialPrompt,
    // `--no-exec` always wins (same precedence as the CLI); `-y` is not part
    // of this expression — autoExecute merely reflects the default toggle state.
    autoExecute: !noExec,
    model,
    chain,
    yes,
    requireApproval,
    stream,
    think,
    port: port !== undefined && Number.isFinite(port) && port > 0 ? port : undefined,
    host,
    execTimeout:
      execTimeout !== undefined && Number.isFinite(execTimeout)
        ? Math.min(600_000, Math.max(1_000, Math.round(execTimeout)))
        : undefined,
    help: has(argv, '--help', '-h'),
  };
}

export function printHelp(): void {
  console.log(`Tell Web — usage: tell [options]

Options:
  --cwd <path>      Working directory for the sandbox (default: current dir)
  --prompt <text>   Initial chat prompt
  -m, --model <id>  Model shortcode or full spec (default: TELL_MODEL env or "l")
  --port <number>   TCP port for the web server (default: PORT env or 3000)
  --host <address>  Bind address (default: 127.0.0.1; use 0.0.0.0 to expose on LAN)
  --exec-timeout <ms>
                    Per-command timeout in ms (default: 120000, max: 600000)
  --chain           Continue after command output until the AI gives a final answer
  --stream          Seed the client's Stream toggle on the first visit, and keep
                    streaming as the server fallback for requests that omit the
                    "stream" field (Settings → Agent Runtime overrides per request)
  --think           Start reasoning headers expanded (collapsed by default)
  -y, --yes         Auto-confirm command execution
  --no-exec         Disable automatic execution of AI-generated commands
  --require-approval
                    Seed the Require Approval toggle on the client's first visit
                    (safe commands auto-run, risky ones need the confirm card)
  -h, --help        Show this help
`);
}
