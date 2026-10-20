// test-fuzz-coverage.js
//
// Property-based ("fuzz") coverage for the pure surfaces of `@tell-ai/sdk`
// and `@tell-ai/core`, plus differential comparison against the CLI/Web
// hosts that consume them.
//
// Techniques used here:
//
//   * seeded generation — a deterministic PRNG (mulberry32) drives every
//     generator, so a failure is reproducible from the printed seed;
//   * invariant checking — a property that must hold for *every* generated
//     input, not one hand-written case;
//   * differential comparison — the implementation under test is compared
//     against an independent reference written inside this file (and, for the
//     Web/CLI hosts, against the core owner they are supposed to delegate to);
//   * reduction — a failing input is shrunk with delta debugging until it no
//     longer shrinks, so the report carries a minimal reproducer.
//
// Run with: node --test test/test-fuzz-coverage.js (after the sdk + core build).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { describe, it } = require('node:test');
const vm = require('node:vm');

const sdk = require('../packages/sdk/dist/index.cjs');
const core = require('../packages/core/dist/index.cjs');

const REPO = path.join(__dirname, '..');
const CORE_CJS = path.join(REPO, 'packages', 'core', 'dist', 'index.cjs');
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-fuzz-'));
/** Compiled TypeScript files, keyed by their source path. */
const compiled_files = new Map();

// ---------------------------------------------------------------------------
// Fuzz harness
// ---------------------------------------------------------------------------

/** Seeds used by the property runs (printed on failure for reproduction). */
const FUZZ_SEEDS = [0x5eed, 0xc0ffee, 0x1337, 0xdecafbad, 0x42, 0x7fffffff];

/**
 * Creates a deterministic PRNG (mulberry32).
 *
 * @param {number} seed - Initial state.
 * @returns {() => number} Generator returning floats in `[0, 1)`.
 */
function create_prng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks one element of a list.
 *
 * @param {() => number} rng - PRNG.
 * @param {unknown[]} items - Candidate list.
 * @returns {unknown} The chosen element.
 */
function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

/** Characters used by the text generator (ASCII + unicode + control). */
const TEXT_ALPHABET = 'abcXY 0123\n\t<>/=&|;:"\'`$*!?#{}[]()\\-_.,~%@^é😀中';

/** Word corpus used by the script generator. */
const SCRIPT_WORDS = [
  'ls',
  'rm',
  '-rf',
  '/',
  'curl',
  'wget',
  'ssh',
  'echo',
  'env',
  'php',
  'lua',
  'deno',
  'bun',
  'node',
  'python3',
  '-e',
  '-r',
  'system(',
  'base64',
  '-d',
  'sudo',
  'mkfs',
  'crontab',
  '${IFS}',
  '$(id)',
  '`id`',
  '&&',
  ';',
  '|',
  'cat',
  '/etc/passwd',
  '../etc/shadow',
  '~/.ssh/id_rsa',
  'git',
  'commit',
  '-m',
  'ssh support',
  'npm',
  'run',
  'env:prod',
];

/** Tag fragments used by the tag generator. */
const TAG_FRAGMENTS = [
  '<RUN>',
  '</RUN>',
  '<run>',
  '</run>',
  '<think>',
  '</think>',
  '```bash',
  '```',
  'echo hi',
  'ls -la',
  'text',
  '\n',
];

/**
 * Generates random text from the shared alphabet.
 *
 * @param {() => number} rng - PRNG.
 * @param {number} max_length - Maximum number of characters.
 * @returns {string} The generated text.
 */
function random_text(rng, max_length = 48) {
  const length = Math.floor(rng() * (max_length + 1));
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += TEXT_ALPHABET[Math.floor(rng() * TEXT_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates a random shell-like script.
 *
 * @param {() => number} rng - PRNG.
 * @returns {string} The generated script.
 */
function random_script(rng) {
  const count = 1 + Math.floor(rng() * 8);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(String(pick(rng, SCRIPT_WORDS)));
  }
  return parts.join(' ');
}

/**
 * Generates random text mixed with tag fragments.
 *
 * @param {() => number} rng - PRNG.
 * @returns {string} The generated text.
 */
function random_tag_text(rng) {
  const count = 1 + Math.floor(rng() * 10);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(String(pick(rng, TAG_FRAGMENTS)));
    if (rng() < 0.4) parts.push(random_text(rng, 12));
  }
  return parts.join('');
}

/**
 * Generates a random path-like string.
 *
 * @param {() => number} rng - PRNG.
 * @returns {string} The generated path.
 */
function random_path(rng) {
  const pieces = ['..', '.', 'a', 'b', '..foo', '...', 'x.txt', 'dir', 'file name', 'sub'];
  const count = 1 + Math.floor(rng() * 4);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(String(pick(rng, pieces)));
  }
  const joined = parts.join('/');
  return rng() < 0.3 ? `/${joined}` : joined;
}

