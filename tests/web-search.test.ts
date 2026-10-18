import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { resolveSearchProvider } from '../lib/search/search-provider';

// Real env validation, with unrelated application services isolated from developer keys.
const envSource = readFileSync(new URL('../env/server.ts', import.meta.url), 'utf8');
for (const key of envSource.matchAll(/^\s+(\w+): z\.string\(\)\.min\(1\)/gm)) process.env[key[1]] = 'test-only';
for (const key of ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'PARALLEL_API_KEY']) delete process.env[key];
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
const { loadConfiguredTools } = await import('../lib/search/tool-loader');
const { serverEnv } = await import('../env/server');
const { PARALLEL_SEARCH_MCP_URL } = await import('../lib/tools/parallel-search-mcp');

const queries = ['MCP protocol docs', 'MCP tools specification', 'MCP HTTP transport'];
const source = {
  url: 'https://modelcontextprotocol.io/docs',
  title: 'MCP docs',
  excerpts: ['MCP connects applications to tools.'],
};
const payload = { results: [source], session_id: 'fixture-session', search_id: 'fixture-search' };
const nativeFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit; rpc?: any }>;
let behavior:
  | 'normal'
  | 'text'
  | 'tool-error'
  | 'http-error'
  | 'malformed'
  | 'unsafe-url'
  | 'missing-tool'
  | 'hang'
  | 'hang-init';
let started: (() => void) | undefined;

