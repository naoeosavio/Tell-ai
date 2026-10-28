import path from 'path';

import { DELEGATION_MAX_DELEGATIONS, MAX_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS } from '@tell-ai/core';

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
  // Task mode forces the chain and the execution contract; the conflict is a
  // boot error, never a silent deny.
  const chain = hasTask || has(argv, '--chain');
  const yes = hasTask || has(argv, '-y', '--yes');
  const requireApproval = hasTask || has(argv, '--require-approval');
  const stream = hasTask || has(argv, '--stream');
  const think = has(argv, '--think');
  const portRaw = argValue(argv, '--port');
  const port = portRaw !== undefined ? Number(portRaw) : undefined;
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
  const toPositiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Math.floor(Number(raw));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const toDelegations = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 0 || value > DELEGATION_MAX_DELEGATIONS) return undefined;
    return value;
  };
  const toRepostChars = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 512 || value > 8 * 1024) return undefined;
    return value;
  };
  const toDelegationRounds = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 0 || value > 128) return undefined;
    return value;
  };
  const toTemperature = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
  };
  return {
    cwd: path.resolve(argCwd || defaultCwd),
    initialPrompt,
    autoExecute: yes && !noExec,
    noExec,
    model,
    profile,
    systemFile,
    temperature: toTemperature(temperatureRaw),
    maxChainSteps: toPositiveInt(maxChainStepsRaw),
    maxBufferBytes: toPositiveInt(maxBufferBytesRaw),
    outputMaxBytes: toPositiveInt(outputMaxBytesRaw),
    contextChars: toPositiveInt(contextCharsRaw),
    stdinTimeoutMs: toPositiveInt(stdinTimeoutMsRaw),
    maxDelegations: toDelegations(maxDelegationsRaw),
    delegationRepostChars: toRepostChars(delegationRepostRaw),
    delegationMaxRounds: toDelegationRounds(delegationMaxRoundsRaw),
    chain,
    yes,
    requireApproval,
    task: taskRaw,
    taskReset,
    error: hasTask && noExec ? 'error: --task cannot be combined with --no-exec' : undefined,
    stream,
    think,
    port: port !== undefined && Number.isFinite(port) && port > 0 ? port : undefined,
    host,
    execTimeout:
      execTimeout !== undefined && Number.isFinite(execTimeout)
        ? Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(MIN_EXEC_TIMEOUT_MS, Math.round(execTimeout)))
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
                    forces --chain, -y, --require-approval and --stream
  --task-reset      Start the task context empty (the CLI forwards -n here)
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