/** Values a limit layer may legally receive (valid and invalid alike). */
const LIMIT_VALUES = [
  0,
  1,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  1e21,
  '0',
  '007',
  '12 ',
  ' 12',
  'abc',
  '0x10',
  '+5',
  '-5',
  '1e21',
  '1.5',
  '',
  '   ',
  '999999999999999999999999',
  null,
  undefined,
  true,
  {},
];

/**
 * Shrinks a string with delta debugging until it stops failing.
 *
 * @param {string} input - Failing input.
 * @param {(candidate: string) => boolean} still_fails - Failure predicate.
 * @returns {string} The minimal failing input.
 */
function shrink_string(input, still_fails) {
  let best = input;
  let granularity = 2;
  while (best.length > 1) {
    const chunk = Math.ceil(best.length / granularity);
    let reduced = false;
    for (let start = 0; start < best.length; start += chunk) {
      const candidate = best.slice(0, start) + best.slice(start + chunk);
      if (candidate.length === 0) continue;
      if (still_fails(candidate)) {
        best = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= best.length) break;
      granularity = Math.min(best.length, granularity * 2);
    }
  }
  return best;
}

/**
 * Shrinks an arbitrary value (string or array) to a minimal failing shape.
 *
 * @param {unknown} input - Failing input.
 * @param {(candidate: unknown) => boolean} still_fails - Failure predicate.
 * @returns {unknown} The minimal failing input.
 */
function shrink_value(input, still_fails) {
  if (typeof input === 'string') {
    return shrink_string(input, still_fails);
  }
  if (Array.isArray(input)) {
    let best = input.slice();
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < best.length; index += 1) {
        const candidate = best.slice(0, index).concat(best.slice(index + 1));
        if (candidate.length === 0) continue;
        if (still_fails(candidate)) {
          best = candidate;
          changed = true;
          break;
        }
      }
    }
    for (let index = 0; index < best.length; index += 1) {
      const element = best[index];
      if (typeof element !== 'string') continue;
      const shrunk = shrink_string(element, (candidate) =>
        still_fails(best.slice(0, index).concat([candidate]).concat(best.slice(index + 1))),
      );
      best = best.slice(0, index).concat([shrunk]).concat(best.slice(index + 1));
    }
    return best;
  }
  return input;
}

/**
 * Runs a property over many generated inputs, reducing the first failure.
 *
 * @param {object} options - Property options.
 * @param {string} options.name - Property name (used in the failure message).
 * @param {number} options.seed - PRNG seed.
 * @param {number} options.iterations - Number of generated inputs.
 * @param {() => number} options.rng - Fresh PRNG for the run.
 * @param {(rng: () => number, index: number) => unknown} options.generate - Input generator.
 * @param {(input: unknown) => string | null} options.check - Returns a failure message or null.
 */
function run_property(options) {
  const { name, seed, iterations, rng, generate, check } = options;
  for (let index = 0; index < iterations; index += 1) {
    const input = generate(rng, index);
    const failure = check(input);
    if (failure !== null) {
      const minimal = shrink_value(input, (candidate) => check(candidate) !== null);
      throw new assert.AssertionError({
        message: `${name}: ${failure}\nseed=0x${seed.toString(16)} iteration=${index}\nminimal input=${JSON.stringify(minimal)}`,
      });
    }
  }
}

/**
 * Runs one property across every fuzz seed.
 *
 * @param {object} options - Property options (without `rng`/`seed`).
 */
function run_property_over_seeds(options) {
  for (const seed of FUZZ_SEEDS) {
    run_property({ ...options, seed, rng: create_prng(seed) });
  }
}

// ---------------------------------------------------------------------------
// TypeScript source loader (CLI/Web hosts, compiled on the fly)
// ---------------------------------------------------------------------------

/**
 * Compiles a TypeScript source file to CommonJS and returns the compiled path.
 *
 * Bare `@tell-ai/*` specifiers are rewritten to the built workspace packages
 * so the loader never depends on the caller's resolution root; relative
 * imports are compiled and rewritten in place.
 *
 * @param {string} absolute_path - Absolute path of the `.ts` file.
 * @returns {string} The path of the compiled CommonJS file.
 */
