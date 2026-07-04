"use client";

import { useState } from "react";
import dayjs from "dayjs";
import {
  ResponsiveContainer,
  AreaChart,
  CartesianGrid,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  type TooltipProps,
} from "recharts";
import { gradientStops, niceScale, LINE_COLOR, AREA_COLOR } from "@/lib/graph";
import { useVaultHistory, usePriceHistory } from "@/hooks/useVaultData";

// UIVaultCushion theme (globals.css .dark): grid --stroke-secondary, axes --container-border.
const GRID_STROKE = "hsl(0, 0%, 35%)";
const AXIS_STROKE = "hsl(0, 0%, 45%)";

type GraphType = "tvl" | "sharePrice" | "roi" | "usdRoi";
type Period = "7d" | "30d" | "90d" | "all";

const TYPES: { k: GraphType; label: string; info: string }[] = [
  { k: "tvl", label: "TVL", info: "Total value locked, denominated in XLM." },
  {
    k: "sharePrice",
    label: "Share price",
    info: "Net asset value per share, indexed to 1.0000 at inception.",
  },
  { k: "roi", label: "ROI", info: "Return since inception, denominated in XLM." },
  {
    k: "usdRoi",
    label: "ROI (USD)",
    info: "Return since inception valued in USD — share value × Reflector XLM/USD. Captures both vault performance and the XLM/USD move.",
  },
];
const PERIODS: Period[] = ["7d", "30d", "90d", "all"];

function periodDays(p: Period): number {
  return p === "7d" ? 7 : p === "30d" ? 30 : p === "90d" ? 90 : 365;
}

const AREA_ID = "cushion-vault-area";

const isRoi = (t: GraphType) => t === "roi" || t === "usdRoi";

