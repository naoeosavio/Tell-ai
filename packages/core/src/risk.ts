import { classify_script } from './permission';
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
  /**
   * When true the pattern is tested against the dequoted compacted script
   * (shell quote splicing, e.g. `cat '.en'v` reads `.env`).
   */
  dequoted?: boolean;
  /**
   * When true, `find` path-predicate arguments are removed before the match.
   * A nested hidden-path exclusion selects paths; it never reads a file.
   */
  ignore_find_path_arguments?: boolean;
  /** When true the rule only applies to the strict (Web) profile. */
  strict_only?: boolean;
  /** When true the rule only applies to the permissive (CLI) profile. */
  permissive_only?: boolean;
};

/** Wording and category behind one permission family (the old texts live on). */
type FamilyMeta = {
  /** Severity shown for this family (`forbidden` maps to `high`). */
  severity: Exclude<RiskSeverity, 'low'>;
  /** Observable category for this family. */
  category: RiskCategory;
  /** Human-readable reason recorded when this family matches. */
  reason: string;
  /** Machine flags recorded when this family matches. */
  flags: string[];
};

/**
 * One owner for the wording: every permission rule id maps to the severity,
 * category, reason and flags the old base rules used. `forbidden` has no
 * `RiskSeverity`, so it maps to `high` (still the top of the old scale).
 */
const FAMILY_META: Record<string, FamilyMeta> = {
  'medium-write': {
    severity: 'medium',
    category: 'general',
    reason: 'local reversible write (mkdir/touch/cp/mv/tee/sed -i)',
    flags: ['local-write'],
  },
  'medium-vcs': {
    severity: 'medium',
    category: 'general',
    reason: 'reversible version-control write (add/commit/pull/push)',
    flags: ['vcs-write'],
  },
  'medium-install': {
    severity: 'medium',
    category: 'general',
    reason: 'registry package install (postinstall runs code)',
    flags: ['install'],
  },
  'medium-network-read': {
    severity: 'medium',
    category: 'network-download',
    reason: 'network read without upload (curl/wget GET)',
    flags: ['network-client'],
  },
  'medium-process': {
    severity: 'medium',
    category: 'environment-escape',
    reason: 'process environment readout (env/printenv/export)',
    flags: ['env-launch'],
  },
  'medium-eval': {
    severity: 'medium',
    category: 'interpreter-eval',
    reason: 'interpreter eval with clean code',
    flags: ['interpreter-eval'],
  },
  'medium-unknown': {
    severity: 'medium',
    category: 'general',
    reason: 'unlisted command (default medium)',
    flags: [],
  },
  'medium-outside-read': {
    severity: 'medium',
    category: 'general',
    reason: 'read outside the working directory',
    flags: ['outside-cwd'],
  },
  'high-destructive': {
    severity: 'high',
    category: 'destructive',
    reason: 'destructive or history-rewriting command (rm -rf/reset/push --force)',
    flags: ['destructive'],
  },
  'high-network-write': {
    severity: 'high',
    category: 'network-download',
    reason: 'network upload or remote copy (curl -d/scp/rsync)',
    flags: ['network-client', 'upload'],
  },
  'high-privilege': {
    severity: 'high',
    category: 'privilege-escalation',
    reason: 'privilege escalation wrapper (sudo/doas/pkexec) or system control (systemctl/crontab/kill/ssh)',
    flags: ['sudo'],
  },
  'high-container': {
    severity: 'high',
    category: 'destructive',
    reason: 'container state change (docker run/prune/push)',
    flags: ['destructive'],
  },
  'high-publish': {
    severity: 'high',
    category: 'general',
    reason: 'package publish to a registry (npm publish)',
    flags: ['publish'],
  },
  'high-orchestrator': {
    severity: 'high',
    category: 'destructive',
    reason: 'shared infrastructure change (kubectl/terraform/aws)',
    flags: ['destructive'],
  },
  'high-remote-install': {
    severity: 'high',
    category: 'network-download',
    reason: 'remote code install (pip git+/https)',
    flags: ['install', 'network-client'],
  },
  'high-system': {
    severity: 'high',
    category: 'destructive',
    reason: 'low-level system state change (truncate/LD_PRELOAD)',
    flags: ['destructive'],
  },
  'high-proc-access': {
    severity: 'high',
    category: 'process-info',
    reason: 'proc filesystem access (/proc)',
    flags: ['proc-access'],
  },
  'high-shell-string': {
    severity: 'high',
    category: 'shell-expansion',
    reason: 'explicit shell command string (sh -c hides statements)',
    flags: ['shell-command-string'],
  },
  'high-outside-write': {
    severity: 'high',
    category: 'general',
    reason: 'write outside the working directory',
    flags: ['outside-cwd'],
  },
  'opaque-parse': {
    severity: 'high',
    category: 'shell-expansion',
    reason: 'opaque shell parse (unterminated quote/heredoc)',
    flags: ['opaque-parse'],
  },
  'forbidden-credential': {
    severity: 'high',
    category: 'data-exfiltration',
    reason: 'credential or secret file named (env/keys/.git/.tell)',
    flags: ['sensitive-file'],
  },
  'forbidden-exfil': {
    severity: 'high',
    category: 'data-exfiltration',
    reason: 'exfiltration tool or reverse shell (nc/socat//dev/tcp/bash -i)',
    flags: ['network-client', 'exfil'],
  },
  'forbidden-remote-code': {
    severity: 'high',
    category: 'network-download',
    reason: 'remote code into a shell (curl | sh/process substitution)',
    flags: ['pipe-to-shell', 'network-client'],
  },
  'forbidden-eval': {
    severity: 'high',
    category: 'interpreter-eval',
    reason: 'interpreter eval touching network/decode/exec primitives',
    flags: ['interpreter-eval', 'network-client'],
  },
  'forbidden-privileged-container': {
    severity: 'high',
    category: 'destructive',
    reason: 'privileged container or host-root mount (escape)',
    flags: ['destructive'],
  },
  'forbidden-destroy': {
    severity: 'high',
    category: 'destructive',
    reason: 'operating-system destruction (rm -rf //mkfs/shutdown/dd)',
    flags: ['destructive'],
  },
  'forbidden-system-write': {
    severity: 'high',
    category: 'privileged-write',
    reason: 'write into a privileged system path',
    flags: ['privileged-path'],
  },
  'strict-system-read': {
    severity: 'high',
    category: 'data-exfiltration',
    reason: 'read of a world-sensitive system path (/etc, /boot)',
    flags: ['privileged-path', 'system-read'],
  },
};

