/**
 * @file System Status MCP App — Client-Side Logic
 *
 * This is the main client-side TypeScript module for the System Status
 * MCP App dashboard. It runs inside the MCP App iframe rendered by a
 * supporting MCP host (e.g. Claude Desktop).
 *
 * **Responsibilities:**
 *   1. Receives structured system information data from the MCP server's
 *      `get-system-info` tool via the MCP App SDK lifecycle callbacks.
 *   2. Renders the data into a visual dashboard with cards for OS, CPU,
 *      memory, battery, disk, network, and process information.
 *   3. Handles user interactions:
 *      - "Refresh Data" button: calls the server tool again to fetch
 *        updated system info.
 *      - "Add to Conversation" button: sends the text summary back to
 *        the host conversation as a user message.
 *   4. Applies the host's theme, fonts, and style variables so the
 *      dashboard visually matches the surrounding MCP host application.
 *
 * **MCP App SDK Integration:**
 *   This module uses the `@modelcontextprotocol/ext-apps` SDK (`App` class)
 *   to communicate with the MCP host. The `App` instance provides:
 *     - `ontoolresult`: callback fired when the tool returns new data
 *     - `ontoolinput`: callback fired when the tool starts executing
 *     - `ontoolcancelled`: callback fired if the tool call is cancelled
 *     - `callServerTool()`: method to invoke MCP tools from the client
 *     - `sendMessage()`: method to inject messages into the host conversation
 *     - `getHostContext()`: method to retrieve theme/style info from the host
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./html/global.css";
import "./html/mcp-app.css";


// ---- Types (mirror SystemInfoStructured from system-info-collector.ts) ------

/**
 * Client-side mirror of the `SystemInfoStructured` interface defined on the
 * server in `system-info-collector.ts`.
 *
 * Both sides must agree on this shape so the client can safely cast and
 * render the `structuredContent` returned by the `get-system-info` tool.
 */
interface SystemInfoStructured {
  os: { platform: string; distro: string; release: string; hostname: string; uptime: string };
  cpu: { brand: string; cores: number; physicalCores: number; loadPercent: number; temperatureCelsius: number | null };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number; freeBytes: number };
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number; usedPercent: number; availableBytes: number }>;
  battery: { hasBattery: boolean; percent: number | null; isCharging: boolean | null; timeRemainingMinutes: number | null };
  network: Array<{ iface: string; ip4: string; state: string }>;
  processes: { total: number; running: number; top: Array<{ pid: number; name: string; cpuPercent: number; memPercent: number }> };
  textSummary: string;
}


// ---- Helpers ----------------------------------------------------------------

/**
 * Converts a raw byte count into a human-readable string with the
 * appropriate unit (B, KB, MB, GB, TB).
 *
 * Uses base-1024 (binary) conversion. This is the client-side version;
 * a similar function exists on the server side in `system-info-collector.ts`.
 *
 * @param bytes - The number of bytes to format.
 * @returns A formatted string, e.g. "3.5 GB".
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Returns a CSS class name based on a usage percentage to colour-code
 * progress bars:
 *   - 80%+ → "fill--high" (red) — indicates critical/warning level
 *   - 60-79% → "fill--medium" (amber) — indicates moderate usage
 *   - Below 60% → "fill--low" (green) — indicates healthy usage
 *
 * @param pct - The usage percentage (0–100).
 * @returns A CSS class string for the progress bar fill colour.
 */
function loadClass(pct: number): string {
  if (pct >= 80) return "fill--high";
  if (pct >= 60) return "fill--medium";
  return "fill--low";
}

/**
 * Updates a progress bar element's width and colour class based on the
 * given percentage value.
 *
 * The percentage is clamped to the 0–100 range to prevent CSS overflow.
 *
 * @param el - The HTML element representing the progress bar fill.
 * @param pct - The usage percentage (0–100) to display.
 */
function setBar(el: HTMLElement, pct: number) {
  const clamped = Math.min(100, Math.max(0, pct));
  el.style.width = `${clamped.toFixed(1)}%`;
  el.className = `progress-fill ${loadClass(pct)}`;
}


// ---- DOM refs ---------------------------------------------------------------
// Cache references to all DOM elements that will be updated dynamically.
// These correspond to elements defined in `mcp-app.html` with matching IDs.

/** The root `<main>` container — used for applying safe area inset padding. */
const mainEl        = document.querySelector(".main") as HTMLElement;

/** Loading spinner/message shown while waiting for tool results. */
const loadingState  = document.getElementById("loading-state")!;

/** The main dashboard container (hidden until data arrives). */
const dashboard     = document.getElementById("dashboard")!;

/** Timestamp showing when the data was last refreshed. */
const lastUpdated   = document.getElementById("last-updated")!;

