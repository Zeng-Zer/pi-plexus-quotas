import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Config = {
  adminKey: string;
  pollMs?: number;
};

type QuotaMeter = {
  key?: string;
  label?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  utilizationPercent?: number;
  unit?: string;
  kind?: "balance" | "allowance";
  periodValue?: number;
  periodUnit?: "minute" | "hour" | "day" | "week" | "month";
  resetsAt?: string;
};

type QuotaChecker = {
  checkerId?: string;
  checkerType?: string;
  provider?: string;
  success?: boolean;
  latest?: QuotaMeter[];
  meters?: QuotaMeter[];
};

const PLEXUS_PROVIDER = "plexus";
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

let config: Config = { adminKey: "" };
let currentCtx: ExtensionContext | undefined;
let timer: NodeJS.Timeout | undefined;
let lastLine: string | undefined;
let refreshInFlight: Promise<void> | undefined;

function loadConfig(): Config {
  return { ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) } as Config;
}

function formatNumber(value: number, decimals = 0): string {
  return value.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatValue(value: unknown, meter: QuotaMeter): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  const unit = meter.unit?.toLowerCase() ?? "";
  const decimals = unit === "usd" || unit === "$" || (Math.abs(value) < 10 && unit !== "%" && unit !== "percentage") ? 2 : 0;
  const formatted = formatNumber(value, decimals);

  if (unit === "$" || unit === "usd") return `$${formatted}`;
  if (unit === "%" || unit === "percentage") return `${formatted}%`;
  return unit ? `${formatted}${unit}` : formatted;
}

function formatMeterValue(meter: QuotaMeter): string {
  const used = formatValue(meter.used, meter);
  const limit = formatValue(meter.limit, meter);
  if (used && limit) return `${used}/${limit}`;
  if (used) return used;
  if (meter.kind === "allowance" && typeof meter.utilizationPercent === "number") {
    return formatValue(meter.utilizationPercent, { unit: "percentage" }) ?? "?";
  }
  return formatValue(meter.remaining, meter) ?? "?";
}

function formatReset(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const remainingMs = Date.parse(resetsAt) - now;
  if (!Number.isFinite(remainingMs)) return undefined;
  if (remainingMs <= 0) return "(now)";

  const minutes = Math.max(1, Math.floor(remainingMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 7) return `(${days}d)`;
  if (days > 0) return `(${days}d${hours % 24 ? ` ${hours % 24}h` : ""})`;
  if (hours > 0) return `(${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""})`;
  return `(${minutes}m)`;
}

function periodLabel(meter: QuotaMeter): string | undefined {
  if (meter.periodValue && meter.periodUnit) {
    const suffix = { minute: "m", hour: "h", day: "d", week: "w", month: "mo" }[meter.periodUnit];
    return `${meter.periodValue}${suffix}`;
  }
  return undefined;
}

function compactMeterLabel(meter: QuotaMeter): string {
  return (meter.key ?? meter.label ?? "?")
    .replace(/_(?:quota|limit|usage|spend|balance)$/i, "")
    .replace(/[_-]+/g, " ");
}

function meterLabels(meters: QuotaMeter[]): string[] {
  const periods = meters.map(periodLabel);
  if (periods.every((period): period is string => period !== undefined) && new Set(periods).size === periods.length) {
    return periods;
  }
  return meters.map(compactMeterLabel);
}

function checkerLabel(checker: QuotaChecker): string {
  return checker.provider && checker.provider !== "upstream"
    ? checker.provider
    : checker.checkerType ?? checker.checkerId ?? "?";
}

export function lineFromPayload(payload: QuotaChecker[], now = Date.now()): string {
  return payload
    .map((checker) => {
      const label = checkerLabel(checker);
      if (checker.success === false) return `${label}: ?`;

      const meters = checker.meters ?? checker.latest ?? [];
      const showLabels = meters.length > 1;
      const labels = showLabels ? meterLabels(meters) : [];
      const values = meters.map((meter, index) => {
        const prefix = showLabels ? `${labels[index]} ` : "";
        const reset = formatReset(meter.resetsAt, now);
        return `${prefix}${formatMeterValue(meter)}${reset ? ` · ${reset}` : ""}`;
      });
      return `${label}: ${values.length ? values.join(" / ") : "ok"}`;
    })
    .join(" | ");
}

function renderWidget(): void {
  const ctx = currentCtx;
  if (!ctx) return;

  try {
    if (!ctx.hasUI) return;
  } catch {
    return;
  }

  if (!lastLine) {
    try {
      ctx.ui.setWidget("plexus-quotas", undefined);
    } catch {}
    return;
  }

  try {
    ctx.ui.setWidget(
      "plexus-quotas",
      (_tui, theme) => ({
        render(width: number) {
          return [truncateToWidth(theme.fg("dim", lastLine!), width, theme.fg("dim", "..."))];
        },
        invalidate() {},
      }),
      { placement: "belowEditor" },
    );
  } catch {}
}

function managementQuotasUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return new URL("../v0/management/quotas", base).toString();
}

async function doRefresh(): Promise<void> {
  try {
    config = loadConfig();
    const baseUrl = currentCtx?.modelRegistry.getProvider(PLEXUS_PROVIDER)?.baseUrl;
    if (!baseUrl) throw new Error("Plexus provider has no base URL");

    const response = await fetch(managementQuotasUrl(baseUrl), {
      headers: { "x-admin-key": config.adminKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid quota response");
    lastLine = lineFromPayload(payload);
    renderWidget();
  } catch {
    lastLine = "plexus quotas: ?";
    renderWidget();
  }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

function startPolling(): void {
  if (timer) clearInterval(timer);
  config = loadConfig();
  void refresh();
  timer = setInterval(() => void refresh(), config.pollMs ?? 60_000);
  timer.unref?.();
}

export default function plexusQuotas(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    startPolling();
  });

  pi.on("input", (event, ctx) => {
    currentCtx = ctx;
    if (event.source === "interactive") void refresh();
  });

  pi.on("message_end", (_event, ctx) => {
    currentCtx = ctx;
    void refresh();
  });

  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    void refresh();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    try {
      currentCtx?.ui.setWidget("plexus-quotas", undefined);
    } catch {}
    currentCtx = undefined;
  });

  pi.registerCommand("plexus-quotas", {
    description: "Refresh Plexus quota footer widget",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      await refresh();
      ctx.ui.notify(lastLine ?? "No quota data", "info");
    },
  });
}
