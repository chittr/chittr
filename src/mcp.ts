import { AttachmentResult, mcpToolResult, attachmentFailure } from './attachment-result.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { version } from './version.js';
import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { ToolService, toolInputs, descriptionFor, type ToolName } from './tools.js';
import { commandEndpointSchema } from './command-broker.js';
import { attachmentResolverSettingsSchema, FileAttachmentResolver } from './attachments.js';
export const mcpSettingsSchema = z
  .object({
    workspace: z.string(),
    historyFile: z.string().optional(),
    maintenanceFile: z.string().optional(),
    attachmentTurnFile: z.string().optional(),
    skillAccess: z.array(z.object({ path: z.string(), root: z.string() }).strict()).default([]),
    permissions: z.object({ edits: z.boolean(), commands: z.boolean(), network: z.boolean() }),
    commandMode: z.enum(['off', 'sandboxed', 'trusted']),
    commandEndpoint: commandEndpointSchema,
    attachmentStore: attachmentResolverSettingsSchema.optional(),
  })
  .strict();
const settings = mcpSettingsSchema.parse(JSON.parse(process.argv[2] ?? '{}'));
const tools = new ToolService(
  realpathSync(settings.workspace),
  settings.permissions,
  settings.historyFile,
  settings.skillAccess,
  { mode: settings.commandMode, endpoint: settings.commandEndpoint },
  settings.maintenanceFile,
  settings.attachmentStore ? new FileAttachmentResolver(settings.attachmentStore) : undefined,
  settings.attachmentTurnFile,
);
await tools.check();
const pendingImages = new Map<string | number, { result: AttachmentResult; cleanup: () => void }>();
const server = new McpServer({ name: 'chittr-tools', version });
for (const [name, input] of Object.entries(toolInputs)) {
  server.registerTool(
    name,
    {
      description: descriptionFor(name as ToolName, settings.commandMode),
      inputSchema: input as any,
    },
    async (args: unknown, extra: any) => {
      try {
        const result = await tools.call(name, args, extra.signal);
        if (result instanceof AttachmentResult && result.mapping === 'claude-mcp-image') {
          if (extra.signal.aborted) throw new Error('Attachment request cancelled');
          const discard = () => pendingImages.delete(extra.requestId);
          extra.signal.addEventListener('abort', discard, { once: true });
          pendingImages.set(extra.requestId, {
            result,
            cleanup: () => extra.signal.removeEventListener('abort', discard),
          });
          // Hold private bytes until the SDK has assembled the complete response.
          return { content: [] };
        }
        return mcpToolResult(result);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                name === 'read_attachment'
                  ? JSON.stringify(attachmentFailure(error))
                  : error instanceof Error
                    ? error.message
                    : String(error),
            },
          ],
        };
      }
    },
  );
}
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = async (message) => {
  if ('id' in message && message.id !== undefined) {
    const pending = pendingImages.get(message.id);
    if (pending) {
      pendingImages.delete(message.id);
      pending.cleanup();
      if (!('result' in message)) return send(message);
      try {
        message = pending.result.response(message);
      } catch (error) {
        message = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(attachmentFailure(error)) }],
          },
        };
      }
    }
  }
  return send(message);
};
const close = () => {
  for (const pending of pendingImages.values()) pending.cleanup();
  pendingImages.clear();
  tools.close();
  void server.close();
};
process.on('SIGTERM', () => {
  close();
  process.exit(0);
});
process.on('SIGINT', () => {
  close();
  process.exit(0);
});
process.stdin.on('end', close);
await server.connect(transport);
