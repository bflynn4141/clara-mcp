/**
 * Tool Registry
 *
 * Central registration and dispatch for all Clara MCP tools.
 * Replaces the giant if/else chain in index.ts with a clean Map lookup.
 *
 * Usage:
 *   registerTool(definition, handler, { requiresAuth: true });
 *   // ...
 *   server.setRequestHandler(CallToolRequestSchema, (req) =>
 *     dispatch(req.params.name, req.params.arguments)
 *   );
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  ToolResult,
  ToolConfig,
  ToolHandler,
  PublicToolHandler,
} from './middleware.js';
import { wrapTool } from './middleware.js';

interface ToolEntry {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const TOOL_MAP = new Map<string, ToolEntry>();

/**
 * Register a tool with the registry
 *
 * The handler is automatically wrapped with the middleware pipeline
 * based on the provided config.
 */
export function registerTool(
  definition: Tool,
  handler: ToolHandler | PublicToolHandler,
  config: Partial<ToolConfig> = {},
): void {
  TOOL_MAP.set(definition.name, {
    definition,
    handler: wrapTool(handler, config),
  });
}

/**
 * Get all registered tool definitions (for ListTools response)
 */
export function getAllToolDefinitions(): Tool[] {
  return Array.from(TOOL_MAP.values()).map((e) => e.definition);
}

/**
 * Dispatch a tool call by name
 */
export async function dispatch(
  name: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const entry = TOOL_MAP.get(name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  return entry.handler(args ?? {});
}