function compile_typescript_file(absolute_path) {
  if (compiled_files.has(absolute_path)) return compiled_files.get(absolute_path);
  const source = fs.readFileSync(absolute_path, 'utf8');
  let js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  js = js.replace(
    /require\(["']@tell-ai\/core["']\)/g,
    `require(${JSON.stringify(CORE_CJS)})`,
  );
  js = js.replace(
    /require\(["']@tell-ai\/sdk["']\)/g,
    `require(${JSON.stringify(path.join(REPO, 'packages', 'sdk', 'dist', 'index.cjs'))})`,
  );
  js = js.replace(/require\(["'](\.[^"']+)["']\)/g, (_match, relative_path) => {
    let resolved = path.normalize(path.join(path.dirname(absolute_path), relative_path));
    if (!/\.[a-z]+$/i.test(resolved)) resolved += '.ts';
    return `require(${JSON.stringify(compile_typescript_file(resolved))})`;
  });
  const file = path.join(
    CACHE_DIR,
    `${path.basename(absolute_path, '.ts')}_${Buffer.from(absolute_path).toString('hex').slice(-8)}.cjs`,
  );
  fs.writeFileSync(file, js);
  compiled_files.set(absolute_path, file);
  return file;
}

/**
 * Loads a TypeScript source module (compiled on the fly).
 *
 * @param {string} absolute_path - Absolute path of the `.ts` file.
 * @returns {Record<string, unknown>} The loaded module.
 */
function load_typescript_module(absolute_path) {
  return require(compile_typescript_file(absolute_path));
}

const web_chain_store = load_typescript_module(
  path.join(REPO, 'packages', 'web', 'src', 'server', 'chain-store.ts'),
);
const web_guards = load_typescript_module(path.join(REPO, 'packages', 'web', 'src', 'server', 'guards.ts'));
const cli_tellrc = load_typescript_module(path.join(REPO, 'packages', 'cli', 'src', 'tellrc.ts'));
const cli_adapters = load_typescript_module(path.join(REPO, 'packages', 'cli', 'src', 'core-adapters.ts'));

// ---------------------------------------------------------------------------
// Reference implementations (differential comparison)
// ---------------------------------------------------------------------------

/**
 * Reference byte-budget truncation (independent of the core implementation).
 *
 * @param {string} text - Text to truncate.
 * @param {number} max_bytes - Byte budget.
 * @returns {string} The truncated text (never above the budget, no split UTF-8).
 */
function reference_truncate_bytes(text, max_bytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= max_bytes) return text;
  let cut = buffer.subarray(0, Math.max(0, max_bytes));
  while (cut.length > 0 && (cut[cut.length - 1] & 0xc0) === 0x80) cut = cut.subarray(0, cut.length - 1);
  if (cut.length > 0 && (cut[cut.length - 1] & 0xc0) === 0xc0) cut = cut.subarray(0, cut.length - 1);
  return cut.toString('utf8');
}

/**
 * Reference run-block scanner (independent of the SDK implementation).
 *
 * A block ends at the **last** closing tag before the next opening tag, so a
 * command whose body contains the literal `</RUN>` is not truncated, and an
 * opening tag without a closer of its own asks for no command.
 *
 * @param {string} text - Model answer.
 * @returns {string[]} The command bodies (trimmed, non-empty).
 */
function reference_run_blocks(text) {
  const lower = text.toLowerCase();
  const blocks = [];
  let cursor = 0;
  for (;;) {
    const open = lower.indexOf('<run>', cursor);
    if (open === -1) break;
    const body_start = open + '<run>'.length;
    const next_open = lower.indexOf('<run>', body_start);
    const limit = next_open === -1 ? text.length : next_open;
    const close = lower.lastIndexOf('</run>', limit - 1);
    if (close === -1 || close < body_start) {
      cursor = body_start;
      continue;
    }
    const body = text.slice(body_start, close).trim();
    if (body.length > 0) blocks.push(body);
    cursor = close + '</run>'.length;
  }
  return blocks;
}

/**
 * Reference turn splitter (independent of the core implementation).
 *
 * Mirrors the documented contract of the core owner: a turn starts at a
 * `User:`/`Assistant:` line, an `Executed command:` line, a `Command failed`
 * record, a `Command cancelled:` line, a generic `Command <status>:` line, a
 * `Skipped by user:` line or a `Command execution disabled` line.
 *
 * @param {string} text - Conversation text.
 * @returns {string[]} The atomic turns.
 */
function reference_split_turns(text) {
  const marker =
    /^(?:User|Assistant):\s*$|^Executed command:\s*$|^Command failed|^Command cancelled:\s*$|^Command [a-z_]+:\s*$|^Skipped by user:\s*$|^Command execution disabled/;
  const lines = text.split('\n');
  const turns = [];
  let current = [];
  for (const line of lines) {
    if (marker.test(line) && current.length > 0) {
      turns.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) turns.push(current.join('\n'));
  return turns.filter((turn) => turn.trim() !== '');
}

/**
 * Loads the browser bundle in a sandbox without `Buffer` and `process`.
 *
 * @returns {Record<string, unknown>} The exported API of the browser entry.
 */
function load_browser_bundle() {
  const bundle = fs.readFileSync(path.join(REPO, 'packages', 'core', 'dist', 'browser.js'), 'utf8');
  const export_match = bundle.match(/export\{([^}]*)\};?\s*$/);
  assert.ok(export_match !== null, 'the browser bundle must end with an export statement');
  const entries = export_match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split(/\s+as\s+/);
      return parts.length === 2 ? [parts[1], parts[0]] : [parts[0], parts[0]];
    });
  const rewritten = bundle.replace(/export\{[^}]*\};?\s*$/, `globalThis.TellCore={${entries
    .map(([name, local]) => `${JSON.stringify(name)}:${local}`)
    .join(',')}};`);
  const sandbox = vm.createContext({ console, TextEncoder, TextDecoder, URL, fetch, setTimeout, clearTimeout });
  vm.runInContext(rewritten, sandbox);
  return sandbox.TellCore;
}

