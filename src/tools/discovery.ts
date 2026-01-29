/**
 * x402 Discovery Tools
 *
 * Tools for discovering x402-enabled services proactively:
 * - wallet_discover_x402: Check if a domain supports x402
 * - wallet_browse_x402: Browse the x402 ecosystem catalog
 *
 * Discovery Protocol (from x402scan):
 * 1. Well-Known URL: GET /.well-known/x402
 * 2. DNS TXT Record: _x402.<domain>
 *
 * @see https://github.com/Merit-Systems/x402scan
 * @see https://x402.org/ecosystem
 */

import { resolve } from 'dns/promises';

/**
 * x402 Discovery Document schema
 */
interface X402DiscoveryDocument {
  version: number;
  resources: string[];
  ownershipProofs?: string[];
  instructions?: string;
}

/**
 * Result from checking a single resource
 */
interface ResourceInfo {
  url: string;
  available: boolean;
  price?: string;
  token?: string;
  description?: string;
  error?: string;
}

/**
 * Tool definition for wallet_discover_x402
 */
export const discoverToolDefinition = {
  name: 'wallet_discover_x402',
  description: `Check if a domain supports x402 payments and list available paid resources.

**How it works:**
1. Checks \`/.well-known/x402\` for a discovery document
2. Falls back to DNS TXT record at \`_x402.<domain>\`
3. Optionally probes each resource for pricing

**Discovery document format:**
\`\`\`json
{
  "version": 1,
  "resources": ["https://api.example.com/premium", "https://api.example.com/data"],
  "instructions": "Usage documentation..."
}
\`\`\`

**Example:**
\`\`\`json
{"domain": "api.example.com", "probeResources": true}
\`\`\`

Returns the list of x402-enabled endpoints and their pricing.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      domain: {
        type: 'string',
        description: 'Domain to check for x402 support (e.g., "api.example.com")',
      },
      probeResources: {
        type: 'boolean',
        default: false,
        description: 'If true, probe each resource to get current pricing (slower)',
      },
    },
    required: ['domain'],
  },
};

/**
 * Tool definition for wallet_browse_x402
 */
export const browseToolDefinition = {
  name: 'wallet_browse_x402',
  description: `Browse the x402 ecosystem to find paid API services.

**Categories:**
- \`ai\` - AI/ML APIs (image generation, LLMs, inference)
- \`data\` - Data feeds (news, social, market data)
- \`infra\` - Infrastructure (IPFS, scraping, storage)
- \`defi\` - DeFi APIs (portfolio, trading, analytics)
- \`all\` - Everything (default)

**Example:**
\`\`\`json
{"category": "ai", "search": "image generation"}
\`\`\`

Returns matching x402-enabled services with descriptions and links.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: ['ai', 'data', 'infra', 'defi', 'all'],
        default: 'all',
        description: 'Filter by service category',
      },
      search: {
        type: 'string',
        description: 'Search term to filter services',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Maximum number of results (default: 10)',
      },
    },
  },
};

/**
 * Known x402 services catalog
 * Curated from https://x402.org/ecosystem
 * TODO: In future, fetch dynamically from x402scan API
 */
const X402_CATALOG: Array<{
  name: string;
  url: string;
  description: string;
  category: 'ai' | 'data' | 'infra' | 'defi';
  tags: string[];
}> = [
  // AI Services
  {
    name: 'Imference',
    url: 'https://imference.com',
    description: 'Image generation API with pay-per-image pricing',
    category: 'ai',
    tags: ['image', 'generation', 'ai', 'diffusion'],
  },
  {
    name: 'AiMo Network',
    url: 'https://aimo.network',
    description: 'Permissionless pay-per-inference API for LLMs',
    category: 'ai',
    tags: ['llm', 'inference', 'ai', 'language'],
  },
  {
    name: 'BlockRun.AI',
    url: 'https://blockrun.ai',
    description: 'Multi-LLM gateway with service catalog',
    category: 'ai',
    tags: ['llm', 'gateway', 'multi-model', 'ai'],
  },
  {
    name: 'Genbase',
    url: 'https://genbase.fun',
    description: 'AI video platform with per-video payments',
    category: 'ai',
    tags: ['video', 'generation', 'ai'],
  },
  {
    name: 'Kodo',
    url: 'https://www.kodo.fun',
    description: 'AI creative toolkit for artists',
    category: 'ai',
    tags: ['creative', 'art', 'ai', 'tools'],
  },
  {
    name: 'Daydreams Router',
    url: 'https://router.daydreams.systems',
    description: 'LLM inference router with automatic model selection',
    category: 'ai',
    tags: ['llm', 'router', 'inference', 'ai'],
  },

  // Data Services
  {
    name: 'Firecrawl',
    url: 'https://firecrawl.dev',
    description: 'Web scraping optimized for LLM-ready data extraction',
    category: 'data',
    tags: ['scraping', 'web', 'data', 'llm'],
  },
  {
    name: 'Gloria AI',
    url: 'https://itsgloria.ai',
    description: 'Real-time news data feed for AI agents',
    category: 'data',
    tags: ['news', 'realtime', 'data', 'feed'],
  },
  {
    name: 'Neynar',
    url: 'https://neynar.com',
    description: 'Farcaster social data API',
    category: 'data',
    tags: ['farcaster', 'social', 'data', 'web3'],
  },
  {
    name: 'Minifetch',
    url: 'https://minifetch.com',
    description: 'Web metadata and content summaries API',
    category: 'data',
    tags: ['metadata', 'summaries', 'web', 'data'],
  },
  {
    name: 'Zyte API',
    url: 'https://python-zyte-api.readthedocs.io/en/stable/use/x402.html',
    description: 'Enterprise web scraping infrastructure',
    category: 'data',
    tags: ['scraping', 'enterprise', 'data', 'web'],
  },
  {
    name: 'QuickSilver',
    url: 'https://data.iotex.ai',
    description: 'Physical systems and IoT data bridge',
    category: 'data',
    tags: ['iot', 'physical', 'data', 'sensors'],
  },

  // Infrastructure
  {
    name: 'Pinata',
    url: 'https://402.pinata.cloud/',
    description: 'Account-free IPFS access with pay-per-pin',
    category: 'infra',
    tags: ['ipfs', 'storage', 'decentralized', 'pinning'],
  },
  {
    name: 'Proxy402',
    url: 'https://proxy402.com/',
    description: 'URL-based content paywall service',
    category: 'infra',
    tags: ['paywall', 'proxy', 'content', 'monetization'],
  },
  {
    name: 'AurraCloud',
    url: 'https://aurracloud.com/x402',
    description: 'AI agent hosting platform with pay-per-call',
    category: 'infra',
    tags: ['hosting', 'agents', 'cloud', 'compute'],
  },
  {
    name: 'SerenAI Gateway',
    url: 'https://serendb.com',
    description: 'Database query payment gateway',
    category: 'infra',
    tags: ['database', 'query', 'gateway', 'sql'],
  },
  {
    name: 'zkStash',
    url: 'https://zkstash.ai',
    description: 'Shared memory layer for AI agents',
    category: 'infra',
    tags: ['memory', 'agents', 'shared', 'state'],
  },

  // DeFi
  {
    name: 'Elsa x402',
    url: 'https://x402.heyelsa.ai',
    description: 'DeFi API endpoints with micropayments',
    category: 'defi',
    tags: ['defi', 'api', 'trading', 'data'],
  },
  {
    name: 'AdEx AURA',
    url: 'https://guide.adex.network/',
    description: 'Portfolio and DeFi data access API',
    category: 'defi',
    tags: ['portfolio', 'analytics', 'defi', 'data'],
  },
  {
    name: 'SLAMai',
    url: 'https://www.slamai.xyz/',
    description: 'Smart money intelligence and whale tracking',
    category: 'defi',
    tags: ['smart-money', 'whales', 'analytics', 'trading'],
  },
  {
    name: 'BlackSwan',
    url: 'https://blackswan.wtf',
    description: 'Risk intelligence infrastructure for DeFi',
    category: 'defi',
    tags: ['risk', 'intelligence', 'security', 'defi'],
  },
  {
    name: 'DappLooker AI',
    url: 'https://dapplooker.ai/',
    description: 'On-chain intelligence and analytics APIs',
    category: 'defi',
    tags: ['onchain', 'analytics', 'data', 'defi'],
  },
  {
    name: 'Otto AI Swarm',
    url: 'https://docs.ottowallet.xyz/introduction/otto-ai-swarm',
    description: 'Crypto intelligence tools for agents',
    category: 'defi',
    tags: ['intelligence', 'crypto', 'agents', 'tools'],
  },
];

/**
 * Fetch the /.well-known/x402 discovery document
 */
async function fetchWellKnown(domain: string): Promise<X402DiscoveryDocument | null> {
  try {
    const url = `https://${domain}/.well-known/x402`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Validate schema
    if (typeof data.version !== 'number' || !Array.isArray(data.resources)) {
      return null;
    }

    return data as X402DiscoveryDocument;
  } catch {
    return null;
  }
}

