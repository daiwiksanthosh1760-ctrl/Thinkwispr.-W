export const SEARCH_PROVIDERS = ['auto', 'parallel-mcp', 'exa', 'parallel', 'firecrawl'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type ResolvedSearchProvider = Exclude<SearchProvider, 'auto'>;

export function resolveSearchProvider(
  choice: SearchProvider | undefined,
  credentials: { FIRECRAWL_API_KEY?: string; EXA_API_KEY?: string; PARALLEL_API_KEY?: string },
): ResolvedSearchProvider {
  if (choice && choice !== 'auto') {
    if (!SEARCH_PROVIDERS.includes(choice)) throw new Error('Unknown web search provider');
    return choice;
  }

  // Keep the chat's existing Firecrawl preference when it is configured.
  if (credentials.FIRECRAWL_API_KEY?.trim()) return 'firecrawl';
  if (credentials.EXA_API_KEY?.trim()) return 'exa';
  if (credentials.PARALLEL_API_KEY?.trim()) return 'parallel';
  return 'parallel-mcp';
}