// --- OS card elements ---
const osHostname    = document.getElementById("os-hostname")!;
const osPlatform    = document.getElementById("os-platform")!;
const osDistro      = document.getElementById("os-distro")!;
const osUptime      = document.getElementById("os-uptime")!;

// --- CPU card elements ---
const cpuBrand      = document.getElementById("cpu-brand")!;
const cpuCores      = document.getElementById("cpu-cores")!;
const cpuLoad       = document.getElementById("cpu-load")!;
const cpuLoadBar    = document.getElementById("cpu-load-bar")!;
/** Row for CPU temperature — hidden if temperature data is unavailable. */
const cpuTempRow    = document.getElementById("cpu-temp-row")!;
const cpuTemp       = document.getElementById("cpu-temp")!;

// --- Memory card elements ---
const memUsage      = document.getElementById("mem-usage")!;
const memBar        = document.getElementById("mem-bar")!;
const memTotal      = document.getElementById("mem-total")!;
const memUsed       = document.getElementById("mem-used")!;
const memFree       = document.getElementById("mem-free")!;

// --- Battery, disk, network, and process card elements ---
/** Container for dynamically generated battery HTML. */
const batteryContent = document.getElementById("battery-content")!;
/** Container for dynamically generated disk usage items. */
const diskList       = document.getElementById("disk-list")!;
/** Container for dynamically generated network interface items. */
const networkList    = document.getElementById("network-list")!;
/** Process count summary text, e.g. "(5 running / 312 total)". */
const procCount      = document.getElementById("proc-count")!;
/** Table body for the top processes table rows. */
const processTbody   = document.getElementById("process-tbody")!;

// --- Action buttons ---
/** Button that triggers a fresh data fetch from the server. */
const refreshBtn     = document.getElementById("refresh-btn") as HTMLButtonElement;
/** Button that sends the text summary to the host conversation. */
const convoBtn       = document.getElementById("convo-btn") as HTMLButtonElement;


// ---- State ------------------------------------------------------------------

/**
 * Stores the most recently received system info data.
 * Used by the "Add to Conversation" button to send the text summary
 * without needing to re-fetch data from the server.
 */
let lastStructured: SystemInfoStructured | null = null;


// ---- Render -----------------------------------------------------------------

/**
 * Renders the full system status dashboard by populating all DOM elements
 * with the provided structured data.
 *
 * This function handles all sections of the dashboard:
 *   - **OS card**: hostname, platform, distribution, uptime
 *   - **CPU card**: brand, core count, load bar, temperature (if available)
 *   - **Memory card**: usage bar, total/used/free breakdown
 *   - **Battery card**: charge level bar, charging state, time remaining
 *     (or "No battery detected" message)
 *   - **Disk card**: per-mount usage bars with size breakdown
 *   - **Network card**: interface list with name, IP, and up/down state
 *   - **Processes card**: table of top 15 processes by CPU usage
 *
 * After populating all fields, it hides the loading state and reveals
 * the dashboard, then updates the "last updated" timestamp.
 *
 * @param data - The structured system information to render.
 */