/**
 * Check DNS TXT record for x402 discovery URL
 */
async function fetchDnsTxt(domain: string): Promise<X402DiscoveryDocument | null> {
  try {
    const records = await resolve(`_x402.${domain}`, 'TXT');
    if (!records || records.length === 0) {
      return null;
    }

    // TXT records are arrays of strings, join them
    const txtValue = records[0].join('');

    // Should be a URL pointing to the discovery document
    if (!txtValue.startsWith('http')) {
      return null;
    }

    const response = await fetch(txtValue, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (typeof data.version !== 'number' || !Array.isArray(data.resources)) {
      return null;
    }

    return data as X402DiscoveryDocument;
  } catch {
    return null;
  }
}

/**
 * Probe a resource to get 402 payment details
 */
async function probeResource(url: string): Promise<ResourceInfo> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (response.status !== 402) {
      return {
        url,
        available: response.ok,
        error: response.status === 402 ? undefined : `Status ${response.status}`,
      };
    }

    // Parse x402 headers
    const amount = response.headers.get('X-Payment-Amount');
    const token = response.headers.get('X-Payment-Token');
    const description = response.headers.get('X-Payment-Description');

    // Convert USDC amount (6 decimals) to human readable
    let priceUsd: string | undefined;
    if (amount && token) {
      const amountNum = parseInt(amount, 10);
      // Assume USDC with 6 decimals
      priceUsd = (amountNum / 1_000_000).toFixed(4);
    }

    return {
      url,
      available: true,
      price: priceUsd ? `$${priceUsd}` : undefined,
      token: token || undefined,
      description: description || undefined,
    };
  } catch (error) {
    return {
      url,
      available: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle wallet_discover_x402 tool requests
 */
export async function handleDiscoverRequest(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const domain = args.domain as string;
  const probeResources = (args.probeResources as boolean) || false;

  if (!domain) {
    return {
      content: [{ type: 'text', text: '❌ Error: domain is required' }],
      isError: true,
    };
  }

  // Clean domain (remove protocol if present)
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // Try well-known first, then DNS
  let discovery = await fetchWellKnown(cleanDomain);
  let method = 'well-known';

  if (!discovery) {
    discovery = await fetchDnsTxt(cleanDomain);
    method = 'DNS TXT';
  }

  if (!discovery) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ No x402 support found for ${cleanDomain}\n\nChecked:\n- /.well-known/x402\n- DNS _x402.${cleanDomain} TXT record\n\nThis domain may not support x402 payments.`,
        },
      ],
      isError: false,
    };
  }

  // Build response
  const lines: string[] = [
    `✅ x402 support found via ${method}`,
    '',
    `**Domain:** ${cleanDomain}`,
    `**Version:** ${discovery.version}`,
    `**Resources:** ${discovery.resources.length}`,
    '',
  ];

  // Optionally probe resources
  if (probeResources && discovery.resources.length > 0) {
    lines.push('**Pricing:**');
    lines.push('');

    const results = await Promise.all(discovery.resources.map(probeResource));

    for (const result of results) {
      if (result.available) {
        const price = result.price || '(unknown)';
        const desc = result.description ? ` - ${result.description}` : '';
        lines.push(`- ${result.url}: ${price}${desc}`);
      } else {
        lines.push(`- ${result.url}: ❌ ${result.error || 'unavailable'}`);
      }
    }
  } else {
    lines.push('**Endpoints:**');
    lines.push('');
    for (const resource of discovery.resources) {
      lines.push(`- ${resource}`);
    }
    lines.push('');
    lines.push('_Use `probeResources: true` to check current pricing_');
  }

  if (discovery.instructions) {
    lines.push('');
    lines.push('**Instructions:**');
    lines.push('');
    lines.push(discovery.instructions);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Handle wallet_browse_x402 tool requests
 */
export function handleBrowseRequest(
  args: Record<string, unknown>
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const category = (args.category as string) || 'all';
  const search = (args.search as string)?.toLowerCase();
  const limit = Math.min((args.limit as number) || 10, 50);

  // Filter by category
  let results = category === 'all'
    ? X402_CATALOG
    : X402_CATALOG.filter((s) => s.category === category);

  // Filter by search term
  if (search) {
    results = results.filter(
      (s) =>
        s.name.toLowerCase().includes(search) ||
        s.description.toLowerCase().includes(search) ||
        s.tags.some((t) => t.includes(search))
    );
  }

  // Limit results
  results = results.slice(0, limit);

  if (results.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No x402 services found for category "${category}"${search ? ` matching "${search}"` : ''}\n\nTry:\n- Different category: ai, data, infra, defi, all\n- Broader search term`,
        },
      ],
    };
  }

  // Build response
  const categoryLabel =
    category === 'all' ? 'All Categories' : category.charAt(0).toUpperCase() + category.slice(1);

  const lines: string[] = [
    `## x402 Services: ${categoryLabel}`,
    search ? `_Matching: "${search}"_` : '',
    '',
    `Found ${results.length} services:`,
    '',
  ];

  for (const service of results) {
    lines.push(`### ${service.name}`);
    lines.push(`${service.description}`);
    lines.push(`- **URL:** ${service.url}`);
    lines.push(`- **Tags:** ${service.tags.join(', ')}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('_Use `wallet_discover_x402` to check a specific domain for x402 support_');
  lines.push('_Use `wallet_pay_x402` when you encounter a 402 response_');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Handle discovery tool requests
 */
export async function handleDiscoveryToolRequest(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const safeArgs = args || {};

  if (name === 'wallet_discover_x402') {
    return await handleDiscoverRequest(safeArgs);
  }

  if (name === 'wallet_browse_x402') {
    return handleBrowseRequest(safeArgs);
  }

  return null;
}
