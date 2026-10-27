import type { RiskAssessment, RiskCategory, RiskPort, RiskSeverity } from './runtime-api';

/** Base risk profile: `permissive` mirrors the CLI, `strict` mirrors the Web. */
export type RiskProfile = 'permissive' | 'strict';

/** Default profile for `assess_base_risk` (CLI behavior, local one-liners pass). */
export const DEFAULT_RISK_PROFILE: RiskProfile = 'permissive';

/** One observable base rule (pattern match, never a verdict). */
export type RiskRule = {
  /** Stable rule id used as flag and reason prefix. */
  id: string;
  /** Observable category for this rule. */
  category: RiskCategory;
  /** Severity contributed when this rule matches. */
  severity: RiskSeverity;
  /** Human-readable reason recorded when this rule matches. */
  reason: string;
  /** Machine flags recorded when this rule matches. */
  flags: string[];
  /** Pattern tested against the compacted script. */
  pattern: RegExp;
  /** When true the rule only applies to the strict (Web) profile. */
  strict_only?: boolean;
  /** When true the rule only applies to the permissive (CLI) profile. */
  permissive_only?: boolean;
};

// Privileged filesystem roots shared by the CLI and Web guards.
const PRIVILEGED_PATH = [
  String.raw`(?:/(?:etc|boot|dev|proc|sys|usr|bin|sbin|lib|lib64)(?:\b|/)|`,
  String.raw`/(?:var/(?:spool/cron|cron)|etc/cron(?:\.(?:d|daily|hourly|monthly|weekly))?)(?:\b|/)|`,
  String.raw`(?:~|\$HOME)/(?:\.config/(?:autostart|systemd/user)|\.local/share/systemd/user)(?:\b|/))`,
].join('');

/**
 * Base rules observed in `packages/cli/src/Tell.ts` and
 * `packages/web/src/server/guards.ts`.
 *
 * Common rules run in both profiles. `permissive_only` rules are CLI
 * divergences kept verbatim (broad download pipes, process substitution,
 * network-gated interpreter eval, non-recursive privileged chmod). The
 * `strict_only` rules are Web divergences kept verbatim (any interpreter
 * eval, bare `env`, `base64 -d`, shell expansions).
 *
 * The two profiles differ on purpose, but the strict one must never be
 * *laxer* about an interpreter eval: every `-c`/`-e`/`-r`/`eval` form the
 * permissive profile flags as `interpreter-eval` is flagged by the strict
 * profile too (the strict rule covers php/lua/deno/bun as well).
 */
