/**
 * @file MCP Server Definition — Tools, Resources, and Prompts
 *
 * This module defines and exports a factory function `createServer()` that
 * creates a fully configured MCP (Model Context Protocol) server instance.
 *
 * The server exposes:
 *   - **1 Tool**: `get-system-info` — Collects live system data (CPU, memory,
 *     disk, battery, network, processes) and returns both structured JSON
 *     (for the interactive MCP App UI) and a plain-text summary.
 *   - **1 Resource**: The MCP App HTML dashboard (`mcp-app.html`) that is
 *     served to supporting MCP hosts for interactive rendering.
 *   - **8 Prompts**: Pre-built prompt templates for common system analysis
 *     tasks such as health checks, performance troubleshooting, capacity
 *     planning, and process investigation.
 *
 * The server uses the `@modelcontextprotocol/ext-apps` package helpers
 * (`registerAppTool`, `registerAppResource`) to wire up the tool and
 * resource with the correct MCP App metadata so that hosts can render
 * the interactive UI alongside the tool results.
 *
 * This module is imported by `index.ts`, which handles transport setup
 * (HTTP or stdio) and actually starts the server.
 */

import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createUIResource } from "@mcp-ui/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getSystemInformation } from "./system-info-collector.js";

// NOTE: No outputSchema is defined for the get-system-info tool. The structured
// data (SystemInfoStructured) is still returned via structuredContent for the
// dashboard to consume — omitting the schema simply means MCP won't validate
// the shape at runtime, matching the simpler style used in sysinfo-mcp-server.

/**
 * Resolve the `dist/` directory path at runtime.
 *
 * When running from TypeScript source (via `tsx`), `import.meta.filename`
 * ends with `.ts`, so we navigate up one level from `src/` to find `dist/`.
 * When running from the compiled JavaScript output, the file is already
 * inside `dist/`, so we use `import.meta.dirname` directly.
 *
 * This is needed to locate the built `mcp-app.html` file that gets served
 * as an MCP App resource.
 */
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;


