import path from 'path';

import {
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  validate_tellrc_limit_value,
  validate_temperature,
} from '@tell-ai/core';

/**
 * True when a bind address admits local clients only.
 *
 * The server warns when it binds another address without `TELL_TOKEN`.
 *
 * @param host - Bind address from `--host` (or the default).
 * @returns True for the loopback names and addresses.
 */
export function is_loopback_host(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

export interface CliArgs {
  /** Resolved absolute working directory for the sandbox. */
  cwd: string;
  /** Optional initial prompt used to pre-seed the first chat message. */
  initialPrompt?: string | undefined;
  /** Whether automatic execution of AI-generated commands is enabled. Defaults to false. */
  autoExecute: boolean;
  /** Whether command execution is disabled for the entire server. */
  noExec: boolean;
  /** Model shortcode or full spec (`-m/--model`). */
  model: string;
  /** Tellrc profile name forwarded by the CLI (`--profile`). */
  profile?: string | undefined;
  /** File with custom instructions forwarded by the CLI (`--system-file`). */
  systemFile?: string | undefined;
  /** Sampling temperature 0..2 forwarded by the CLI (`--temperature`). */
  temperature?: number | undefined;
  /** Validated max chain steps forwarded by the CLI (`--max-chain-steps`). */
  maxChainSteps?: number | undefined;
  /** Validated max buffer bytes forwarded by the CLI (`--max-buffer-bytes`). */
  maxBufferBytes?: number | undefined;
  /** Validated delivered output cap bytes forwarded by the CLI (`--output-max-bytes`). */
  outputMaxBytes?: number | undefined;
  /** Validated context chars forwarded by the CLI (`--context-chars`). */
  contextChars?: number | undefined;
  /** Validated stdin timeout ms forwarded by the CLI (`--stdin-timeout-ms`). */
  stdinTimeoutMs?: number | undefined;
  /** Validated delegation budget forwarded by the CLI (`--max-delegations`, 0..2). */
  maxDelegations?: number | undefined;
  /** Validated delegation repost target forwarded by the CLI (`--delegation-repost`, 512..8192). */
  delegationRepostChars?: number | undefined;
  /** Validated delegation round cap forwarded by the CLI (`--delegation-max-rounds`, 0..128). */
  delegationMaxRounds?: number | undefined;
  /** Whether to continue after command output until the AI gives a final answer. */
  chain: boolean;
  /** Whether command execution is auto-confirmed (autoExecute on). */
  yes: boolean;
  /** Whether the Require Approval toggle is seeded on the client's first visit (`--require-approval`). */
  requireApproval: boolean;
  /** Raw `-t/--task` value (empty when the flag is bare); undefined without task mode. */
  task?: string | undefined;
  /** Whether the task context starts empty at boot (`--task-reset`, from the CLI `-n`). */
  taskReset: boolean;
  /** Boot-time flag conflict, printed and exited by the server (exit 2). */
  error?: string | undefined;
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
  const hasTask = has(argv, '-t', '--task');
  // A bare `--task` (no value before the next flag) is task mode with no ref.
  const taskRaw = hasTask ? (argValue(argv, '-t', '--task') ?? '') : undefined;
  const taskReset = has(argv, '--task-reset');
  const noExec = has(argv, '--no-exec');
  // Task mode forces the chain and the execution contract (never `-y`:
  // auto comes only from the flag, like the CLI host); the conflict is a
  // boot error, never a silent deny.
  const chain = hasTask || has(argv, '--chain');
  const yes = has(argv, '-y', '--yes');
  const requireApproval = hasTask || has(argv, '--require-approval');
  const stream = hasTask || has(argv, '--stream');
  const think = has(argv, '--think');
  const portRaw = argValue(argv, '--port');
  const host = argValue(argv, '--host');
  const execTimeoutRaw = argValue(argv, '--exec-timeout');
  const execTimeout = execTimeoutRaw !== undefined ? Number(execTimeoutRaw) : undefined;
  const profile = argValue(argv, '--profile');
  const systemFile = argValue(argv, '--system-file');
  const temperatureRaw = argValue(argv, '--temperature');
  const maxChainStepsRaw = argValue(argv, '--max-chain-steps');
  const maxBufferBytesRaw = argValue(argv, '--max-buffer-bytes');
  const outputMaxBytesRaw = argValue(argv, '--output-max-bytes');
  const contextCharsRaw = argValue(argv, '--context-chars');
  const stdinTimeoutMsRaw = argValue(argv, '--stdin-timeout-ms');
  const maxDelegationsRaw = argValue(argv, '--max-delegations');
  const delegationRepostRaw = argValue(argv, '--delegation-repost', '--delegation-repost-chars');
  const delegationMaxRoundsRaw = argValue(argv, '--delegation-max-rounds');
  const toTemperature = (raw: string | undefined): number | undefined => {
    // One interval rule owner (`@tell-ai/core`): the CLI tellrc parser and
    // this parser accept the same 0..2 span, undefined when invalid.
    if (raw === undefined) return undefined;
    return validate_temperature(raw);
  };
  const invalid: string[] = [];
  const limitValue = (raw: string | undefined, flag: string, key: string): number | undefined => {
    if (raw === undefined) return undefined;
    const value = validate_tellrc_limit_value(key, raw);
    if (value === undefined) {
      invalid.push(`${flag} has an invalid value "${raw}"`);
      return undefined;
    } else {
      return value;
    }
  };
  const maxChainSteps = limitValue(maxChainStepsRaw, '--max-chain-steps', 'max_chain_steps');
  const maxBufferBytes = limitValue(maxBufferBytesRaw, '--max-buffer-bytes', 'max_buffer_bytes');
  const outputMaxBytes = limitValue(outputMaxBytesRaw, '--output-max-bytes', 'output_max_bytes');
  const contextChars = limitValue(contextCharsRaw, '--context-chars', 'context_chars');
  const stdinTimeoutMs = limitValue(stdinTimeoutMsRaw, '--stdin-timeout-ms', 'stdin_timeout_ms');
  const maxDelegations = limitValue(maxDelegationsRaw, '--max-delegations', 'max_delegations');
  const delegationRepostChars = limitValue(delegationRepostRaw, '--delegation-repost', 'delegation_repost_chars');
  const delegationMaxRounds = limitValue(delegationMaxRoundsRaw, '--delegation-max-rounds', 'delegation_max_rounds');
  const temperature = toTemperature(temperatureRaw);
  if (temperatureRaw !== undefined && temperature === undefined) {
    invalid.push(`--temperature must be a number in 0..2 (got "${temperatureRaw}")`);
  } else {
    // Valid temperature or no flag.
  }
  const portNumber = portRaw === undefined ? undefined : Number(portRaw);
  const port =
    portNumber !== undefined && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
      ? portNumber
      : undefined;
  if (portRaw !== undefined && port === undefined) {
    invalid.push(`--port must be an integer in 1..65535 (got "${portRaw}")`);
  } else {
    // Valid port or no flag.
  }
  const conflict = hasTask && noExec ? 'error: --task cannot be combined with --no-exec' : null;
  const error_text = conflict ?? (invalid.length > 0 ? `error: invalid flag value: ${invalid.join('; ')}` : undefined);
  return {
    cwd: path.resolve(argCwd || defaultCwd),
    initialPrompt,
    autoExecute: yes && !noExec,
    noExec,
    model,
    profile,
    systemFile,
    temperature,
    maxChainSteps,
    maxBufferBytes,
    outputMaxBytes,
    contextChars,
    stdinTimeoutMs,
    maxDelegations,
    delegationRepostChars,
    delegationMaxRounds,
    chain,
    yes,
    requireApproval,
    task: taskRaw,
    taskReset,
    error: error_text,
    stream,
    think,
    port,
    host,
    execTimeout:
      execTimeout !== undefined && Number.isFinite(execTimeout)
        ? Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(MIN_EXEC_TIMEOUT_MS, Math.round(execTimeout)))
        : undefined,
    help: has(argv, '--help', '-h'),
  };
}