function renderDashboard(data: SystemInfoStructured) {
  // Cache the data so it's available for the "Add to Conversation" button
  lastStructured = data;

  // ---- OS section ----
  osHostname.textContent = data.os.hostname;
  osPlatform.textContent = data.os.platform;
  osDistro.textContent   = `${data.os.distro} ${data.os.release}`;
  osUptime.textContent   = data.os.uptime;

  // ---- CPU section ----
  cpuBrand.textContent = data.cpu.brand;
  cpuCores.textContent = `${data.cpu.cores} (${data.cpu.physicalCores} physical)`;
  cpuLoad.textContent  = `${data.cpu.loadPercent.toFixed(1)}%`;
  setBar(cpuLoadBar, data.cpu.loadPercent);
  // Only show the temperature row if data is available (not all platforms
  // support CPU temperature reporting, e.g. macOS often returns null)
  if (data.cpu.temperatureCelsius !== null) {
    cpuTempRow.hidden    = false;
    cpuTemp.textContent  = `${data.cpu.temperatureCelsius}°C`;
  } else {
    cpuTempRow.hidden = true;
  }

  // ---- Memory section ----
  memUsage.textContent = `${data.memory.usedPercent.toFixed(1)}%`;
  setBar(memBar, data.memory.usedPercent);
  memTotal.textContent = formatBytes(data.memory.totalBytes);
  memUsed.textContent  = formatBytes(data.memory.usedBytes);
  memFree.textContent  = formatBytes(data.memory.freeBytes);

  // ---- Battery section ----
  if (!data.battery.hasBattery) {
    // Desktop machines without a battery get a simple "not available" message
    batteryContent.innerHTML = `<p class="stat-na">No battery detected</p>`;
  } else {
    const pct      = data.battery.percent ?? 0;
    const label    = data.battery.isCharging ? "⚡ Charging" : "🔋 Discharging";
    // Show time remaining only if the data is available
    const timeRow  = data.battery.timeRemainingMinutes
      ? `<dt>Remaining</dt><dd>${data.battery.timeRemainingMinutes} min</dd>`
      : "";
    // Use the same loadClass colouring: low charge = red, high charge = green
    const fillCls  = loadClass(pct);
    batteryContent.innerHTML = `
      <div class="metric">
        <div class="metric-header">
          <span class="metric-label">${label}</span>
          <span class="metric-value">${pct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${fillCls}" style="width:${pct}%"></div>
        </div>
      </div>
      ${timeRow ? `<dl class="stat-list">${timeRow}</dl>` : ""}
    `;
  }

  // ---- Disks section ----
  // Generate a progress bar for each mounted filesystem
  diskList.innerHTML = data.disks.map(d => `
    <div class="disk-item">
      <div class="metric">
        <div class="metric-header">
          <span class="metric-label metric-label--mono">${d.mount}</span>
          <span class="metric-value">${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)} &nbsp;(${d.usedPercent.toFixed(1)}%)</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${loadClass(d.usedPercent)}" style="width:${Math.min(100, d.usedPercent).toFixed(1)}%"></div>
        </div>
      </div>
    </div>
  `).join("");

  // ---- Network section ----
  if (data.network.length === 0) {
    networkList.innerHTML = `<p class="stat-na">No active interfaces</p>`;
  } else {
    // Render each interface with its name, IP address, and up/down state
    networkList.innerHTML = data.network.map(n => `
      <div class="network-item">
        <span class="network-iface">${n.iface}</span>
        <span class="network-ip">${n.ip4}</span>
        <span class="network-state ${n.state === "up" ? "state--up" : "state--down"}">${n.state}</span>
      </div>
    `).join("");
  }

  // ---- Processes section ----
  // Show the running/total count in the card header
  procCount.textContent = `(${data.processes.running} running / ${data.processes.total} total)`;
  // Populate the process table body with the top 15 processes
  // Highlight CPU values >= 10% with a warning colour class
  processTbody.innerHTML = data.processes.top.map(p => `
    <tr>
      <td class="proc-pid">${p.pid}</td>
      <td class="proc-name">${p.name}</td>
      <td class="${p.cpuPercent >= 10 ? "val--warn" : ""}">${p.cpuPercent.toFixed(1)}</td>
      <td>${p.memPercent.toFixed(1)}</td>
    </tr>
  `).join("");

  // ---- Show the dashboard, hide the loading state ----
  loadingState.hidden = true;
  dashboard.hidden    = false;
  // Update the "last updated" timestamp in the header
  lastUpdated.textContent = new Date().toLocaleTimeString();
}

/**
 * Extracts the `SystemInfoStructured` data from a `CallToolResult`.
 *
 * The tool's structured content is stored in `result.structuredContent`.
 * This function performs a basic type check (presence of the `os` property)
 * to validate that the data has the expected shape before returning it.
 *
 * @param result - The raw tool result from the MCP server.
 * @returns The structured system info data, or null if the result doesn't
 *          contain valid structured data.
 */
function extractStructured(result: CallToolResult): SystemInfoStructured | null {
  const s = result.structuredContent as SystemInfoStructured | undefined;
  return s?.os ? s : null;
}


// ---- Host context -----------------------------------------------------------

/**
 * Applies the MCP host's visual context (theme, styles, fonts, safe area
 * insets) to the dashboard so it visually integrates with the surrounding
 * host application.
 *
 * Uses helper functions from `@modelcontextprotocol/ext-apps`:
 *   - `applyDocumentTheme()`: Sets the document's colour scheme (light/dark)
 *   - `applyHostStyleVariables()`: Injects CSS custom properties from the host
 *   - `applyHostFonts()`: Loads and applies the host's font families
 *
 * Safe area insets are applied as padding on the main container to prevent
 * content from being obscured by notches or system UI elements.
 *
 * @param ctx - The host context object provided by the MCP host.
 */
function applyHostContext(ctx: McpUiHostContext) {
  if (ctx.theme)             applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  // Apply safe area insets (e.g. for notched displays or host chrome)
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop    = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight  = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft   = `${ctx.safeAreaInsets.left}px`;
  }
}


// ---- App setup --------------------------------------------------------------

