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
  ReferenceDot,
  type TooltipProps,
} from "recharts";
import {
  gradientStops,
  niceScale,
  currentValueLabel,
  LINE_COLOR,
  AREA_COLOR,
  SURFACE_COLOR,
} from "@/lib/graph";
import { useUserPositionHistory } from "@/hooks/useVaultData";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { formatQty } from "@/lib/format";

const GRID_STROKE = "hsl(0, 0%, 35%)";
const AXIS_STROKE = "hsl(0, 0%, 45%)";
const AREA_ID = "cushion-user-area";

type Period = "7d" | "30d" | "90d" | "all";
const PERIODS: Period[] = ["7d", "30d", "90d", "all"];

/** Position value over time (shares held × share price), from the indexer. */
export function UserPositionChart({
  contractId,
  symbol,
  decimals,
}: {
  contractId: string;
  symbol: string;
  decimals: number;
}) {
  const address = useStellarWalletStore((s) => s.address);
  const [period, setPeriod] = useState<Period>("30d");
  const history = useUserPositionHistory(contractId, address, period);

  const data = history.map((h) => ({
    ts: Math.floor(new Date(h.ts).getTime() / 1000),
    value: h.value / 10 ** decimals,
  }));

  const values = data.map((d) => d.value);
  const minY = values.length ? Math.min(...values) : 0;
  const maxY = values.length ? Math.max(...values) : 0;
  const last = data.length ? data[data.length - 1] : null;
  const { domain: yDomain, ticks: yTicks } = niceScale(minY, maxY);

  const spanDays =
    data.length > 1 ? (data[data.length - 1].ts - data[0].ts) / 86_400 : 0;
  const xPattern = spanDays <= 2 ? "HH:mm" : spanDays <= 10 ? "DD/MM HH:mm" : "DD/MM";

  const btn = (active: boolean) =>
    `px-3 py-1 rounded-full text-sm transition-colors ${
      active ? "bg-[#475569] text-gray-100" : "text-gray-400"
    }`;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">Position Value</h3>
        <div className="flex items-center gap-1 p-1 rounded-full bg-[#2a3142]">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`${btn(period === p)} uppercase`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full h-[220px] mt-4">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            {address ? "No history yet" : "Connect your wallet to see your history"}
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
              <Area
                type="monotone"
                dataKey="value"
                strokeWidth={2}
                fill={`url(#${AREA_ID})`}
                stroke={LINE_COLOR}
              />
              {/* live marker: right after a tx the new level is sub-pixel wide
                  on a multi-day axis, so pin the latest value on its point. */}
              {last && (
                <ReferenceDot
                  x={last.ts}
                  y={last.value}
                  r={4}
                  fill={LINE_COLOR}
                  stroke={SURFACE_COLOR}
                  strokeWidth={2}
                  isFront
                  label={currentValueLabel(`${formatQty(last.value)} ${symbol}`)}
                />
              )}
              <XAxis
                dataKey="ts"
                tickMargin={8}
                minTickGap={60}
                tickLine={false}
                stroke={AXIS_STROKE}
                tickFormatter={(t: number) => dayjs.unix(t).format(xPattern)}
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
                tickFormatter={(t: number) => formatQty(t)}
              />
              <Tooltip
                cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
                content={(p: TooltipProps<number, string>) => {
                  if (!p.active || !p.payload?.length) return null;
                  const v = p.payload[0].value ?? 0;
                  const date = dayjs
                    .unix(p.label as number)
                    .format(spanDays <= 10 ? "D MMM HH:mm" : "D MMM YYYY");
                  return (
                    <div className="flex flex-col gap-1 p-2 rounded border border-neutral-700 bg-neutral-950">
                      <span className="text-xs text-gray-400">{date}</span>
                      <span className="text-sm font-semibold" style={{ color: LINE_COLOR }}>
                        {formatQty(v)} {symbol}
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
