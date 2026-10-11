# Limites de runtime (`task_037_runtime-limits.md`)

Owner único de limites operacionais e truncamento seguro: `packages/cli/src/runtime-limits.ts`
(`parse_runtime_limits`, `truncate_context`, `RuntimeLimits`, `ExecutionOptions`).
A memória, os adapters CLI/Web e o chat consomem esse contrato; o core possui
exclusivamente execução, loop e a state machine chain. Sem dependência de
tokenizer (`gpt-tokenizer` foi avaliado e descartado — bytes/chars apenas) e
sem monkey-patch de `process.stdout.write`.

## Tabela de limites

| Limite | Flag | Env | Default |
|---|---|---|---:|
| caracteres de contexto | `--context-max-chars` | `TELL_CONTEXT_MAX_CHARS` | 65.536 |
| timeout de stdin | `--stdin-timeout` / `--no-stdin-timeout` | `TELL_STDIN_TIMEOUT_MS` | 30.000 ms (`0` desliga) |
| bytes de stdin | `--stdin-max-bytes` | `TELL_STDIN_MAX_BYTES` | 1.048.576 |
| timeout de execução | `--exec-timeout` | `TELL_EXEC_TIMEOUT_MS` | 120.000 ms (máx. 600.000) |
| rodadas de chain | `--max-chain` | `TELL_MAX_CHAIN_STEPS` | 8 (faixa `1..128`) |
| buffer interno | `--max-buffer` | `TELL_MAX_BUFFER_BYTES` | 33.554.432 |
| saída entregue | `--output-max-bytes` | `TELL_OUTPUT_MAX_BYTES` | 204.800 |

Precedência: `flag > env > tellrc do projeto > tellrc do usuário > default`.
Flag/env inválidos falham com exit `2` **antes** de qualquer chamada ao modelo;
tellrc inválido falha de forma diagnosticável (com a origem no erro), nunca
caindo em silêncio para o default. O tellrc (`[limits]`) cobre as sete chaves
(`context_chars`, `stdin_timeout_ms`, `stdin_max_bytes`, `exec_timeout_ms`,
`max_chain_steps`, `max_buffer_bytes`, `output_max_bytes`) desde que
`task_036` passou a importar `TELLRC_LIMIT_KEYS` e `validate_tellrc_limit_value`
deste módulo: o parser não guarda tabela de faixa própria, então schema e
resolver não divergem (tabela de faixas em `docs/cli/tellrc.md`).

Exit codes: `0` ok · `1` uso/modelo (inalterado) · `2` limite inválido ·
`124` timeout (stdin ou execução) · `125` estouro de stdin.

## Antes / depois

### Stdin: erro engolido → erro identificável

Antes (`Tell.ts`): `read_stdin()` não tinha cap de bytes, não limpava
listeners em todos os caminhos, e o caller convertia qualquer falha em
prompt vazio:

```ts
const stdin_text = input.readStdin ? await read_stdin().catch(() => '') : '';
// timeout de 30 s sumia: exit 0 com prompt vazio, sem motivo
```

Depois: `read_stdin(limits)` conta bytes, impõe timeout + cap, limpa
timer/listeners em `end`/`error`/timeout/cap e rejeita com `StdinLimitError`
(`timeout` → `124`, `overflow` → `125`) antes de abrir modelo ou executar:

```bash
printf 'x%.0s' {1..2000} | tell -i --stdin-max-bytes 1024 --no-exec "oi"
# → "stdin exceeded 1024 bytes", exit=125

(sleep 2; echo oi) | tell -i --stdin-timeout 200 --no-exec "diga ok"
# → "stdin read timed out after 0.2s", exit=124

(sleep 2; echo oi) | tell -i --no-stdin-timeout --no-exec "diga ok"
# → espera os 2 s, lê e responde, exit=0 (o cap de bytes continua ativo)
```

### Contexto: corte cego → turnos atômicos

Antes (`Tell.ts`): um `slice` cortava no meio de turno ou tag:

```ts
return `[older context truncated]\n${text.slice(-MAX_CONTEXT_CHARS)}`;
```