/**
 * Picks how the HTTP server serves the browser client.
 *
 * Development (`NODE_ENV=development`, `tsx src/server/server.ts`) needs the
 * Vite middleware. The published `tell-web` binary runs the built
 * `dist/server.js`; it must serve the static assets next to it even when the
 * host does not set `NODE_ENV` (the documented `tell-web --cwd <project>`
 * invocation does not). The presence of `dist/index.html` is the signal:
 * source runs have no built index beside the server file.
 *
 * @param options - `NODE_ENV` and whether `index.html` exists beside the server.
 * @returns `'vite'` for source/dev runs, `'static'` for built output.
 */
export function resolveAssetMode(options: {
  nodeEnv?: string | undefined;
  distIndexExists: boolean;
}): 'vite' | 'static' {
  if (options.nodeEnv === 'development') {
    return 'vite';
  } else if (options.nodeEnv === 'production' || options.distIndexExists) {
    return 'static';
  } else {
    return 'vite';
  }
}

export function printHelp(): void {
  console.log(`Tell Web — usage: tell [options]

Options:
  --cwd <path>      Working directory for the sandbox (default: current dir)
  --prompt <text>   Initial chat prompt
  -m, --model <id>  Model shortcode or full spec (default: TELL_MODEL env or "l")
  --profile <name>  Tellrc profile forwarded by the CLI (node, security, devops)
  --system-file <path>
                    File with custom instructions forwarded by the CLI (64 KB cap)
  --temperature <n>
                    Sampling temperature 0..2 forwarded by the CLI
  --max-chain-steps <n>
                    Limit override forwarded by the CLI
  --max-buffer-bytes <n>
                    Limit override forwarded by the CLI
  --output-max-bytes <n>
                    Delivered output cap bytes forwarded by the CLI
  --context-chars <n>
                    Limit override forwarded by the CLI
  --stdin-timeout-ms <n>
                    Limit override forwarded by the CLI
  --max-delegations <n>
                    Delegation budget 0..2 forwarded by the CLI (default: 2, 0 disables)
  --delegation-repost <n>
                    Delegation repost target 512..8192 forwarded by the CLI (default: 2048)
  --delegation-max-rounds <n>
                    Delegation round cap 0..128 forwarded by the CLI (default: 32)
  --port <number>   TCP port for the web server (default: PORT env or 3000)
  --host <address>  Bind address (default: 127.0.0.1; use 0.0.0.0 to expose on LAN)
  --exec-timeout <ms>
                    Per-command timeout in ms (default: 120000, max: 600000)
  -t, --task [ref]  Run one task (%id resume/create, or the initial prompt):
                    forces --chain, --require-approval and --stream (add -y to auto-run safe commands)
  --task-reset      Start the task context empty (the CLI forwards -n here)
  --chain           Continue after command output until the AI gives a final answer
  --stream          Seed the client's Stream toggle on the first visit, and keep
                    streaming as the server fallback for requests that omit the
                    "stream" field (Settings → Agent Runtime overrides per request)
  --think           Start reasoning headers expanded (collapsed by default)
  -y, --yes         Auto-confirm command execution
  --no-exec         Disable automatic execution of AI-generated commands
  --require-approval
                    Ask before running high-risk commands (server-enforced:
                    the server parks them on a pending approval showing the
                    risk reason; approve, skip or cancel from the confirm
                    card). Also seeds the Require Approval toggle on the
                    client's first visit. /api/execute still blocks
                    high-risk outright (stateless clients cannot confirm).
  -h, --help        Show this help
`);
}
