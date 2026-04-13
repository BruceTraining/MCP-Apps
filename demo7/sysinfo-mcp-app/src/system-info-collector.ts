/**
 * @file System Information Collector
 *
 * This module is responsible for gathering a comprehensive snapshot of the
 * local machine's current state. It uses the `systeminformation` npm library
 * to query OS details, CPU load/temperature, memory usage, disk filesystems,
 * battery status, active network interfaces, and the top running processes.
 *
 * It produces two forms of output:
 *   1. A **structured JSON object** (`SystemInfoStructured`) — consumed by the
 *      interactive MCP App dashboard UI for visual rendering.
 *   2. A **plain-text summary** (embedded within the structured object as
 *      `textSummary`) — used as the tool's text content for non-UI MCP hosts
 *      that only support text responses.
 *
 * This module is imported by `mcp-server.ts`, which registers the
 * `get-system-info` MCP tool that calls `getSystemInformation()`.
 */

import si from "systeminformation";

// ---- Types ------------------------------------------------------------------

/**
 * Structured representation of the system's current state.
 *
 * Each top-level key corresponds to a category of hardware or OS information.
 * This interface is mirrored on the client side (`mcp-app.ts`) so both the
 * server and client agree on the shape of the data.
 */
export interface SystemInfoStructured {
  /** Operating system metadata and uptime. */
  os: {
    /** OS family, e.g. "darwin", "linux", "win32". */
    platform: string;
    /** Distribution name, e.g. "macOS" or "Ubuntu". */
    distro: string;
    /** OS version string, e.g. "14.2.1". */
    release: string;
    /** Machine hostname. */
    hostname: string;
    /** Human-readable uptime string, e.g. "3d 2h 15m 4s". */
    uptime: string;
  };
  /** CPU hardware info and current utilisation. */
  cpu: {
    /** CPU model/brand string, e.g. "Apple M2 Pro". */
    brand: string;
    /** Total logical cores (including hyper-threaded). */
    cores: number;
    /** Number of physical cores. */
    physicalCores: number;
    /** Current aggregate CPU load as a percentage (0–100). */
    loadPercent: number;
    /** CPU temperature in Celsius, or null if unavailable (common on macOS). */
    temperatureCelsius: number | null;
  };
  /** System memory (RAM) usage. */
  memory: {
    /** Total installed RAM in bytes. */
    totalBytes: number;
    /** Currently used RAM in bytes. */
    usedBytes: number;
    /** Used RAM as a percentage (0–100). */
    usedPercent: number;
    /** Free (unused) RAM in bytes. */
    freeBytes: number;
  };
  /** Mounted filesystem / disk partition usage. */
  disks: Array<{
    /** Mount point path, e.g. "/" or "C:". */
    mount: string;
    /** Total partition size in bytes. */
    totalBytes: number;
    /** Used space in bytes. */
    usedBytes: number;
    /** Used space as a percentage (0–100). */
    usedPercent: number;
    /** Available (free) space in bytes. */
    availableBytes: number;
  }>;
  /** Battery status (relevant for laptops). */
  battery: {
    /** Whether the machine has a battery at all. */
    hasBattery: boolean;
    /** Current charge percentage (0–100), or null if no battery. */
    percent: number | null;
    /** Whether the battery is currently charging, or null if no battery. */
    isCharging: boolean | null;
    /** Estimated minutes remaining on battery, or null if unavailable. */
    timeRemainingMinutes: number | null;
  };
  /** Active network interfaces with IP addresses. */
  network: Array<{
    /** Interface name, e.g. "en0", "eth0". */
    iface: string;
    /** IPv4 address (falls back to IPv6 if no IPv4 is assigned). */
    ip4: string;
    /** Operational state, e.g. "up" or "down". */
    state: string;
  }>;
  /** Process statistics and top resource consumers. */
  processes: {
    /** Total number of processes running on the system. */
    total: number;
    /** Number of processes in a "running" state. */
    running: number;
    /** Top 15 processes sorted by CPU usage (descending). */
    top: Array<{
      /** Process ID. */
      pid: number;
      /** Process name. */
      name: string;
      /** CPU usage percentage for this process. */
      cpuPercent: number;
      /** Memory usage percentage for this process. */
      memPercent: number;
    }>;
  };
  /**
   * A pre-formatted plain-text summary of all the above data.
   * This is used as the `text` content in the MCP tool response so that
   * hosts without UI rendering can still display useful information.
   */
  textSummary: string;
}

