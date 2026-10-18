import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const PARALLEL_SEARCH_MCP_URL = 'https://search.parallel.ai/mcp';
export const SEARCH_TIMEOUT_MS = 30_000;

export interface SearchContext {
  sessionId?: string;
  modelName?: string;
  abortSignal?: AbortSignal;
}

const searchResponse = z.object({
  results: z.array(
    z.object({
      url: z.url().refine((url) => /^https?:\/\//i.test(url), 'Expected an HTTP(S) source URL'),
      title: z.string().nullable().optional(),
      publish_date: z.string().nullable().optional(),
      excerpts: z.array(z.string()),
    }),
  ),
});

export async function searchParallelMcp(
  queries: string[],
  options: SearchContext & { maxResults?: number; startDates?: (string | null)[]; topics?: string[] },
) {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error('Parallel Search MCP timed out after 30 seconds')),
    SEARCH_TIMEOUT_MS,
  );
  const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout.signal]) : timeout.signal;
  const client = new Client({ name: 'scira', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_SEARCH_MCP_URL), {
    requestInit: { headers: { 'User-Agent': 'Scira/0.1.0' }, redirect: 'error' },
    // Cover initialization, discovery and response-body reads as well as tools/call.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  });

  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal });
    const definitions = await client.listTools({}, { signal });
    if (!definitions.tools.some((definition) => definition.name === 'web_search')) {
      throw new Error('Parallel Search MCP does not expose web_search');
    }
    const guidance = queries.map((query, index) => {
      const date = options.startDates?.[index] ?? options.startDates?.[0];
      const topic = options.topics?.[index] ?? options.topics?.[0];
      return `${query}${topic === 'news' ? ' (news)' : ''}${date ? ` (prefer sources published after ${date})` : ''}`;
    });
    const response = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: 'web_search',
          arguments: {
            objective: guidance.join('; '),
            search_queries: queries,
            ...(options.sessionId ? { session_id: options.sessionId } : {}),
            ...(options.modelName ? { model_name: options.modelName } : {}),
          },
        },
        undefined,
        { signal, timeout: SEARCH_TIMEOUT_MS },
      ),
    );
    if (response.isError) {
      const message = response.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      throw new Error(`Parallel Search MCP: ${message || 'search failed'}`);
    }
    const text = response.content.find((item) => item.type === 'text');
    const payload = response.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : null);
    const parsed = searchResponse.parse(payload);
    signal.throwIfAborted();
    const limit = Math.min(20, Math.max(1, options.maxResults ?? 10));
    return {
      searches: [
        {
          query: queries.join(' / '),
          results: parsed.results.slice(0, limit).map((result) => ({
            url: result.url,
            title: result.title || result.url,
            content: result.excerpts.join('\n').slice(0, 5000),
            published_date: result.publish_date || undefined,
            author: undefined,
          })),
          images: [],
        },
      ],
    };
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}