// ---------------------------------------------------------------------------
// SDK: model specs
// ---------------------------------------------------------------------------

describe('fuzz/sdk: resolve_model_spec never crashes on hostile input', () => {
  it('rejects any input with a clean error (no TypeError from property access)', () => {
    run_property_over_seeds({
      name: 'resolve_model_spec must not throw a TypeError',
      iterations: 400,
      generate: (rng) => (rng() < 0.5 ? random_text(rng) : random_script(rng)),
      check: (input) => {
        try {
          const spec = sdk.resolve_model_spec(String(input));
          if (typeof spec !== 'object' || spec === null) return 'spec is not an object';
          if (typeof spec.vendor !== 'string' || typeof spec.model !== 'string') return 'spec fields are not strings';
          return null;
        } catch (error) {
          if (error instanceof TypeError) return `TypeError leaked: ${error.message}`;
          if (error instanceof Error && /is not a function/.test(error.message)) return `opaque error: ${error.message}`;
          return null;
        }
      },
    });
  });

  it('treats Object.prototype keys as unknown aliases', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      let failed_cleanly = false;
      try {
        sdk.resolve_model_spec(key);
      } catch (error) {
        failed_cleanly = !(error instanceof TypeError) && !/is not a function/.test(error.message);
      }
      assert.strictEqual(failed_cleanly, true, `${key} must raise a clean "unknown alias" error`);
    }
  });

  it('keeps every alias in the table resolvable and round-trips', () => {
    const entries = Object.entries(sdk.MODELS);
    assert.ok(entries.length > 0, 'the model table must not be empty');
    for (const [alias, target] of entries) {
      const spec = sdk.resolve_model_spec(alias);
      const [vendor, model] = target.split(':');
      assert.strictEqual(spec.vendor, vendor, `alias ${alias} must resolve to ${vendor}`);
      assert.strictEqual(spec.model, model, `alias ${alias} must resolve to ${model}`);
    }
  });

  it('keeps the dot prefix in front of the model slot', () => {
    const fast = sdk.resolve_model_spec('.g');
    assert.strictEqual(fast.fast, true, 'a dotted alias is fast mode');
    const custom = sdk.resolve_model_spec('custom:.kimi-k3');
    assert.strictEqual(custom.fast, true, 'a dotted model id is fast mode');
    assert.strictEqual(custom.model, 'kimi-k3', 'the dot must not leak into the model id');
  });

  it('expands an alias even when the thinking slot is unknown', () => {
    const spec = sdk.resolve_model_spec('openai:g:bogus');
    const target = sdk.MODELS.g.split(':')[1];
    assert.ok(spec.model.startsWith(target), `expected ${target} inside ${spec.model}`);
  });
});

// ---------------------------------------------------------------------------
// SDK: tags
// ---------------------------------------------------------------------------

describe('fuzz/sdk: tag extraction invariants', () => {
  it('extracts every run block and hides every run block', () => {
    run_property_over_seeds({
      name: 'extract_runs must return one script per block',
      iterations: 300,
      generate: (rng) => random_tag_text(rng),
      check: (input) => {
        const text = String(input);
        // Fenced blocks are documentation, never commands (SDK contract), so
        // the reference counts the blocks of the fence-stripped text.
        const sanitized = sdk.strip_markdown_code_blocks(text);
        const blocks = reference_run_blocks(sanitized);
        const result = sdk.extract_runs(text);
        if (result.scripts.length !== blocks.length) {
          return `expected ${blocks.length} scripts, got ${result.scripts.length}`;
        }
        // A complete run block must never survive in the visible text (an
        // unterminated `<RUN>` is prose, not a block).
        if (/<RUN>[\s\S]*?<\/RUN>/i.test(result.visible)) return 'the visible text still carries a run block';
        for (const script of result.scripts) {
          if (typeof script !== 'string' || script.trim() === '') return 'empty script extracted';
        }
        return null;
      },
    });
  });

  it('does not truncate a command that contains a literal closing tag', () => {
    const result = sdk.extract_runs('<RUN>echo "</RUN>"</RUN>');
    assert.strictEqual(result.scripts.length, 1);
    assert.strictEqual(result.scripts[0], 'echo "</RUN>"');
  });

  it('strips think blocks symmetrically', () => {
    run_property_over_seeds({
      name: 'strip_think_tags must remove every balanced block',
      iterations: 300,
      generate: (rng) => random_tag_text(rng),
      check: (input) => {
        const stripped = sdk.strip_think_tags(String(input));
        // Only a balanced block counts — an unterminated `<think>` is prose.
        if (/<think>[\s\S]*?<\/think>/i.test(stripped)) return 'a think block survived the strip';
        return null;
      },
    });
  });

  it('agrees with the reference on the visible text', () => {
    const text = 'before <RUN>ls</RUN> middle <RUN>pwd</RUN> after';
    assert.strictEqual(sdk.strip_run_tags(text).trim(), sdk.extract_runs(text).visible);
  });
});