const BASE_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'privilege-escalation',
    category: 'privilege-escalation',
    severity: 'high',
    reason: 'privilege escalation wrapper (sudo/doas/pkexec)',
    flags: ['sudo'],
    pattern: /\b(?:sudo|doas|pkexec)\b/,
  },
  {
    id: 'shell-command-string',
    category: 'shell-expansion',
    severity: 'high',
    reason: 'explicit shell command string (sh -c)',
    flags: ['shell-command-string'],
    pattern: /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?(?:ba|z|da|k)?sh\b[^;&|]*\s-c(?:\s|$)/,
  },
  {
    id: 'network-client',
    category: 'network-download',
    severity: 'high',
    reason: 'network client (curl/wget/nc/ssh/ftp)',
    flags: ['network-client'],
    pattern: /(?:^|[;&|(){}<>]\s*)(?:[^\s;&|()]*\/)?(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp)\b/,
  },
  {
    id: 'process-info-printenv',
    category: 'process-info',
    severity: 'medium',
    reason: 'process environment readout (printenv)',
    flags: ['process-info'],
    pattern: /(?:^|[;&|(){}<>]\s*)(?:[^\s;&|()]*\/)?printenv\b/,
  },
  {
    id: 'proc-access',
    category: 'process-info',
    severity: 'high',
    reason: 'proc filesystem access (/proc)',
    flags: ['proc-access'],
    pattern: /\/proc(?:\/|\b)/,
  },
  {
    id: 'destructive-rm',
    category: 'destructive',
    severity: 'high',
    reason: 'recursive/forced remove (rm -rf)',
    flags: ['destructive'],
    pattern: /\brm(?:\s|\$\{[^}]*\})*(?:-[^\s]*[rRfF][^\s]*)(?:\s|$)/,
  },
  {
    id: 'destructive-git-clean',
    category: 'destructive',
    severity: 'high',
    reason: 'forced git clean',
    flags: ['destructive'],
    pattern: /\bgit\s+clean\b[^;&|]*(?:--force\b|-[^-][^\s]*[fdx])/,
  },
  {
    id: 'destructive-system',
    category: 'destructive',
    severity: 'high',
    reason: 'system destructive tool (mkfs/shutdown/reboot)',
    flags: ['destructive'],
    pattern: /\b(?:mkfs|shutdown|reboot)\b/,
  },
  {
    id: 'destructive-dd',
    category: 'destructive',
    severity: 'high',
    reason: 'raw disk write (dd of=)',
    flags: ['destructive'],
    pattern: /\bdd\b.*\bof=/,
  },
  {
    id: 'destructive-chmod-recursive',
    category: 'destructive',
    severity: 'high',
    reason: 'recursive ownership/permission change on /',
    flags: ['destructive'],
    pattern: /\b(chmod|chown)\s+-R\b.*\s\/(?:\s|$)/,
  },
  {
    id: 'persistence-scheduler',
    category: 'persistence',
    severity: 'high',
    reason: 'scheduler persistence (crontab/systemd enable)',
    flags: ['persistence'],
    pattern: /(?:^|[\s;&|])(?:crontab|systemctl\s+--user\s+enable)\b/,
  },
  {
    id: 'privileged-write-copy',
    category: 'privileged-write',
    severity: 'high',
    reason: 'copy/move/link into a privileged path',
    flags: ['privileged-path'],
    pattern: new RegExp(String.raw`(?:^|[\s;&|])(?:cp|mv|ln)\b[^;&|]*\s["']?${PRIVILEGED_PATH}`),
  },
  {
    id: 'privileged-write-sed',
    category: 'privileged-write',
    severity: 'high',
    reason: 'in-place edit of a privileged path (sed -i)',
    flags: ['privileged-path'],
    pattern: new RegExp(String.raw`(?:^|[\s;&|])sed\b[^;&|]*\s-i[^\s;&|]*[^;&|]*\s["']?${PRIVILEGED_PATH}`),
  },
  {
    id: 'privileged-write-tee',
    category: 'privileged-write',
    severity: 'high',
    reason: 'tee into a privileged path',
    flags: ['privileged-path'],
    pattern: new RegExp(String.raw`(?:^|[\s;&|])tee\b[^;&|]*\s["']?${PRIVILEGED_PATH}`),
  },
  {
    id: 'privileged-write-redirect',
    category: 'privileged-write',
    severity: 'high',
    reason: 'shell redirect into a privileged path',
    flags: ['privileged-path'],
    pattern: new RegExp(String.raw`(?:^|[\s;&|])\d*(?:>>?|>\||&>)\s*["']?${PRIVILEGED_PATH}`),
  },
  {
    id: 'privileged-chmod-direct',
    category: 'privileged-write',
    severity: 'high',
    reason: 'permission/ownership change on a privileged path',
    flags: ['privileged-path'],
    pattern: new RegExp(String.raw`\b(?:chmod|chown)\b[^;&|]*\s["']?${PRIVILEGED_PATH}`),
    permissive_only: true,
  },
  {
    id: 'download-pipe-interpreter',
    category: 'network-download',
    severity: 'high',
    reason: 'download piped into an interpreter/shell',
    flags: ['pipe-to-shell', 'network-client'],
    pattern: /(?:curl|wget|base64)\b[^|;&]*\|\s*(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|php|node)\b/,
    permissive_only: true,
  },
  {
    id: 'download-process-substitution',
    category: 'network-download',
    severity: 'high',
    reason: 'process substitution feeding a download',
    flags: ['process-substitution', 'network-client'],
    pattern: /<\(\s*(?:curl|wget|base64)\b/,
    permissive_only: true,
  },
  {
    id: 'shell-process-substitution',
    category: 'shell-expansion',
    severity: 'high',
    reason: 'shell reading process substitution',
    flags: ['process-substitution'],
    pattern: /(?:^|[\s;&|])(?:ba|z|da|k)?sh\b[^;&|]*<\(/,
    permissive_only: true,
  },
  {
    id: 'interpreter-network-eval',
    category: 'interpreter-eval',
    severity: 'high',
    reason: 'interpreter eval touching network/decode/exec primitives',
    flags: ['interpreter-eval', 'network-client'],
    pattern:
      /(?:^|[\s;&|])(?:node|deno|bun|python3?|perl|ruby|php|lua)\b[^;&|]*\s-{1,2}(?:e|c|r|eval|exec|command)\b[^;&|]*(?:https?:\/\/|require\(\s*['"]https?|import\(\s*['"]https?|urllib|requests\.|ftplib|socket|base64|eval\(|exec\(|system\(|popen\()/,
    permissive_only: true,
  },
  {
    id: 'download-chained-interpreter',
    category: 'network-download',
    severity: 'high',
    reason: 'download chained into an interpreter',
    flags: ['network-client', 'interpreter-eval'],
    pattern: /(?:curl|wget|base64)\b[^;&|]*[;&|]\s*(?:node|python3?|perl|ruby|php)\b/,
    permissive_only: true,
  },
  {
    id: 'download-pipe-shell-narrow',
    category: 'network-download',
    severity: 'high',
    reason: 'download piped into sh',
    flags: ['pipe-to-shell', 'network-client'],
    pattern: /(?:curl|wget)\b[^|;&]*\|\s*(?:ba)?sh\b/,
    strict_only: true,
  },
  {
    id: 'strict-interpreter-eval',
    category: 'interpreter-eval',
    severity: 'high',
    reason: 'interpreter eval flag (-c/-e/-r/--eval)',
    flags: ['interpreter-eval'],
    pattern: /\b(?:python3?|node|deno|bun|perl|ruby|php|lua)\b[^;&|]*\s(?:-c|-e|-r|--eval|eval)\b/,
    strict_only: true,
  },
  {
    id: 'strict-env-launch',
    category: 'environment-escape',
    severity: 'medium',
    reason: 'env used to launch commands',
    flags: ['env-launch'],
    pattern: /(?:^|[;&|(){}<>]\s*)(?:[^\s;&|()]*\/)?env\b/,
    strict_only: true,
  },
  {
    id: 'strict-base64-decode',
    category: 'payload-decode',
    severity: 'medium',
    reason: 'payload de-obfuscation (base64 -d)',
    flags: ['base64-decode'],
    pattern: /\bbase64\s+(?:-[a-zA-Z]+\s+)*(?:-d\b|--decode\b)/,
    strict_only: true,
  },
  {
    id: 'strict-shell-brace-expansion',
    category: 'shell-expansion',
    severity: 'medium',
    reason: 'shell brace expansion (${...})',
    flags: ['shell-expansion'],
    pattern: /\$\{[^}]*\}/,
    strict_only: true,
  },
  {
    id: 'strict-shell-substitution',
    category: 'shell-expansion',
    severity: 'medium',
    reason: 'shell command substitution ($(...))',
    flags: ['shell-expansion'],
    pattern: /\$\([^)]*\)/,
    strict_only: true,
  },
  {
    id: 'strict-sensitive-file',
    category: 'data-exfiltration',
    severity: 'high',
    reason: 'credential or secret file named (env/keys/tokens/.git/.tell)',
    flags: ['sensitive-file'],
    // A command that names a credential file can send it to the model
    // provider: the file API and delegated research already deny these.
    // `.env.example` is a committed template and stays allowed.
    pattern:
      /(?:^|[\s"'=:;|&<>()/])(?:\.env(?!\.example)(?:\.[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:key|pem|p12)|\.git\/[\w./-]+|\.tell\/[\w./-]+|\.aws\/credentials|\.config\/[\w.-]*\.token)(?=$|[\s"'=:;|&<>()/])/i,
    strict_only: true,
  },
  {
    id: 'strict-shell-backtick-pipe',
    category: 'shell-expansion',
    severity: 'medium',
    reason: 'backtick pipeline substitution',
    flags: ['shell-expansion'],
    pattern: /`[^`]*\|[^`]*`/,
    strict_only: true,
  },
];

/**
 * Compacts a script the same way the CLI/Web guards do (line
 * continuations become spaces, whitespace collapses, ends trimmed).
 *
 * @param script - Raw command script.
 * @returns The compacted script tested against every rule.
 */
function compact_script(script: string): string {
  return script.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Ranks severities so the highest match wins (`high` beats `medium`).
 *
 * @param severity - Candidate severity.
 * @returns Numeric rank for comparison.
 */
function severity_rank(severity: RiskSeverity): number {
  if (severity === 'high') {
    return 2;
  } else if (severity === 'medium') {
    return 1;
  } else {
    return 0;
  }
}

/**
 * Classifies one script with the observable base rules (no verdict).
 *
 * The union of CLI/Web patterns is split by profile: common rules always
 * run, `permissive` adds the CLI-only divergences (broad pipes, process
 * substitution, network-gated eval, direct privileged chmod) and `strict`
 * adds the Web-only divergences (any interpreter eval, `env`,
 * `base64 -d`, shell expansions). The result carries only severity,
 * category, reasons and flags.
 *
 * @param script - Command script to classify.
 * @param profile - `permissive` (CLI) or `strict` (Web).
 * @returns The base `RiskAssessment` (never an action verdict).
 */
export function assess_base_risk(script: string, profile: RiskProfile = DEFAULT_RISK_PROFILE): RiskAssessment {
  const compact = compact_script(script);
  const reasons: string[] = [];
  const flags: string[] = [];
  let severity: RiskSeverity = 'low';
  let category: RiskCategory = 'general';
  let matched = false;

  for (const rule of BASE_RISK_RULES) {
    if (rule.strict_only === true && profile !== 'strict') {
    } else if (rule.permissive_only === true && profile !== 'permissive') {
    } else if (rule.pattern.test(compact)) {
      matched = true;
      reasons.push(rule.reason);
      for (const flag of rule.flags) {
        if (flags.includes(flag)) {
        } else {
          flags.push(flag);
        }
      }
      if (severity_rank(rule.severity) > severity_rank(severity)) {
        severity = rule.severity;
        category = rule.category;
      } else {
        // Keep the highest-severity category already recorded.
      }
    } else {
      // Rule did not match — nothing to record.
    }
  }

  if (matched) {
    const first_reason = reasons[0] ?? 'matched base risk rule';
    return { risky: true, reason: first_reason, severity, category, reasons, flags };
  } else {
    return { risky: false, severity: 'low', category: 'general', reasons: [], flags: [] };
  }
}

/**
 * Creates a `RiskPort` backed by the base classifier for one profile.
 *
 * The port only observes (it is injected into `createTellRuntime` and
 * `create_core_runtime`); the future policy engine turns the assessment
 * into a verdict elsewhere.
 *
 * @param profile - `permissive` (CLI) or `strict` (Web).
 * @returns A `RiskPort` assessing through `assess_base_risk`.
 */
export function create_base_risk_port(profile: RiskProfile = DEFAULT_RISK_PROFILE): RiskPort {
  return {
    assess(script: string): RiskAssessment {
      return assess_base_risk(script, profile);
    },
  };
}
