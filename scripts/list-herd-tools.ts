import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const client = new Client({
    name: 'herd-tool-lister',
    version: '1.0.0',
  });

  const transport = new StreamableHTTPClientTransport(
    new URL('https://api.herd.eco/v1/mcp'),
    {
      requestInit: {
        headers: {
          'Authorization': 'Bearer herd_mcp_123',
        },
      },
    }
  );

  await client.connect(transport);
  console.log('Connected to Herd API\n');

  const tools = await client.listTools();
  console.log('Available Herd Tools:');
  console.log('=====================\n');

  for (const tool of tools.tools) {
    const desc = tool.description ? tool.description.split('\n')[0] : 'No description';
    console.log(`Tool: ${tool.name}`);
    console.log(`  ${desc}`);
    console.log('');
  }

  await client.close();
}

main().catch(console.error);
