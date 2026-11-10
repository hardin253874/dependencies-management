/**
 * stdio entry of the dep-agent MCP server (V2_STAGE4_SPEC 4b, design §5).
 * Run with `npm run mcp` or, from an MCP client, the direct command in the
 * README (`node <repo>/node_modules/vite-node/dist/cli.mjs --root <repo>
 * <repo>/src/mcp/server.ts`). No API key is needed: the client's own model is
 * the reasoner.
 *
 * stdout carries MCP frames only. The app logger pretty-prints to
 * `console.log` outside production (src/lib/logger.ts), and any stray library
 * print would corrupt the stream, so console output is sent to stderr before
 * the first log call. Logs still land in `library/_logs/server.log`.
 */
import { fileURLToPath } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { setLibraryRoot } from '../lib/paths';
import { appAdapterDeps, resolveMcpLibraryRoot } from './context';
import { createDepAgentMcpServer } from './tools';

function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  routeConsoleToStderr();
  setLibraryRoot(resolveMcpLibraryRoot(process.env, fileURLToPath(import.meta.url)));
  const server = createDepAgentMcpServer(appAdapterDeps());
  // The transport closes itself when the client closes stdin; with no other
  // handles open the process then exits on its own.
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(`dep-agent MCP server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
