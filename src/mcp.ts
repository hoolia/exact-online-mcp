import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDef, ToolContext } from './tools/types.js';
import { ExactError } from './exact/errors.js';

export type ContextFactory = (authInfo: unknown) => Promise<ToolContext>;

/** Called once after every tool call, also when the context could not be built. */
export type CallHook = (c: { authInfo: unknown; tool: string; args: unknown; ctx: ToolContext | null; outcome: 'ok' | 'refused' | 'error' }) => Promise<void>;

export function toolResult(summary: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data)}` }],
  };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export function createMcpServer(tools: ToolDef[], getContext: ContextFactory, onCall?: CallHook): McpServer {
  const server = new McpServer({ name: 'exact-online', version: '0.2.0' });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: any, extra: any) => {
        let ctx: ToolContext | null = null;
        let outcome: 'ok' | 'refused' | 'error' = 'error';
        try {
          ctx = await getContext(extra?.authInfo);
          const out = await tool.run(ctx, args);
          outcome = (out.data as any)?.refused ? 'refused' : 'ok';
          return toolResult(out.summary, out.data);
        } catch (err) {
          if (err instanceof ExactError) return toolError(err.userMessage);
          ctx_log(err);
          return toolError('Unexpected error while running this tool. Please try again.');
        } finally {
          if (onCall) await onCall({ authInfo: extra?.authInfo, tool: tool.name, args, ctx, outcome }).catch(ctx_log);
        }
      },
    );
  }
  return server;
}

let logHook: (err: unknown) => void = () => {};
export function setErrorLogger(fn: (err: unknown) => void) { logHook = fn; }
function ctx_log(err: unknown) { logHook(err); }