/** Fallback wording when a rule id has no family entry (never expected). */
const UNKNOWN_FAMILY_META: FamilyMeta = {
  severity: 'medium',
  category: 'general',
  reason: 'matched base risk rule',
  flags: [],
};

/**
 * Classifies one script with the permission table (no verdict).
 *
 * The permission module owns the single rule table now: this port maps its
 * class to the old severity scale so logs, timelines and tests keep their
 * wording. `low` stays non-risky; `medium` stays non-risky (it asks in base
 * and runs with `-y`, exactly like the old safe set); `high` and
 * `forbidden` stay risky. The `strict` profile adds the Web-only system
 * reads through the permission `strict` flag.
 *
 * @param script - Command script to classify.
 * @param profile - `permissive` (CLI) or `strict` (Web).
 * @returns The base `RiskAssessment` (never an action verdict).
 */
export function assess_base_risk(script: string, profile: RiskProfile = DEFAULT_RISK_PROFILE): RiskAssessment {
  const found = classify_script(script, { strict: profile === 'strict' });
  if (found.class === 'low') {
    return { risky: false, severity: 'low', category: 'general', reasons: [], flags: [], rules: [] };
  }
  if (found.class === 'medium') {
    const meta = FAMILY_META[found.rule] ?? UNKNOWN_FAMILY_META;
    return {
      risky: false,
      reason: meta.reason,
      severity: 'medium',
      category: meta.category,
      reasons: [meta.reason],
      flags: meta.flags,
      rules: [found.rule],
    };
  }
  const meta = FAMILY_META[found.rule] ?? UNKNOWN_FAMILY_META;
  return {
    risky: true,
    reason: meta.reason,
    severity: meta.severity,
    category: meta.category,
    reasons: [meta.reason],
    flags: meta.flags,
    rules: [found.rule],
  };
}

/**
 * Creates a `RiskPort` backed by the permission table for one profile.
 *
 * The port only observes (it is injected into `createTellRuntime` and
 * `create_core_runtime`); the verdict lives in `permission.ts`.
 *
 * @param profile - `permissive` (CLI) or `strict` (Web).
 * @returns A `RiskPort` assessing through the permission table.
 */
export function create_base_risk_port(profile: RiskProfile = DEFAULT_RISK_PROFILE): RiskPort {
  return {
    assess(script: string): RiskAssessment {
      return assess_base_risk(script, profile);
    },
  };
}