function millify(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtValue(type: GraphType, v: number): string {
  // strip trailing .00 so round ticks read "15%" but the tooltip keeps "9.44%"
  if (isRoi(type)) return `${parseFloat(v.toFixed(2))}%`;
  if (type === "sharePrice") return v.toFixed(4);
  return millify(v);
}

export function StellarVaultChart({
  contractId,
  symbol,
  decimals,
}: {
  contractId: string;
  symbol: string;
  decimals: number;
}) {
  const [type, setType] = useState<GraphType>("tvl");
  const [period, setPeriod] = useState<Period>("30d");
  const history = useVaultHistory(contractId, period);
  const prices = usePriceHistory("XLM", periodDays(period));

  const firstSharePrice = history.find((h) => h.sharePrice > 0)?.sharePrice ?? 0;

  // XLM/USD at-or-before a unix timestamp (prices are ascending) — lets us value
  // each vault snapshot in USD without an extra request.
  const priceAt = (tsSec: number): number => {
    let p = prices.length ? prices[0].price : 0;
    for (const pt of prices) {
      if (pt.ts <= tsSec) p = pt.price;
      else break;
    }
    return p;
  };

  // USD value of one share at inception — the baseline for USD ROI.
  const firstUsd = (() => {
    const f = history.find((h) => h.sharePrice > 0);
    if (!f) return 0;
    const p = priceAt(Math.floor(new Date(f.ts).getTime() / 1000));
    return p > 0 ? f.sharePrice * p : 0;
  })();

  const data = history.map((h) => {
    const ts = Math.floor(new Date(h.ts).getTime() / 1000);
    let value: number;
    if (type === "tvl") {
      value = Number(BigInt(h.nav)) / 10 ** decimals;
    } else if (type === "sharePrice") {
      // raw NAV/supply is ~10^-decimals_offset; index to 1.0000 at inception.
      value = firstSharePrice > 0 ? h.sharePrice / firstSharePrice : 1;
    } else if (type === "roi") {
      value = firstSharePrice > 0 ? (h.sharePrice / firstSharePrice - 1) * 100 : 0;
    } else {
      // usdRoi: return on the share's USD value (vault perf × XLM/USD move).
      const usd = h.sharePrice * priceAt(ts);
      value = firstUsd > 0 && usd > 0 ? (usd / firstUsd - 1) * 100 : 0;
    }
    return { ts, value };
  });

  const values = data.map((d) => d.value);
  const minY = values.length ? Math.min(...values) : 0;
  const maxY = values.length ? Math.max(...values) : 0;

  // Round domain + round ticks (Heckbert nice-numbers). ROI charts centre 0
  // (symmetric); others pad a band.
  const maxAbs = Math.max(Math.abs(minY), Math.abs(maxY));
  const { domain: yDomain, ticks: yTicks } = isRoi(type)
    ? niceScale(-maxAbs, maxAbs)
    : niceScale(minY, maxY);

  // Adapt the x-axis to the actual span: a fresh vault covers hours/days, the
  // longer views cover weeks — never repeat the same DD/MM across ticks.
  const spanDays =
    data.length > 1 ? (data[data.length - 1].ts - data[0].ts) / 86_400 : 0;
  const xPattern = spanDays <= 2 ? "HH:mm" : spanDays <= 10 ? "DD/MM HH:mm" : "DD/MM";
  const xFmt = (t: number) => dayjs.unix(t).format(xPattern);
  const tipFmt = (t: number) =>
    dayjs.unix(t).format(spanDays <= 10 ? "D MMM HH:mm" : "D MMM YYYY");

  const info = TYPES.find((t) => t.k === type)?.info ?? "";

  const btn = (active: boolean) =>
    `px-3 py-1 rounded-full text-sm transition-colors ${
      active ? "bg-[#475569] text-gray-100" : "text-gray-400"
    }`;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      {/* type + period selectors */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 rounded-full bg-[#2a3142]">
            {TYPES.map((t) => (
              <button key={t.k} onClick={() => setType(t.k)} className={btn(type === t.k)}>
                {t.label}
              </button>
            ))}
          </div>
          {/* hover for the metric's definition — no permanent caption */}
          <span
            title={info}
            className="flex items-center justify-center w-5 h-5 text-xs italic border rounded-full cursor-help text-gray-400 border-neutral-600"
          >
            i
          </span>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-full bg-[#2a3142]">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`${btn(period === p)} uppercase`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full h-[266px] mt-4">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            No history yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <defs>
                <linearGradient id={AREA_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(AREA_COLOR, 0.6, 0.2)}
                </linearGradient>
              </defs>
              {isRoi(type) && (
                <ReferenceLine y={0} stroke={AXIS_STROKE} strokeDasharray="3 3" />
              )}
              {/* solid stroke, not a gradient: a flat line's bounding box has
                  zero height and a gradient stroke would render invisible. */}
              <Area
                type="monotone"
                dataKey="value"
                strokeWidth={2}
                fill={`url(#${AREA_ID})`}
                stroke={LINE_COLOR}
              />
              <XAxis
                dataKey="ts"
                tickMargin={8}
                minTickGap={60}
                tickLine={false}
                stroke={AXIS_STROKE}
                tickFormatter={xFmt}
              />
              <YAxis
                dataKey="value"
                tickMargin={8}
                width={64}
                tickLine={false}
                stroke={AXIS_STROKE}
                domain={yDomain}
                ticks={yTicks}
                interval={0}
                tickFormatter={(t: number) => fmtValue(type, t)}
              />
              <Tooltip
                cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
                content={(p: TooltipProps<number, string>) => {
                  if (!p.active || !p.payload?.length) return null;
                  const v = p.payload[0].value ?? 0;
                  const date = tipFmt(p.label as number);
                  return (
                    <div className="flex flex-col gap-1 p-2 rounded border border-neutral-700 bg-neutral-950">
                      <span className="text-xs text-gray-400">{date}</span>
                      <span className="text-sm font-semibold" style={{ color: LINE_COLOR }}>
                        {fmtValue(type, v)}
                        {type === "tvl" ? ` ${symbol}` : ""}
                      </span>
                    </div>
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