beforeEach(() => {
  requests = [];
  behavior = 'normal';
  globalThis.fetch = async (url, init = {}) => {
    const rpc = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), init, rpc });
    if (
      (behavior === 'hang' && rpc?.method === 'tools/call') ||
      (behavior === 'hang-init' && rpc?.method === 'initialize')
    ) {
      started?.();
      return new Promise((_, reject) => {
        const abort = () => reject(init.signal?.reason);
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (!rpc?.id && rpc?.id !== 0) return new Response(null, { status: 202 });
    let result: any;
    if (rpc.method === 'initialize') {
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0' },
      };
    } else if (rpc.method === 'tools/list') {
      result = {
        tools:
          behavior === 'missing-tool' ? [] : [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }],
      };
    } else if (rpc.method === 'tools/call') {
      if (behavior === 'http-error') return new Response('Fixture service unavailable', { status: 503 });
      const data =
        behavior === 'malformed'
          ? { results: 'invalid' }
          : behavior === 'unsafe-url'
            ? { results: [{ ...source, url: 'javascript:alert(1)' }] }
            : payload;
      result = {
        content: [{ type: 'text', text: behavior === 'tool-error' ? 'Fixture quota exceeded' : JSON.stringify(data) }],
        ...(behavior === 'text' ? {} : { structuredContent: data }),
        ...(behavior === 'tool-error' ? { isError: true } : {}),
      };
    } else throw new Error(`Unexpected RPC ${rpc.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  started = undefined;
});

async function load(choice?: any, extra: Record<string, unknown> = {}) {
  return loadConfiguredTools({
    activeToolNames: ['web_search'],
    dataStream: undefined,
    searchProvider: choice,
    searchContext: { sessionId: 'scira-test-conversation', modelName: 'scripted-test-model' },
    timezone: undefined,
    contextFiles: [],
    extremeSearchModel: undefined,
    includeMcpTools: false,
    mcpDynamicTools: {},
    lightweightUser: null,
    selectedConnectors: undefined,
    ...extra,
  });
}
async function execute(choice?: any, extra: Record<string, unknown> = {}) {
  const tools = await load(choice, extra);
  return tools.web_search.execute({ queries }, { toolCallId: 'fixture-call', messages: [] });
}
function assertOwnedRequests() {
  for (const { url, init } of requests) {
    assert.equal(url, PARALLEL_SEARCH_MCP_URL);
    assert.match(new Headers(init.headers).get('User-Agent') || '', /^Scira\/0\.1\.0/);
    assert.equal(new Headers(init.headers).has('Authorization'), false);
  }
}

test('automatic resolves unconfigured, configured, saved and explicit choices', () => {
  assert.equal(serverEnv.EXA_API_KEY, undefined);
  assert.equal(serverEnv.FIRECRAWL_API_KEY, undefined);
  assert.equal(serverEnv.PARALLEL_API_KEY, undefined);
  assert.equal(resolveSearchProvider(undefined, {}), 'parallel-mcp');
  assert.equal(resolveSearchProvider('auto', { EXA_API_KEY: 'configured' }), 'exa');
  assert.equal(resolveSearchProvider('auto', { PARALLEL_API_KEY: 'configured' }), 'parallel');
  assert.equal(
    resolveSearchProvider('auto', { FIRECRAWL_API_KEY: 'configured', EXA_API_KEY: 'configured' }),
    'firecrawl',
  );
  assert.equal(resolveSearchProvider('auto', { EXA_API_KEY: '  ' }), 'parallel-mcp');
  for (const choice of ['exa', 'parallel', 'firecrawl', 'parallel-mcp'] as const) {
    assert.equal(resolveSearchProvider(choice, { FIRECRAWL_API_KEY: 'configured' }), choice);
  }
  assert.throws(() => resolveSearchProvider('invalid' as any, {}), /Unknown/);
});

test('configured credentials and saved overrides reach the selected strategy through the loader', () => {
  const script = `
    import assert from 'node:assert/strict';
    import Exa from 'exa-js';
    import Firecrawl from '@mendable/firecrawl-js';
    Exa.prototype.search = async () => ({ results: [{ url: 'https://exa.example/source', title: 'Exa fixture', highlights: ['Exa excerpt'] }] });
    Firecrawl.prototype.search = async () => ({ web: [{ url: 'https://firecrawl.example/source', title: 'Firecrawl fixture', description: 'Firecrawl excerpt' }], images: [] });
    const { loadConfiguredTools } = await import('./lib/search/tool-loader.ts');
    const tools = await loadConfiguredTools({ activeToolNames: ['web_search'], searchProvider: process.env.FIXTURE_CHOICE,
      contextFiles: [], includeMcpTools: false, mcpDynamicTools: {}, lightweightUser: null });
    const result = await tools.web_search.execute({ queries: ['one', 'two', 'three'] }, { toolCallId: 'configured', messages: [] });
    assert.equal(result.searches[0].results[0].url, process.env.FIXTURE_EXPECTED);
  `;
  for (const fixture of [
    {
      FIRECRAWL_API_KEY: 'fixture',
      EXA_API_KEY: 'fixture',
      FIXTURE_CHOICE: 'auto',
      FIXTURE_EXPECTED: 'https://firecrawl.example/source',
    },
    { EXA_API_KEY: 'fixture', FIXTURE_CHOICE: 'auto', FIXTURE_EXPECTED: 'https://exa.example/source' },
    {
      FIRECRAWL_API_KEY: 'fixture',
      EXA_API_KEY: 'fixture',
      FIXTURE_CHOICE: 'exa',
      FIXTURE_EXPECTED: 'https://exa.example/source',
    },
  ]) {
    const child = spawnSync(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', script],
      { env: { ...process.env, ...fixture }, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
  }
});

test('normal loader returns citable excerpts without credentials or image requests', async () => {
  const updates: any[] = [];
  const result = await execute(undefined, { dataStream: { write: (part: unknown) => updates.push(part) } });
  assert.equal(result.searches[0].results[0].url, source.url);
  assert.match(result.searches[0].results[0].content, /connects applications/);
  assert.deepEqual(result.searches[0].images, []);
  assert.deepEqual(
    updates.map((part) => part.data.status),
    ['started', 'completed'],
  );
  assert.equal(requests.filter((r) => r.rpc?.method === 'tools/call').length, 1);
  const call = requests.find((r) => r.rpc?.method === 'tools/call')!.rpc.params;
  assert.equal(call.name, 'web_search');
  assert.deepEqual(call.arguments.search_queries, queries);
  assert.equal(call.arguments.session_id, 'scira-test-conversation');
  assert.equal(call.arguments.model_name, 'scripted-test-model');
  assertOwnedRequests();
});

test('MCP JSON text responses and per-conversation session continuity', async () => {
  behavior = 'text';
  const tools = await load('parallel-mcp');
  for (let i = 0; i < 2; i++) {
    const result = await tools.web_search.execute(
      { queries, topics: ['news'], startDates: ['2026-01-01'], maxResults: [1] },
      { toolCallId: String(i), messages: [] },
    );
    assert.equal(result.searches[0].results.length, 1);
  }
  const calls = requests.filter((r) => r.rpc?.method === 'tools/call');
  assert.equal(calls[0].rpc.params.arguments.session_id, calls[1].rpc.params.arguments.session_id);
  assert.match(calls[0].rpc.params.arguments.objective, /prefer sources published after 2026-01-01/);
  assertOwnedRequests();
});

test('explicit providers with missing credentials do not fall back to anonymous search', async () => {
  for (const provider of ['exa', 'parallel', 'firecrawl']) {
    await assert.rejects(execute(provider), /requires .*API_KEY/);
  }
  assert.equal(requests.length, 0);
});

test('disabled web search and MCP permissions are enforced by the normal loader', async () => {
  const tools = await load('parallel-mcp', {
    activeToolNames: [],
    mcpDynamicTools: { injected: {} },
    includeMcpTools: false,
  });
  assert.equal(tools.web_search, undefined);
  assert.equal(tools.injected, undefined);
  assert.equal(requests.length, 0);
});

test('service, protocol, parsing and unsafe URL errors surface without provider fallback', async () => {
  for (const mode of ['tool-error', 'http-error', 'malformed', 'unsafe-url', 'missing-tool'] as const) {
    behavior = mode;
    await assert.rejects(execute());
  }
  assertOwnedRequests();
});

test('cancellation interrupts discovery and active searches', async () => {
  for (const mode of ['hang-init', 'hang'] as const) {
    behavior = mode;
    const controller = new AbortController();
    let ready!: () => void;
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    started = ready;
    const result = execute('parallel-mcp', { searchContext: { abortSignal: controller.signal } });
    await reached;
    controller.abort(new Error('User stopped search'));
    await assert.rejects(result, /User stopped search|aborted/i);
    assert.equal(
      requests.find((r) => r.rpc?.method === (mode === 'hang-init' ? 'initialize' : 'tools/call'))!.init.signal
        ?.aborted,
      true,
    );
  }
});

test('30-second deadline cancels an active request', async (t) => {
  behavior = 'hang';
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  started = ready;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = execute();
  await reached;
  t.mock.timers.tick(30_001);
  await assert.rejects(result, /timed out/i);
  assert.equal(requests.find((r) => r.rpc?.method === 'tools/call')!.init.signal?.aborted, true);
});

test('scripted model consumes the normal dispatched tool result before answering', async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls++;
      if (calls === 1)
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'search-1',
              toolName: 'web_search',
              input: JSON.stringify({ queries }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      const toolMessage = options.prompt.find((message) => message.role === 'tool');
      assert.ok(toolMessage);
      assert.match(JSON.stringify(toolMessage), /https:\/\/modelcontextprotocol.io\/docs/);
      assert.match(JSON.stringify(toolMessage), /connects applications to tools/);
      return {
        content: [{ type: 'text' as const, text: `MCP connects applications to tools. Source: ${source.url}` }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const result = await generateText({
    model,
    tools: await load(),
    prompt: 'What does MCP do?',
    stopWhen: stepCountIs(2),
  });
  assert.equal(calls, 2);
  assert.match(result.text, /https:\/\/modelcontextprotocol.io/);
  assertOwnedRequests();
});

test(
  'live anonymous search through the application loader',
  { skip: process.env.SCIRA_LIVE_SEARCH !== '1' },
  async () => {
    globalThis.fetch = (url, init = {}) => {
      requests.push({ url: String(url), init, rpc: init.body ? JSON.parse(String(init.body)) : undefined });
      return nativeFetch(url, init);
    };
    const result = await execute();
    assert.ok(result.searches[0].results.length > 0);
    assert.match(result.searches[0].results[0].url, /^https?:\/\//);
    assert.ok(result.searches[0].results[0].content.length > 0);
    assertOwnedRequests();
    console.log(
      JSON.stringify({
        liveSource: result.searches[0].results[0],
        methods: requests.map((r) => r.rpc?.method ?? r.init.method),
      }),
    );
  },
);