// ---------------------------------------------------------------------------
// Core: runtime limits
// ---------------------------------------------------------------------------

describe('fuzz/core: truncation respects its budget', () => {
  it('keeps the delivered output inside the byte budget', () => {
    run_property_over_seeds({
      name: 'truncate_output must stay inside the byte budget',
      iterations: 400,
      generate: (rng) => {
        const size = Math.floor(rng() * 4000);
        const chunk = String(pick(rng, ['a', '😀', 'é', '漢字', '<RUN>']));
        return { text: chunk.repeat(size), max_bytes: Math.floor(rng() * 4096) };
      },
      check: (input) => {
        const { text, max_bytes } = input;
        const result = core.truncate_output(text, max_bytes);
        const bytes = Buffer.byteLength(result, 'utf8');
        if (bytes > max_bytes) return `output is ${bytes} bytes, budget is ${max_bytes}`;
        return null;
      },
    });
  });

  it('never delivers more than a reference byte truncation', () => {
    for (const max_bytes of [0, 1, 16, 64, 1024, 204_800]) {
      const text = 'a😀b漢字c'.repeat(500);
      const result = core.truncate_output(text, max_bytes);
      assert.ok(
        Buffer.byteLength(result, 'utf8') <= max_bytes,
        `truncate_output(${max_bytes}) returned ${Buffer.byteLength(result, 'utf8')} bytes`,
      );
      assert.ok(
        result.length <= reference_truncate_bytes(text, max_bytes).length + 64,
        'the delivered text must stay close to the reference cut',
      );
    }
  });

  it('keeps the conversation context inside the character budget', () => {
    run_property_over_seeds({
      name: 'truncate_context must stay inside the character budget',
      iterations: 300,
      generate: (rng) => ({
        text: random_tag_text(rng).repeat(1 + Math.floor(rng() * 40)),
        max_chars: Math.floor(rng() * 4096),
      }),
      check: (input) => {
        const { text, max_chars } = input;
        const result = core.truncate_context(text, max_chars);
        if (result.length > max_chars) return `context is ${result.length} chars, budget is ${max_chars}`;
        return null;
      },
    });
  });

  it('never splits a think or run block while truncating', () => {
    for (const max_chars of [16, 128, 1024, 4096]) {
      const text = `User:\n${'x'.repeat(500)}\n<think>${'y'.repeat(500)}</think>\nAssistant:\n${'z'.repeat(500)}`;
      const result = core.truncate_context(text, max_chars);
      assert.strictEqual(core.has_balanced_tags(result), true, `unbalanced tags after truncate_context(${max_chars})`);
    }
  });

  it('splits turns exactly like the reference implementation', () => {
    run_property_over_seeds({
      name: 'split_context_turns must match the reference',
      iterations: 300,
      generate: (rng) => {
        const headers = ['User:', 'Assistant:', 'Executed command:', 'Command failed', 'Command cancelled', 'text', ''];
        const count = 1 + Math.floor(rng() * 8);
        const lines = [];
        for (let index = 0; index < count; index += 1) {
          lines.push(String(pick(rng, headers)));
          lines.push(random_text(rng, 20));
        }
        return lines.join('\n');
      },
      check: (input) => {
        const text = String(input);
        const actual = core.split_context_turns(text);
        const expected = reference_split_turns(text);
        if (actual.length !== expected.length) return `expected ${expected.length} turns, got ${actual.length}`;
        for (let index = 0; index < expected.length; index += 1) {
          if (actual[index] !== expected[index]) return `turn ${index} differs`;
        }
        return null;
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Core: limits parsing
// ---------------------------------------------------------------------------

describe('fuzz/core: limit parsing never leaks a raw TypeError', () => {
  it('raises a RuntimeLimitError (or succeeds) for every hostile limit value', () => {
    run_property_over_seeds({
      name: 'parse_runtime_limits must fail with RuntimeLimitError only',
      iterations: 500,
      generate: (rng) => ({
        flags: { context_max_chars: pick(rng, LIMIT_VALUES) },
        env: {},
        project: { source: 'proj', limits: {} },
        user: { source: 'user', limits: {} },
      }),
      check: (input) => {
        try {
          core.parse_runtime_limits(input);
          return null;
        } catch (error) {
          if (error instanceof core.RuntimeLimitError) return null;
          return `unexpected ${error.constructor.name}: ${error.message}`;
        }
      },
    });
  });

  it('survives a tellrc layer without a limits object', () => {
    let failure = null;
    try {
      core.parse_runtime_limits({ project: { source: 'proj' } });
    } catch (error) {
      failure = `${error.constructor.name}: ${error.message}`;
    }
    assert.strictEqual(failure, null, 'a tellrc layer without limits must not crash');
  });

  it('still validates an explicit stdin timeout when the no-timeout modifier is on', () => {
    let failure = null;
    try {
      core.parse_runtime_limits({ flags: { no_stdin_timeout: true, stdin_timeout_ms: 'abc' } });
    } catch (error) {
      failure = error instanceof core.RuntimeLimitError ? 'RuntimeLimitError' : error.constructor.name;
    }
    assert.strictEqual(failure, 'RuntimeLimitError', 'an invalid explicit flag must fail');
  });

  it('keeps the precedence order across every layer', () => {
    const layers = (winner) => ({
      flags: { max_chain_steps: winner === 'flag' ? 3 : undefined },
      env: { TELL_MAX_CHAIN_STEPS: winner === 'env' ? '5' : undefined },
      project: { source: 'proj', limits: { max_chain_steps: winner === 'project' ? 6 : undefined } },
      user: { source: 'user', limits: { max_chain_steps: winner === 'user' ? 7 : undefined } },
    });
    assert.strictEqual(core.parse_runtime_limits(layers('flag')).max_chain_steps, 3);
    assert.strictEqual(core.parse_runtime_limits(layers('env')).max_chain_steps, 5);
    assert.strictEqual(core.parse_runtime_limits(layers('project')).max_chain_steps, 6);
    assert.strictEqual(core.parse_runtime_limits(layers('user')).max_chain_steps, 7);
    assert.strictEqual(core.parse_runtime_limits(layers('default')).max_chain_steps, 8);
  });

  it('maps every limit into the execution options', () => {
    const limits = core.parse_runtime_limits({
      flags: { exec_timeout_ms: 5000, output_max_bytes: 4096, max_chain_steps: 2 },
    });
    const options = core.build_execution_options(limits);
    assert.strictEqual(options.timeout_ms, 5000);
    assert.strictEqual(options.max_output_bytes, 4096);
    assert.strictEqual(options.max_rounds, 2);
  });
});

// ---------------------------------------------------------------------------
// Core: risk
// ---------------------------------------------------------------------------

describe('fuzz/core: risk classification is total and ordered', () => {
  it('never throws for any generated script', () => {
    run_property_over_seeds({
      name: 'assess_base_risk must not throw',
      iterations: 600,
      generate: (rng) => random_script(rng),
      check: (input) => {
        for (const profile of ['permissive', 'strict']) {
          const assessment = core.assess_base_risk(String(input), profile);
          if (typeof assessment.risky !== 'boolean') return 'risky is not a boolean';
        }
        return null;
      },
    });
  });

  it('never lets the strict profile be laxer about an interpreter eval', () => {
    run_property_over_seeds({
      name: 'strict risk must cover every permissive interpreter-eval hit',
      iterations: 600,
      generate: (rng) => random_script(rng),
      check: (input) => {
        const script = String(input);
        const permissive = core.assess_base_risk(script, 'permissive');
        const strict = core.assess_base_risk(script, 'strict');
        if (permissive.category === 'interpreter-eval' && !strict.risky) {
          return `permissive flagged "${script}" (${permissive.reason}) but strict did not`;
        }
        return null;
      },
    });
  });

  it('flags every interpreter eval form in the strict profile', () => {
    for (const script of [
      'php -r "system(\'id\')"',
      'lua -e "os.execute(\'id\')"',
      'deno eval "console.log(1)"',
      'bun -e "console.log(1)"',
      'python3 -c "print(1)"',
      'node --eval "process.exit(0)"',
    ]) {
      assert.strictEqual(core.assess_base_risk(script, 'strict').risky, true, `${script} must be risky (strict)`);
    }
  });

  it('does not flag a bare word as a dangerous command', () => {
    for (const script of ['echo ssh', 'echo curl', 'git commit -m "ssh support"', 'npm run env:prod']) {
      const assessment = core.assess_base_risk(script, 'permissive');
      assert.strictEqual(assessment.risky, false, `"${script}" must not be flagged (${assessment.reason})`);
    }
  });

  it('flags an obfuscated recursive delete', () => {
    assert.strictEqual(core.assess_base_risk('rm${IFS}-rf /', 'permissive').risky, true);
  });
});

// ---------------------------------------------------------------------------
// Core: paths
// ---------------------------------------------------------------------------

describe('fuzz/core: path containment is fail-closed', () => {
  it('never resolves a path outside the base', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-fuzz-base-'));
    fs.writeFileSync(path.join(base, 'normal.txt'), 'ok');
    fs.writeFileSync(path.join(base, '..foo'), 'ok');
    run_property_over_seeds({
      name: 'canonical_path must stay inside the base',
      iterations: 400,
      generate: (rng) => random_path(rng),
      check: (input) => {
        const resolved = core.canonical_path(base, String(input));
        if (resolved === null || resolved === undefined) return null;
        const relative = path.relative(base, resolved);
        // Only a real `..` segment escapes the base (`..foo` is a regular name).
        const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        if (escapes) {
          return `"${input}" escaped the base (${resolved})`;
        }
        return null;
      },
    });
  });

  it('accepts a legitimate file whose name starts with two dots', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-fuzz-dots-'));
    fs.writeFileSync(path.join(base, '..foo'), 'ok');
    const resolved = core.canonical_path(base, '..foo');
    assert.strictEqual(resolved, path.join(base, '..foo'), '"..foo" is a regular name, not an escape');
  });
});

// ---------------------------------------------------------------------------
// Core: exec environment
// ---------------------------------------------------------------------------

describe('fuzz/core: the exec environment scrub is total', () => {
  it('never forwards a sensitive variable', () => {
    const env = {
      OPENAI_API_KEY: 'sk-1',
      AZURE_OPENAI_APIKEY: 'sk-2',
      my_api_key: 'sk-3',
      MY_TOKEN: 't',
      DB_PASSWORD: 'p',
      AWS_SECRET_ACCESS_KEY: 's',
      HOME: '/home/x',
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://u:p@h/db',
    };
    const sanitized = core.sanitize_exec_env(env);
    for (const name of Object.keys(sanitized)) {
      assert.ok(
        !core.SENSITIVE_ENV_NAMES.has(name) && !core.SENSITIVE_ENV_SUFFIX.test(name),
        `${name} must not reach the child process`,
      );
    }
    assert.strictEqual(sanitized.HOME, '/home/x', 'non-secret variables survive');
    assert.strictEqual(sanitized.PATH, '/usr/bin', 'non-secret variables survive');
  });

  it('keeps the redactor idempotent and harmless for short secrets', () => {
    const redactor = core.create_secret_redactor(['a', 'sk-1234567890']);
    const once = redactor('banana split sk-1234567890');
    assert.strictEqual(redactor(once), once, 'redaction must be idempotent');
    assert.ok(once.includes('sk-1234567890') === false, 'the long secret must be masked');
  });
});

// ---------------------------------------------------------------------------
// Core: configuration
// ---------------------------------------------------------------------------

describe('fuzz/core: a blank model never shadows the lower layers', () => {
  it('falls through to the next layer', () => {
    const resolved = core.resolve_core_config({
      host: 'cli',
      flag: { model: '   ' },
      env: { model: 'custom:foo' },
    });
    assert.strictEqual(resolved.model, 'custom:foo', 'a blank flag model must not win');
  });
});

// ---------------------------------------------------------------------------
// Core: browser entry
// ---------------------------------------------------------------------------

describe('fuzz/core: the browser entry has no node globals', () => {
  it('runs the exported helpers without Buffer and process', () => {
    const browser = load_browser_bundle();
    const truncated = browser.truncate_output('a'.repeat(1000), 100);
    assert.strictEqual(typeof truncated, 'string', 'truncate_output must work without Buffer');
    assert.ok(
      Buffer.byteLength(truncated, 'utf8') <= 100,
      'the browser truncation must respect the byte budget too',
    );
    const config = browser.resolve_core_config({ host: 'web', flag: {}, env: {} });
    assert.strictEqual(typeof config.model, 'string', 'resolve_core_config must work without process');
  });
});

// ---------------------------------------------------------------------------
// Web: chain store
// ---------------------------------------------------------------------------

describe('fuzz/web: the chain store stays bounded and idempotent', () => {
  it('reaps expired runs instead of growing forever', () => {
    let clock = 1_000_000;
    const store = web_chain_store.createChainStore({ ttlMs: 100, now: () => clock });
    for (let index = 0; index < 50; index += 1) {
      store.createRun([{ role: 'user', content: `hello ${index}` }]);
      clock += 1000;
    }
    assert.ok(store.size() <= 1, `expired runs must be reaped (size=${store.size()})`);
  });

  it('replays the same decision instead of running it twice', () => {
    const store = web_chain_store.createChainStore();
    const run = store.createRun([{ role: 'user', content: 'run ls' }]);
    const pending = store.requestApproval(run.runId, 'ls -la');
    assert.ok(pending !== null, 'the approval must be recorded');
    const first = store.tryBeginConfirm(run.runId, {
      decision_id: pending.decisionId,
      expected_version: pending.expectedVersion,
      decision: 'approve',
    });
    assert.strictEqual(first.ok, true, 'the first confirm must be accepted');
    store.finishConfirm(run.runId, pending.decisionId, {
      type: 'executed',
      script: 'ls -la',
      output: 'ok',
      status: 'completed',
    });
    const second = store.tryBeginConfirm(run.runId, {
      decision_id: pending.decisionId,
      expected_version: pending.expectedVersion,
      decision: 'approve',
    });
    assert.strictEqual(second.ok, true, 'the same decision must replay');
    const snapshot = store.getRun(run.runId);
    assert.strictEqual(
      snapshot.events.filter((event) => event.type === 'executed').length,
      1,
      'the command must run once',
    );
  });

  it('lets a cancel win over a pending approval', () => {
    const store = web_chain_store.createChainStore();
    const run = store.createRun([{ role: 'user', content: 'run ls' }]);
    const pending = store.requestApproval(run.runId, 'ls -la');
    assert.ok(pending !== null);
    store.cancelRun(run.runId);
    const gate = store.tryBeginConfirm(run.runId, {
      decision_id: pending.decisionId,
      expected_version: pending.expectedVersion,
      decision: 'approve',
    });
    assert.strictEqual(gate.ok, false, 'a cancelled run must not accept a decision');
  });
});

// ---------------------------------------------------------------------------
// Web vs core: differential risk comparison
// ---------------------------------------------------------------------------

describe('fuzz/web: the sandbox risk guard delegates to the core owner', () => {
  it('agrees with the core strict profile on every generated script', () => {
    run_property_over_seeds({
      name: 'web isHighRiskScript must equal the core strict profile',
      iterations: 600,
      generate: (rng) => random_script(rng),
      check: (input) => {
        const script = String(input);
        const web = web_guards.isHighRiskScript(script);
        const core_strict = core.assess_base_risk(script, 'strict').risky;
        if (web !== core_strict) {
          return `web=${web} core=${core_strict} for "${script}"`;
        }
        return null;
      },
    });
  });

  it('keeps the rate limiter bounded under a key flood', () => {
    const limiter = web_guards.createRateLimiter({ max: 5, windowMs: 60_000 });
    for (let index = 0; index < 12_000; index += 1) {
      limiter.check(`ip-${index}`);
    }
    assert.ok(limiter.size() <= 10_000, `the rate limiter must stay bounded (size=${limiter.size()})`);
  });
});

describe('fuzz/cli: the risk port delegates to the core owner', () => {
  it('agrees with the core permissive profile on every generated script', () => {
    run_property_over_seeds({
      name: 'cli is_high_risk_script must equal the core permissive profile',
      iterations: 600,
      generate: (rng) => random_script(rng),
      check: (input) => {
        const script = String(input);
        const cli = cli_adapters.is_high_risk_script(script);
        const core_permissive = core.assess_base_risk(script, 'permissive').risky;
        if (cli !== core_permissive) {
          return `cli=${cli} core=${core_permissive} for "${script}"`;
        }
        return null;
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CLI vs core: differential alias comparison
// ---------------------------------------------------------------------------

describe('fuzz/cli: the outside-cwd gate cannot be bypassed', () => {
  it('flags every outside path, whatever the operator wrote around it', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-fuzz-cwd-'));
    for (const script of [
      'cat /etc/passwd',
      'cat</etc/passwd',
      'tee</etc/evil',
      'cat >/tmp/evil',
      'rm -f</etc/passwd',
      'cat ${HOME}/.ssh/id_rsa',
    ]) {
      assert.strictEqual(
        cli_adapters.script_touches_outside_cwd(script, cwd),
        true,
        `"${script}" must be treated as an outside path`,
      );
    }
  });

  it('keeps an inside-cwd command untouched', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-fuzz-cwd-'));
    for (const script of ['ls -la', 'cat package.json', 'grep -rn curl src/', 'echo ssh']) {
      assert.strictEqual(
        cli_adapters.script_touches_outside_cwd(script, cwd),
        false,
        `"${script}" must stay inside the cwd`,
      );
    }
  });
});

describe('fuzz/cli: model aliases resolve without touching the prototype chain', () => {
  it('never returns an inherited object property as a model spec', () => {
    for (const key of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const resolved = cli_tellrc.resolve_model_input(key, {}, sdk.MODELS);
      assert.strictEqual(typeof resolved, 'string', `${key} must resolve to a string`);
    }
  });

  it('resolves a custom alias without inheriting anything', () => {
    const resolved = cli_tellrc.resolve_model_input('myalias', { myalias: 'openai:gpt-4o' }, sdk.MODELS);
    assert.strictEqual(resolved, 'openai:gpt-4o');
  });

  it('never returns an inherited property for a custom alias lookup', () => {
    const resolved = cli_tellrc.resolve_model_input('constructor', { safe: 'openai:gpt-4o' }, sdk.MODELS);
    assert.strictEqual(typeof resolved, 'string');
    assert.strictEqual(resolved.includes('function'), false, 'no function may leak into the model spec');
  });
});
