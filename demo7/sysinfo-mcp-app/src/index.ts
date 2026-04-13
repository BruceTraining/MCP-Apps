/**
 * @file Entry Point — System Status MCP App Server
 *
 * This is the main entry point for the System Status MCP App server.
 * It determines which transport mode to use based on command-line arguments
 * and starts the server accordingly.
 *
 * **Transport Modes:**
 *
 *   1. **HTTP (Streamable HTTP)** — Default mode for local development and
 *      testing. Starts an Express-based HTTP server that listens for MCP
 *      requests on `/mcp`. Each incoming request gets its own server
 *      instance (stateless mode).
 *
 *      Usage:
 *        node dist/index.js
 *        → Server listens on http://localhost:3001/mcp
 *
 *   2. **Stdio** — Used when the server is launched by an MCP host like
 *      Claude Desktop. Communication happens over standard input/output
 *      streams instead of HTTP.
 *
 *      Usage:
 *        node dist/index.js --stdio
 *        → Configure in claude_desktop_config.json with:
 *          { "command": "node", "args": ["<path>/dist/index.js", "--stdio"] }
 *
 * **Build First:** This file must be compiled before running:
 *   npm run build
 *
 * @module index
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./mcp-server.js";

/**
 * Starts an MCP server using the Streamable HTTP transport in **stateless mode**.
 *
 * In stateless mode, a new `McpServer` instance is created for every incoming
 * HTTP request. This means no session state is maintained between requests,
 * which simplifies deployment and scaling but means each request is independent.
 *
 * The server:
 *   - Creates an Express app with CORS enabled (allows cross-origin requests
 *     from any origin, useful during development).
 *   - Listens on the port specified by the `PORT` environment variable,
 *     defaulting to 3001.
 *   - Handles all HTTP methods on `/mcp` (GET, POST, DELETE) as required
 *     by the Streamable HTTP transport protocol.
 *   - Cleans up the transport and server when the HTTP connection closes.
 *   - Returns a JSON-RPC error response if anything goes wrong.
 *   - Registers SIGINT and SIGTERM handlers for graceful shutdown.
 *
 * @param createServer - An async factory function that creates a new `McpServer`
 *   instance. Called once per incoming request to ensure stateless operation.
 */
export async function startStreamableHTTPServer(
  createServer: () => Promise<McpServer>,
): Promise<void> {
  // Read the port from environment, defaulting to 3001 for local development
  const port = parseInt(process.env.PORT ?? "3001", 10);

  // Create an Express app pre-configured for MCP, binding to all interfaces
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Enable CORS so the server can be accessed from any origin (important
  // for development and for MCP hosts running on different domains)
  app.use(cors());

  /**
   * Main MCP endpoint — handles all HTTP methods (GET, POST, DELETE).
   *
   * The Streamable HTTP transport protocol uses:
   *   - POST for sending JSON-RPC requests (tool calls, resource reads, etc.)
   *   - GET for server-sent events (SSE) streaming
   *   - DELETE for session cleanup
   *
   * Each request gets a fresh server instance and transport. When the
   * HTTP connection closes, both are cleaned up to prevent resource leaks.
   */
  app.all("/mcp", async (req: Request, res: Response) => {
    // Create a fresh server instance for this request (stateless mode)
    const server = await createServer();

    // Create a transport with no session ID generator (stateless — no sessions)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Clean up when the HTTP connection is closed by the client
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      // Wire the server to the transport and handle the incoming request
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      // Send a JSON-RPC error response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Start the HTTP server and listen on the configured port
  const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.log(`MCP server listening on http://localhost:${port}/mcp`);
  });

  /**
   * Graceful shutdown handler.
   * Closes the HTTP server and exits cleanly when the process receives
   * SIGINT (Ctrl+C) or SIGTERM (e.g. from a process manager).
   */
  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  // Register shutdown handlers for both interrupt and termination signals
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Starts an MCP server using the **stdio transport**.
 *
 * In stdio mode, the server communicates over standard input/output streams
 * (stdin/stdout). This is the mode used when the server is launched by an
 * MCP host like Claude Desktop, which manages the process lifecycle and
 * communicates with it via pipes.
 *
 * Creates a single server instance and connects it to a `StdioServerTransport`.
 * The server runs until the host closes the stdio streams.
 *
 * @param createServer - An async factory function that creates a new `McpServer` instance.
 */
export async function startStdioServer(
  createServer: () => Promise<McpServer>,
): Promise<void> {
  (await createServer()).connect(new StdioServerTransport());
}

/**
 * Main entry point.
 *
 * Checks for the `--stdio` command-line flag to determine which transport
 * mode to use:
 *   - With `--stdio`: Starts in stdio mode (for MCP host integration)
 *   - Without `--stdio`: Starts in HTTP mode (for development/testing)
 *
 * Any unhandled errors during startup are logged and cause the process
 * to exit with code 1.
 */
async function main() {
  if (process.argv.includes("--stdio")) {
    await startStdioServer(createServer);
  } else {
    await startStreamableHTTPServer(createServer);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