/**
 * Factory function that creates and returns a fully configured MCP server.
 *
 * Each call produces a **new** server instance, which is important for
 * the stateless HTTP transport mode where every incoming request gets
 * its own server (see `index.ts`).
 *
 * **Registered capabilities:**
 *
 * 1. **Tool — `get-system-info`**
 *    Calls `getSystemInformation()` from `system-info-collector.ts` and
 *    returns the result. On success, the response includes:
 *      - `content[0].text`: A plain-text summary for non-UI hosts.
 *      - `structuredContent`: The full `SystemInfoStructured` JSON, which
 *        the MCP App dashboard uses to render the interactive UI.
 *    The tool's `_meta.ui.resourceUri` links it to the MCP App resource
 *    so that supporting hosts know which UI to render alongside the result.
 *
 * 2. **Resource — `ui://system-status/mcp-app.html`**
 *    Serves the built MCP App HTML file from the `dist/` directory. This
 *    HTML file is a self-contained single-page application (bundled by
 *    Vite) that renders the system status dashboard.
 *
 * 3. **Prompts** (8 total)
 *    Pre-built prompt templates that guide the LLM to use the
 *    `get-system-info` tool and provide specific types of analysis:
 *      - `system_health_check`: General health overview
 *      - `troubleshoot_performance`: Diagnose performance bottlenecks
 *      - `security_process_audit`: Security-oriented process review
 *      - `capacity_planning`: Resource capacity vs. threshold analysis
 *      - `battery_status`: Battery-specific status report
 *      - `resource_usage_summary`: Quick at-a-glance resource overview
 *      - `network_overview`: Network interface review
 *      - `process_investigation`: Deep-dive into top processes
 *
 * @returns A promise that resolves to a new `McpServer` instance ready to be
 *   connected to a transport. The function is async because it reads the
 *   MCP App HTML file from disk during server setup.
 */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "System Status MCP App",
    version: "1.0.0",
  });

  /**
   * The URI that identifies the MCP App resource (the dashboard HTML).
   * This URI uses the `ui://` scheme, which is the MCP-UI convention for
   * UI resources that should be rendered by supporting MCP hosts.
   */
  const resourceUri = "ui://system-status/mcp-app.html";

  // ---- Tool Registration: get-system-info -----------------------------------
  // `registerAppTool` is a helper from `@modelcontextprotocol/ext-apps/server`
  // that registers an MCP tool with the additional `_meta.ui` metadata needed
  // to link the tool to its corresponding MCP App UI resource.
  registerAppTool(server,
    "get-system-info",
    {
      title: "System Status",
      description:
        "Displays a live dashboard of the current machine status: " +
        "CPU load, memory usage, disk space, battery level, network interfaces, " +
        "and top processes by CPU. The UI updates automatically when the tool runs.",
      /** Empty input schema — this tool takes no parameters. */
      inputSchema: {},
      /**
       * MCP App metadata linking this tool to the dashboard UI resource.
       * When a host receives this tool result, it can look at `_meta.ui.resourceUri`
       * to find and render the associated MCP App.
       */
      _meta: { ui: { resourceUri } },
    },
    /**
     * Tool handler — called each time the `get-system-info` tool is invoked.
     *
     * Collects system information and returns it as a `CallToolResult`.
     * On success, the result includes both text content (for non-UI hosts)
     * and structured content (for the interactive dashboard).
     * On failure, returns an error message with `isError: true`.
     */
    async (): Promise<CallToolResult> => {
      const result = await getSystemInformation();

      if (result.success && result.structured) {
        return {
          // Text content provides a fallback for hosts that don't render UI
          content: [{ type: "text", text: result.structured.textSummary }],
          // Structured content is consumed by the MCP App dashboard
          structuredContent: result.structured as unknown as Record<string, unknown>,
        };
      }

      // Return an error result if data collection failed
      return {
        content: [{ type: "text", text: `Failed to retrieve system information: ${result.error}` }],
        isError: true,
      };
    },
  );

  // ---- Resource Creation: MCP App HTML ----------------------------------------
  // Read the built HTML file once at server creation time and use
  // `createUIResource` from `@mcp-ui/server` to produce a standardised
  // UIResource object. This follows the recommended MCP-UI pattern.
  const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");

  /**
   * Create the UI resource using `@mcp-ui/server`.
   *
   * `createUIResource` produces a `{ type: "resource", resource: { uri, mimeType, text } }`
   * object with the correct MIME type and encoding automatically applied.
   * The HTML file is a self-contained SPA built by Vite with all CSS
   * and JS inlined (via `vite-plugin-singlefile`).
   */
  const dashboardUI = createUIResource({
    uri: resourceUri,
    content: { type: "rawHtml", htmlString: html },
    encoding: "text",
  });

  // ---- Resource Registration: MCP App HTML ----------------------------------
  // `registerAppResource` registers the UI resource so MCP hosts can
  // read it by URI when they need to render the dashboard.
  registerAppResource(server,
    "system_status_ui",
    dashboardUI.resource.uri,
    {},
    async () => ({
      contents: [dashboardUI.resource],
    }),
  );

  // ---- Prompt Registrations -------------------------------------------------
  // Prompts are pre-built instruction templates that guide the LLM to use
  // the `get-system-info` tool and provide specific types of analysis.
  // Each prompt returns a `messages` array containing a single user message
  // with instructions for the LLM.

  /**
   * Prompt: System Health Check
   * Instructs the LLM to gather system data and provide an overall health
   * summary, highlighting any resources under pressure.
   */
  server.registerPrompt(
    "system_health_check",
    {
      title: "System Health Check",
      description:
        "Perform a general health check of the system. Retrieves system " +
        "information and summarises the overall health, highlighting any " +
        "resources that are under pressure (high CPU, low memory, low disk " +
        "space, low battery, etc.).",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Please perform a full system health check. Use the get-system-info tool " +
              "to gather data, then provide a clear summary of the overall system health. " +
              "Highlight any areas of concern such as high CPU load, low available memory, " +
              "disks that are nearly full, low battery, or an unusually high number of " +
              "processes. Keep the summary concise and actionable.",
          },
        },
      ],
    })
  );

  /**
   * Prompt: Troubleshoot Performance
   * Instructs the LLM to diagnose performance issues. Accepts an optional
   * `symptom` parameter so the user can describe what they're experiencing.
   */
  server.registerPrompt(
    "troubleshoot_performance",
    {
      title: "Troubleshoot Performance",
      description:
        "Diagnose system performance problems. Retrieves system information " +
        "and analyses CPU load, memory pressure, disk I/O, and top processes " +
        "to identify likely bottlenecks.",
      argsSchema: {
        symptom: z
          .string()
          .optional()
          .describe(
            "Optional description of the symptom (e.g. 'system feels slow', " +
            "'applications are freezing', 'high fan noise')"
          ),
      },
    },
    ({ symptom }) => {
      // Prepend the user's symptom description if provided
      const symptomText = symptom
        ? `The user reports the following symptom: "${symptom}". `
        : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `${symptomText}My system seems to be having performance issues. ` +
                "Please use the get-system-info tool to collect data, then analyse " +
                "the results to identify potential bottlenecks. Look at CPU load, memory " +
                "usage, swap usage, disk utilisation, and the top processes consuming " +
                "resources. Suggest concrete steps I can take to improve performance.",
            },
          },
        ],
      };
    }
  );

  /**
   * Prompt: Security & Process Audit
   * Instructs the LLM to review running processes and network interfaces
   * for anything suspicious or unusual.
   */
  server.registerPrompt(
    "security_process_audit",
    {
      title: "Security & Process Audit",
      description:
        "Audit running processes and network interfaces for potential " +
        "security concerns. Reviews process list for suspicious entries " +
        "and checks network configuration.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Please perform a security-oriented review of my system. Use the " +
              "get-system-info tool and then examine the list of running processes " +
              "for anything unusual or potentially suspicious. Also review the network " +
              "interfaces and statistics for unexpected activity. Let me know if anything " +
              "looks out of the ordinary and suggest next steps if needed. Note: this is " +
              "a basic review and is not a substitute for professional security tooling.",
          },
        },
      ],
    })
  );

  /**
   * Prompt: Capacity Planning
   * Instructs the LLM to analyse resource usage against total capacity.
   * Accepts an optional `threshold` parameter (default: 80%) to flag
   * resources that exceed the specified utilisation level.
   */
  server.registerPrompt(
    "capacity_planning",
    {
      title: "Capacity Planning",
      description:
        "Analyse current resource usage against total capacity. Provides " +
        "a breakdown of CPU, memory, and disk utilisation with recommendations " +
        "for when thresholds are being approached.",
      argsSchema: {
        threshold: z
          .string()
          .optional()
          .describe(
            "Optional warning threshold percentage (e.g. '80'). " +
            "Resources above this percentage will be flagged. Defaults to 80."
          ),
      },
    },
    ({ threshold }) => {
      // Default to 80% if no threshold is specified
      const pct = threshold ?? "80";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "I need to understand my current system capacity. Please use the " +
                "get-system-info tool to collect data, then provide a capacity " +
                `report. Flag any resource (CPU, memory, disk) that is above ${pct}% ` +
                "utilisation. For each resource, show the current usage vs total capacity " +
                "and indicate whether I am at risk of running out. Suggest actions for " +
                "any resources that are approaching the threshold.",
            },
          },
        ],
      };
    }
  );

  /**
   * Prompt: Battery Status
   * Instructs the LLM to report on battery charge, charging state, and
   * estimated time remaining. Useful for laptop users.
   */
  server.registerPrompt(
    "battery_status",
    {
      title: "Battery Status",
      description:
        "Check the current battery status including charge level, charging " +
        "state, and estimated time remaining. Useful for laptop users.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Please check my battery status. Use the get-system-info tool and " +
              "report on the current battery percentage, whether it is charging, and " +
              "the estimated time remaining if available. If no battery is detected, " +
              "let me know that this system does not have a battery.",
          },
        },
      ],
    })
  );

  /**
   * Prompt: Resource Usage Summary
   * Instructs the LLM to provide a brief, at-a-glance summary of the
   * key system metrics. Designed for quick periodic check-ins.
   */
  server.registerPrompt(
    "resource_usage_summary",
    {
      title: "Resource Usage Summary",
      description:
        "Provide a brief, at-a-glance summary of CPU, memory, and disk usage. " +
        "Designed for quick periodic check-ins rather than deep analysis.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Give me a quick resource usage summary. Use the get-system-info tool " +
              "and provide a brief overview of current CPU load, memory utilisation, and " +
              "disk usage. Keep it short -- just the key numbers and whether anything " +
              "looks concerning.",
          },
        },
      ],
    })
  );

  /**
   * Prompt: Network Overview
   * Instructs the LLM to review network interfaces, IP addresses,
   * operational states, and traffic statistics.
   */
  server.registerPrompt(
    "network_overview",
    {
      title: "Network Overview",
      description:
        "Review network interfaces, IP addresses, link speeds, and current " +
        "traffic statistics. Useful for connectivity troubleshooting.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Please give me an overview of my network configuration and activity. " +
              "Use the get-system-info tool, then summarise the network interfaces " +
              "(names, IP addresses, speeds, operational state) and current traffic " +
              "statistics (bytes sent/received). Highlight any interfaces that appear " +
              "to be down or misconfigured.",
          },
        },
      ],
    })
  );

  /**
   * Prompt: Process Investigation
   * Instructs the LLM to investigate the top resource-consuming processes.
   * Accepts an optional `process_name` parameter to focus on a specific process.
   */
  server.registerPrompt(
    "process_investigation",
    {
      title: "Process Investigation",
      description:
        "Investigate the top resource-consuming processes on the system. " +
        "Lists the heaviest processes by CPU and memory usage and helps " +
        "the user decide if any should be terminated.",
      argsSchema: {
        process_name: z
          .string()
          .optional()
          .describe(
            "Optional: a specific process name to look for in the process list"
          ),
      },
    },
    ({ process_name }) => {
      // If a specific process name is given, add extra instructions to look for it
      const extra = process_name
        ? ` In particular, look for any process named or related to "${process_name}" and report its resource usage.`
        : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "I want to investigate which processes are using the most resources on my " +
                "system. Please use the get-system-info tool and then list the top " +
                "processes by CPU and memory usage. For each, explain what the process " +
                `likely is and whether it seems normal.${extra} If any processes look ` +
                "like they might be stuck or consuming excessive resources, suggest how " +
                "to handle them.",
            },
          },
        ],
      };
    }
  );

  return server;
}