/**
 * Create the MCP App instance.
 *
 * The `App` class from `@modelcontextprotocol/ext-apps` manages the
 * communication lifecycle between this client-side code and the MCP host.
 * It handles message passing, tool result delivery, and host context updates.
 */
const app = new App({ name: "System Status", version: "1.0.0" });

/**
 * Teardown handler — called when the MCP host is about to destroy this
 * app instance (e.g. when the user navigates away or closes the panel).
 * Use this for any cleanup logic (currently just logs a message).
 */
app.onteardown = async () => {
  console.info("App torn down");
  return {};
};

/**
 * Tool input handler — called when the tool has been invoked and is
 * currently executing (i.e. the server is collecting system data).
 * Shows the loading state and hides the dashboard while waiting.
 */
app.ontoolinput = () => {
  loadingState.hidden = false;
  dashboard.hidden    = true;
};

/**
 * Tool result handler — called when the `get-system-info` tool returns
 * its result. Extracts the structured data and renders the dashboard.
 *
 * @param result - The `CallToolResult` containing the system info data.
 */
app.ontoolresult = (result) => {
  const data = extractStructured(result);
  if (data) renderDashboard(data);
};

/**
 * Tool cancelled handler — called if the tool call is cancelled by the
 * host (e.g. user pressed stop). Hides the loading state and restores
 * the dashboard to its previous state.
 *
 * @param params - Object containing the cancellation reason.
 */
app.ontoolcancelled = (params) => {
  console.info("Tool call cancelled:", params.reason);
  loadingState.hidden = true;
  dashboard.hidden    = false;
};

/** Error handler — logs any MCP App SDK errors to the console. */
app.onerror = console.error;

/**
 * Host context change handler — called whenever the host's theme, styles,
 * or safe area insets change (e.g. user switches from light to dark mode).
 */
app.onhostcontextchanged = applyHostContext;


// ---- Button handlers --------------------------------------------------------

/**
 * "Refresh Data" button click handler.
 *
 * Disables the button and shows the loading state, then calls the
 * `get-system-info` tool on the server via `app.callServerTool()`.
 * When the result arrives, renders the updated dashboard.
 *
 * If the call fails, logs the error and restores the previous dashboard
 * state. The button is always re-enabled in the `finally` block.
 */
refreshBtn.addEventListener("click", async () => {
  // Disable button and show visual feedback while refreshing
  refreshBtn.disabled    = true;
  refreshBtn.textContent = "Refreshing…";
  loadingState.hidden    = false;
  dashboard.hidden       = true;
  try {
    // Call the server-side MCP tool to get fresh system data
    const result = await app.callServerTool({ name: "get-system-info", arguments: {} });
    const data   = extractStructured(result);
    if (data) renderDashboard(data);
  } catch (e) {
    console.error("Refresh failed:", e);
    // On error, restore the dashboard to its previous state
    loadingState.hidden = true;
    dashboard.hidden    = false;
  } finally {
    // Always re-enable the button and restore its label
    refreshBtn.disabled    = false;
    refreshBtn.textContent = "Refresh Data";
  }
});

/**
 * "Add to Conversation" button click handler.
 *
 * Sends the most recently received text summary as a user message into
 * the host conversation via `app.sendMessage()`. This allows the user
 * to inject the system status data into their ongoing conversation
 * with the LLM for further analysis or discussion.
 *
 * The call has a 5-second timeout via `AbortSignal.timeout()` to prevent
 * the button from staying disabled indefinitely if the host is unresponsive.
 *
 * Does nothing if no data has been received yet (lastStructured is null).
 */
convoBtn.addEventListener("click", async () => {
  // Don't send if we haven't received any data yet
  if (!lastStructured) return;

  // Disable button and show visual feedback while sending
  convoBtn.disabled    = true;
  convoBtn.textContent = "Sending…";
  try {
    // Send the text summary as a user message to the host conversation
    await app.sendMessage(
      { role: "user", content: [{ type: "text", text: lastStructured.textSummary }] },
      { signal: AbortSignal.timeout(5000) },
    );
  } catch (e) {
    console.error("sendMessage failed:", e);
  } finally {
    // Always re-enable the button and restore its label
    convoBtn.disabled    = false;
    convoBtn.textContent = "Add to Conversation";
  }
});


// ---- Connect ----------------------------------------------------------------

/**
 * Establish the connection to the MCP host.
 *
 * `app.connect()` initialises the communication channel between this
 * client-side app and the MCP host. Once connected, the host context
 * (theme, styles, safe area insets) is retrieved and applied immediately
 * so the dashboard matches the host's visual appearance from the start.
 *
 * After connection, the app is ready to receive tool results via the
 * `ontoolresult` callback whenever the `get-system-info` tool is invoked.
 */
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyHostContext(ctx);
});
