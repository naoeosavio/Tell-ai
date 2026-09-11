const TARGETS: Record<string, { base: string; envKey: string }> = {
  openai: { base: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
  anthropic: { base: 'https://api.anthropic.com/v1', envKey: 'ANTHROPIC_API_KEY' },
  deepseek: { base: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
  xai: { base: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com/v1beta', envKey: 'GOOGLE_API_KEY' },
  cerebras: { base: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY' },
  moonshotai: { base: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOTAI_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' },
};

const HOP_BY_HOP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function cors(req: Request): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.get('origin') ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
    vary: 'Origin',
  };
}

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });

    const files: Record<string, string> = {
      '/': '/examples/web/index.html',
      '/index.html': '/examples/web/index.html',
      '/browser.js': '/packages/sdk/dist/browser.js',
      '/browser-global.global.js': '/packages/sdk/dist/browser-global.global.js',
    };
    const static_file = files[url.pathname];
    if (static_file) {
      return new Response(Bun.file(`${import.meta.dir}/../..${static_file}`), {
        headers: { 'cache-control': 'no-store' },
      });
    }

    const [, vendor, ...rest] = url.pathname.split('/');
    const target = TARGETS[vendor ?? ''];
    if (!target) return new Response(`Unknown vendor: ${vendor ?? ''}`, { status: 404, headers: cors(req) });

    const target_url = `${target.base}/${rest.join('/')}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set('host', new URL(target.base).host);
    const server_key = Bun.env[target.envKey];
    if (vendor === 'google') {
      const client_key = headers.get('x-goog-api-key');
      if (
        server_key &&
        (!client_key || client_key === 'undefined' || client_key === 'null' || client_key === 'proxy')
      ) {
        headers.set('x-goog-api-key', server_key);
      }
    } else {
      const authorization = headers.get('authorization');
      if (server_key && (!authorization || authorization === 'Bearer undefined' || authorization === 'Bearer null')) {
        headers.set('authorization', `Bearer ${server_key}`);
      }
    }

    const upstream = await fetch(target_url, { method: req.method, headers, body: req.body });
    const response_headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) response_headers[key] = value;
    });
    return new Response(upstream.body, { status: upstream.status, headers: { ...cors(req), ...response_headers } });
  },
});

console.log(
  `tell web proxy on http://localhost:${server.port} — use e.g. urls: { openai: 'http://localhost:${server.port}/openai' }`,
);
