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
  type TooltipProps,
} from "recharts";
import { gradientStops, getYDomain, LINE_COLOR, AREA_COLOR } from "@/lib/graph";
import { useVaultHistory, usePriceHistory } from "@/hooks/useVaultData";

// UIVaultCushion theme (globals.css .dark): grid --stroke-secondary, axes --container-border.
const GRID_STROKE = "hsl(0, 0%, 35%)";
const AXIS_STROKE = "hsl(0, 0%, 45%)";

type GraphType = "tvl" | "sharePrice" | "roi" | "xlmusd";
type Period = "7d" | "30d" | "90d" | "all";

const TYPES: { k: GraphType; label: string }[] = [
  { k: "tvl", label: "TVL" },
  { k: "sharePrice", label: "Share price" },
  { k: "roi", label: "ROI" },
  { k: "xlmusd", label: "XLM/USD" },
];
const PERIODS: Period[] = ["7d", "30d", "90d", "all"];

function periodDays(p: Period): number {
  return p === "7d" ? 7 : p === "30d" ? 30 : p === "90d" ? 90 : 365;
}

const AREA_ID = "cushion-vault-area";
const LINE_ID = "cushion-vault-line";

function millify(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtValue(type: GraphType, v: number): string {
  if (type === "roi") return `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(2)}%`;
  if (type === "sharePrice") return v.toFixed(4);
  if (type === "xlmusd") return `$${v.toFixed(4)}`;
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
  const data =
    type === "xlmusd"
      ? prices.map((p) => ({ ts: p.ts, value: p.price }))
      : history.map((h) => ({
          ts: Math.floor(new Date(h.ts).getTime() / 1000),
          value:
            type === "tvl"
              ? Number(BigInt(h.nav)) / 10 ** decimals
              : type === "sharePrice"
                ? h.sharePrice
                : firstSharePrice > 0
                  ? (h.sharePrice / firstSharePrice - 1) * 100
                  : 0,
        }));

  const values = data.map((d) => d.value);
  const minY = values.length ? Math.min(...values) : 0;
  const maxY = values.length ? Math.max(...values) : 0;
  const yDomain = getYDomain(minY, maxY);

  const btn = (active: boolean) =>
    `px-3 py-1 rounded-full text-sm transition-colors ${
      active ? "bg-[#475569] text-gray-100" : "text-gray-400"
    }`;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      {/* type + period selectors */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-full bg-[#2a3142]">
          {TYPES.map((t) => (
            <button key={t.k} onClick={() => setType(t.k)} className={btn(type === t.k)}>
              {t.label}
            </button>
          ))}
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
                <linearGradient id={LINE_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(LINE_COLOR)}
                </linearGradient>
                <linearGradient id={AREA_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(AREA_COLOR, 0.6, 0.2)}
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="value"
                strokeWidth={2}
                fill={`url(#${AREA_ID})`}
                stroke={`url(#${LINE_ID})`}
              />
              <XAxis
                dataKey="ts"
                tickMargin={8}
                minTickGap={40}
                tickLine={false}
                stroke={AXIS_STROKE}
                tickFormatter={(t) => dayjs.unix(t).format("DD/MM")}
              />
              <YAxis
                dataKey="value"
                tickMargin={8}
                width={52}
                tickLine={false}
                stroke={AXIS_STROKE}
                domain={yDomain as [number, string]}
                tickFormatter={(t: number) => fmtValue(type, t)}
              />
              <Tooltip
                cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
                content={(p: TooltipProps<number, string>) => {
                  if (!p.active || !p.payload?.length) return null;
                  const v = p.payload[0].value ?? 0;
                  const date = dayjs.unix(p.label as number).format("D MMM YYYY");
                  return (
                    <div className="flex flex-col gap-1 p-2 rounded border border-neutral-700 bg-neutral-950">
                      <span className="text-xs text-gray-400">{date}</span>
                      <span
                        className="text-sm font-semibold"
                        style={{ color: LINE_COLOR }}
                      >
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

      <div className="flex items-center gap-1 mt-2 text-sm text-gray-500">
        <span>Denominated in {symbol}</span>
      </div>
    </div>
  );
}
