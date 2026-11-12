import { useId, useMemo } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { Bar } from "@visx/shape";
import { EmptyState } from "./AnalyticsPanel";
import type { TaskTrendPoint } from "./types";
import { formatWeekRange } from "./utils";

export const trendSources = [
  { key: "internal", label: "Internas", color: "hsl(var(--primary))" },
  { key: "external", label: "Clientes externos", color: "hsl(36 92% 46%)" },
] as const;

export function TaskCreationChart({
  formatLabel,
  formatDetailLabel,
  height,
  items,
  minTickWidth,
  onSelect,
  onTooltip,
  onTooltipHide,
  showEmptyBuckets,
  showWeekRanges,
  width,
}: {
  formatLabel: (value: string) => string;
  formatDetailLabel: (value: string) => string;
  height: number;
  items: TaskTrendPoint[];
  minTickWidth: number;
  onSelect?: (periodKey: string) => void;
  onTooltip: (args: {
    datum: TaskTrendPoint;
    left: number;
    top: number;
  }) => void;
  onTooltipHide: () => void;
  showEmptyBuckets: boolean;
  showWeekRanges: boolean;
  width: number;
}) {
  const clipPrefix = useId();
  const margin = { top: 12, right: 12, bottom: 32, left: 42 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const maxCount = Math.max(...items.map((item) => item.count), 1);
  const yTicks = buildIntegerTicks(maxCount);
  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: items.map((item) => item.periodKey),
        padding: 0.28,
        range: [0, innerWidth],
      }),
    [innerWidth, items],
  );
  const stackedWeekLabels = showWeekRanges && xScale.step() < 80;
  const tickStride = Math.ceil(
    (stackedWeekLabels ? 44 : minTickWidth) / Math.max(xScale.step(), 1),
  );
  const tickValues =
    tickStride > 1
      ? items
          .filter((_, index) => (items.length - 1 - index) % tickStride === 0)
          .map((item) => item.periodKey)
      : undefined;
  const bottomMargin = stackedWeekLabels ? 46 : margin.bottom;
  const innerHeight = Math.max(height - margin.top - bottomMargin, 0);
  const yScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, maxCount],
        nice: true,
        range: [innerHeight, 0],
      }),
    [innerHeight, maxCount],
  );

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <svg height={height} width={width}>
      <Group left={margin.left} top={margin.top}>
        {yTicks.map((tick) => (
          <line
            key={tick}
            x1={0}
            x2={innerWidth}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke="hsl(var(--border))"
            strokeDasharray="3 4"
            strokeOpacity={0.75}
          />
        ))}

        <AxisLeft
          hideAxisLine
          hideTicks
          scale={yScale}
          tickFormat={(value) => String(value)}
          tickValues={yTicks}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            textAnchor: "end",
            dy: "0.32em",
            dx: "-0.35em",
          })}
        />

        <AxisBottom
          hideAxisLine
          hideTicks
          scale={xScale}
          top={innerHeight}
          tickFormat={
            showWeekRanges ? (value) => formatWeekRange(value) : formatLabel
          }
          tickValues={tickValues}
          tickComponent={
            stackedWeekLabels
              ? ({ x, y, formattedValue }) => {
                  const [start, end] = formattedValue?.split(" – ") ?? [];
                  return (
                    <text
                      x={x}
                      y={y}
                      dy="0.35em"
                      textAnchor="middle"
                      fontSize={11}
                      fill="hsl(var(--muted-foreground))"
                    >
                      <tspan x={x}>{start}</tspan>
                      <tspan x={x} dy="1.3em">– {end}</tspan>
                    </text>
                  );
                }
              : undefined
          }
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            textAnchor: "middle",
            dy: "0.7em",
          })}
        />

        {items.map((item) => {
          const barX = xScale(item.periodKey) ?? 0;
          const barY = yScale(item.count);
          const barWidth = xScale.bandwidth();
          const barHeight = innerHeight - barY;
          const visibleHeight = item.count > 0 ? Math.max(barHeight, 3) : 0;
          const barTop = innerHeight - visibleHeight;
          const internalHeight =
            item.count > 0 ? visibleHeight * (item.internal / item.count) : 0;
          const externalHeight = visibleHeight - internalHeight;
          const clipId = `${clipPrefix}-${item.periodKey}`;
          const dateLabel = showWeekRanges
            ? formatWeekRange(item.periodKey, true)
            : formatDetailLabel(item.periodKey);
          const showBarTooltip = () =>
            onTooltip({
              datum: item,
              left: margin.left + barX + barWidth / 2,
              top: margin.top + barTop - 8,
            });

          return (
            <g
              key={item.periodKey}
              tabIndex={0}
              role={onSelect ? "button" : "img"}
              aria-label={`${dateLabel}: ${item.internal} internas, ${item.external} externas, ${item.count} en total${onSelect ? ". Ver meses" : ""}`}
              className={onSelect ? "cursor-pointer" : undefined}
              onClick={onSelect ? () => onSelect(item.periodKey) : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(item.periodKey);
                      }
                    }
                  : undefined
              }
              onBlur={onTooltipHide}
              onFocus={showBarTooltip}
              onMouseLeave={onTooltipHide}
              onMouseMove={showBarTooltip}
            >
              {showEmptyBuckets && item.count === 0 && (
                <rect
                  x={barX}
                  y={innerHeight - 12}
                  width={barWidth}
                  height={12}
                  fill="transparent"
                />
              )}
              <clipPath id={clipId}>
                <rect
                  x={barX}
                  y={barTop}
                  width={barWidth}
                  height={visibleHeight}
                  rx={6}
                />
              </clipPath>
              <g clipPath={`url(#${clipId})`}>
                <Bar
                  x={barX}
                  y={barTop}
                  width={barWidth}
                  height={externalHeight}
                  fill={trendSources[1].color}
                />
                <Bar
                  x={barX}
                  y={innerHeight - internalHeight}
                  width={barWidth}
                  height={internalHeight}
                  fill={trendSources[0].color}
                />
              </g>
            </g>
          );
        })}
      </Group>
    </svg>
  );
}

function buildIntegerTicks(maxValue: number) {
  if (maxValue <= 1) return [0, 1];
  if (maxValue <= 4) {
    return Array.from({ length: maxValue + 1 }, (_, index) => index);
  }

  const step = Math.ceil(maxValue / 4);
  const ticks = new Set<number>([0, maxValue]);
  for (let value = step; value < maxValue; value += step) {
    ticks.add(value);
  }
  return Array.from(ticks).sort((a, b) => a - b);
}