/**
 * Wrapper result type returned by `getSystemInformation()`.
 *
 * On success: `success` is true and `structured` contains the full data.
 * On failure: `success` is false and `error` contains the error message.
 */
export interface SystemInfoResult {
  /** Whether the data collection completed without errors. */
  success: boolean;
  /** The full structured system snapshot (present only on success). */
  structured?: SystemInfoStructured;
  /** Error message describing what went wrong (present only on failure). */
  error?: string;
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Converts a raw byte count into a human-readable string with appropriate
 * units (B, KB, MB, GB, TB).
 *
 * Uses base-1024 (binary) conversion, which is standard for memory/disk
 * reporting on most operating systems.
 *
 * @param bytes - The number of bytes to format.
 * @returns A formatted string, e.g. "3.50 GB".
 *
 * @example
 * formatBytes(0);            // "0 B"
 * formatBytes(1536);         // "1.50 KB"
 * formatBytes(1073741824);   // "1.00 GB"
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  // Determine the best unit index by computing log base 1024
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Converts a raw uptime value (in seconds) into a compact human-readable
 * duration string like "3d 2h 15m 4s".
 *
 * @param seconds - Total uptime in seconds.
 * @returns A formatted duration string with days, hours, minutes, and seconds.
 *
 * @example
 * formatUptime(90061);  // "1d 1h 1m 1s"
 * formatUptime(45);     // "45s"
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  // Always show seconds if no other parts are present (e.g. uptime < 1 min)
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

// ---- Main export ------------------------------------------------------------

/**
 * Collects a full snapshot of the local machine's current state using the
 * `systeminformation` library.
 *
 * This function fires all data-collection calls in parallel via `Promise.all`
 * for maximum speed, then assembles the results into a single
 * `SystemInfoStructured` object. It also builds a plain-text summary that
 * can be used by MCP hosts that don't render the interactive UI.
 *
 * **Data collected:**
 * - OS info (platform, distro, release, hostname, uptime)
 * - CPU info (brand, core count, current load percentage, temperature)
 * - Memory usage (total, used, free, percentage)
 * - Disk/filesystem usage (per mount point)
 * - Battery status (charge level, charging state, time remaining)
 * - Network interfaces (name, IPv4/IPv6, operational state)
 * - Top 15 processes by CPU usage (PID, name, CPU%, memory%)
 *
 * @returns A `SystemInfoResult` promise:
 *   - On success: `{ success: true, structured: SystemInfoStructured }`
 *   - On failure: `{ success: false, error: string }`
 */
export async function getSystemInformation(): Promise<SystemInfoResult> {
  try {
    // Fire all system information queries in parallel for best performance.
    // Each `si.*()` call is an independent async operation.
    const [
      osInfo, cpu, cpuSpeed, currentLoad, mem, fsSize,
      battery, networkInterfaces, processes, time, cpuTemp,
    ] = await Promise.all([
      si.osInfo(), si.cpu(), si.cpuCurrentSpeed(), si.currentLoad(),
      si.mem(), si.fsSize(), si.battery(), si.networkInterfaces(),
      si.processes(), si.time(), si.cpuTemperature(),
    ]);

    // cpuSpeed is collected for completeness but not currently displayed.
    // Suppress the TypeScript "unused variable" warning.
    void cpuSpeed;

    // Format the raw uptime (in seconds) into a human-readable string
    const uptimeStr = formatUptime(time.uptime);

    // Extract the aggregate CPU load percentage (defaults to 0 if unavailable)
    const loadPct = currentLoad.currentLoad ?? 0;

    // Extract CPU temperature; filter out -1 which `systeminformation` uses
    // to indicate "sensor not available" on some platforms (notably macOS)
    const temp = cpuTemp.main && cpuTemp.main !== -1 ? cpuTemp.main : null;

    // ---- Build the disks array ----
    // `fsSize` may be a single object or an array depending on the platform,
    // so we normalise it to an array
    const disks: SystemInfoStructured["disks"] = Array.isArray(fsSize)
      ? fsSize.map(fs => ({
          mount: fs.mount,
          totalBytes: fs.size,
          usedBytes: fs.used,
          usedPercent: fs.use ?? 0,
          availableBytes: fs.available,
        }))
      : [];

    // ---- Build the battery object ----
    // If no battery is present, all sub-fields are set to null
    const batteryData: SystemInfoStructured["battery"] = battery.hasBattery
      ? {
          hasBattery: true,
          percent: battery.percent,
          isCharging: battery.isCharging,
          timeRemainingMinutes:
            battery.timeRemaining && battery.timeRemaining > 0
              ? battery.timeRemaining
              : null,
        }
      : { hasBattery: false, percent: null, isCharging: null, timeRemainingMinutes: null };

    // ---- Build the network interfaces array ----
    // `networkInterfaces` can be a single object or array; normalise to array,
    // then filter to only interfaces that have an IP address assigned
    const ifaces = Array.isArray(networkInterfaces)
      ? networkInterfaces
      : [networkInterfaces];
    const network: SystemInfoStructured["network"] = ifaces
      .filter(iface => iface.ip4 || iface.ip6)
      .map(iface => ({
        iface: iface.iface,
        // Prefer IPv4; fall back to IPv6 if no IPv4 is assigned
        ip4: iface.ip4 || iface.ip6 || "N/A",
        state: iface.operstate || "N/A",
      }));

    // ---- Build the top-15 processes list ----
    // Sort all processes by CPU usage descending, then take the top 15
    const top = (processes.list ?? [])
      .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))
      .slice(0, 15)
      .map(p => ({
        pid: p.pid ?? 0,
        name: p.name ?? "",
        cpuPercent: p.cpu ?? 0,
        memPercent: p.mem ?? 0,
      }));

