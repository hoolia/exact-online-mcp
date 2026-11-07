import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDef, ToolContext } from './tools/types.js';
import { ExactError } from './exact/errors.js';

export type ContextFactory = (authInfo: unknown) => Promise<ToolContext>;

export function toolResult(summary: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data)}` }],
  };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export function createMcpServer(tools: ToolDef[], getContext: ContextFactory): McpServer {
  const server = new McpServer({ name: 'exact-online', version: '0.2.0' });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: any, extra: any) => {
        try {
          const ctx = await getContext(extra?.authInfo);
          const out = await tool.run(ctx, args);
          return toolResult(out.summary, out.data);
        } catch (err) {
          if (err instanceof ExactError) return toolError(err.userMessage);
          ctx_log(err);
          return toolError('Unexpected error while running this tool. Please try again.');
        }
      },
    );
  }
  return server;
}

let logHook: (err: unknown) => void = () => {};
export function setErrorLogger(fn: (err: unknown) => void) { logHook = fn; }
function ctx_log(err: unknown) { logHook(err); }