Depois: `truncate_context` mantém turnos inteiros (`User:`/`Assistant:`/
resultados, dos mais novos para os mais velhos) com blocos `<think>`/`<RUN>`
equilibrados e marker explícito; um turno único maior que o orçamento é
cortado pela cauda em fronteira segura (sem fragmento `<` pendurado, sem
bloco aberto). O `summarize_context` existente continua como fallback.

```bash
tell --context-max-chars 8192 -c "lembre disso"
TELL_CONTEXT_MAX_CHARS=8192 tell -c "lembre disso"
```

### Executor e loop: constantes espalhadas → contrato injetado

Antes: `LOOP_MAX_ROUNDS` fixo, executor sem defaults, saída de comando sem
cap, `process.exitCode = 1` literal em 12 lugares, `1_048_576` duplicado.

Depois: `build_execution_options(limits)` alimenta timeout/buffer do executor
injetado, cap da saída entregue (com marker `[output truncated at N bytes]`)
e budget do chain (`--max-chain 1..128`, default 8 — o loop do core não impõe
teto, só piso 1); status via `EXIT_MODEL_ERROR`/`EXIT_CONFIG_ERROR`/
`EXIT_TIMEOUT`/`EXIT_LIMIT`; help derivado das constantes (fonte única).

```bash
tell --max-chain 99 "oi"   # agora VÁLIDO (faixa 1..128)
tell --max-chain 129 "oi"  # → "invalid max_chain_steps 129 ... (expected 1..128)", exit=2
tell --exec-timeout 5000 --chain "rode os testes"
tell --max-chain 3 --chain "corrija o build"
```

### Web: valores encaminhados ignorados → aplicados

Antes (`server.ts`): `maxBuffer: 32 * 1024 * 1024` hardcoded nos dois
caminhos de execução e chain travado em 8 com notice fixo — o
`FORWARDED_LIMITS` só aparecia no `/api/config`, sem efeito. E o
`tell --web` só encaminhava tellrc (flags sumiam em silêncio, `--exec-timeout`
nunca ia).

Depois: `EXEC_MAX_BUFFER` e `CHAIN_ROUND_CAP` (clamp `1..8` no sandbox) com
notice refletindo o cap efetivo; `tell --web` prefere flags/env explícitos
(`--max-chain/--max-buffer/--context-max-chars/--stdin-timeout/--exec-timeout`
+ `TELL_*`) sobre tellrc, e camada ausente continua ausente (server mantém
seus defaults), inclusive o `exec_timeout_ms` do tellrc (a flag sempre foi
encaminhada; a chave do arquivo entrou no schema depois). `/api/chain` e
approval seguem no chain store do core — nenhuma segunda chain no browser.

```bash
tell --web --max-chain 2 --exec-timeout 60000
curl localhost:3000/api/config  # → limits: {maxChainSteps: 2, ...}
```

Divergências conscientes: `--stdin-max-bytes`/`--output-max-bytes` são
CLI-only (web não tem stdin; saída usa o cap local de 200 KB com marker
`[truncated]`); deadline desligado é omitido (parser web descarta ≤ 0);
chain no sandbox fica em 8 mesmo com `--max-chain` maior (clamp, sem erro).

## Como rodar os testes

```bash
bun run test:runtime    # 35 checks: resolver, precedência, zero-timeout, 124/125, turnos/tags, wiring
bun run test:security && bun run test:context && bun run test:stream && bun run test:mentions
bun run test:cli-adapters  # defaults do executor, overrides por chamada
bun run test:web           # backend (parse/validação) + sandbox live (config/cap/timeout/round-cap)
bun run ci                 # build + lint + check + tudo
```

Fontes: `packages/cli/src/runtime-limits.ts`, `Tell.ts` (flags, stdin,
truncamento, loop, `launch_web`), `core-adapters.ts`
(`create_cli_executor(defaults)`), `packages/web/src/server/server.ts`
(`EXEC_MAX_BUFFER`, `CHAIN_ROUND_CAP`), `cli-args.ts` (parsing encaminhado).