    // ---- Build the plain-text summary ----
    // This text is returned as the MCP tool's `content[0].text` so that
    // hosts without UI rendering still get a useful response
    const memPct = ((mem.used / mem.total) * 100).toFixed(1);
    const textLines: string[] = [
      `System Status — ${osInfo.hostname}`,
      `OS: ${osInfo.platform} / ${osInfo.distro} ${osInfo.release}  Uptime: ${uptimeStr}`,
      `CPU: ${cpu.brand} (${cpu.cores} cores)  Load: ${loadPct.toFixed(1)}%${temp !== null ? `  Temp: ${temp}°C` : ""}`,
      `Memory: ${formatBytes(mem.used)} / ${formatBytes(mem.total)} (${memPct}%)`,
      ``,
    ];
    // Append a line for each mounted disk/filesystem
    for (const d of disks) {
      textLines.push(`Disk ${d.mount}: ${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)} (${d.usedPercent.toFixed(1)}%)`);
    }
    // Append battery info if present
    if (battery.hasBattery) {
      textLines.push(`Battery: ${battery.percent}% ${battery.isCharging ? "(charging)" : "(discharging)"}`);
    }
    // Append total/running process counts
    textLines.push(`Processes: ${processes.running} running / ${processes.all} total`);

    // ---- Assemble the final structured object ----
    const structured: SystemInfoStructured = {
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        hostname: osInfo.hostname,
        uptime: uptimeStr,
      },
      cpu: {
        brand: cpu.brand,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        loadPercent: loadPct,
        temperatureCelsius: temp,
      },
      memory: {
        totalBytes: mem.total,
        usedBytes: mem.used,
        usedPercent: (mem.used / mem.total) * 100,
        freeBytes: mem.free,
      },
      disks,
      battery: batteryData,
      network,
      processes: {
        total: processes.all,
        running: processes.running,
        top,
      },
      textSummary: textLines.join("\n"),
    };

    return { success: true, structured };
  } catch (error) {
    // If any system information call fails, return a clean error result
    // rather than crashing the server
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
