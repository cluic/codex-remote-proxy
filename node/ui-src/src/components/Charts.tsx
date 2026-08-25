import { memo, useMemo, useState } from "react";

import {
  formatCompactNumber,
  formatDate,
  formatNumber,
  type Translator
} from "../i18n";
import type { Locale, MetricsResults, MetricsSeriesPoint } from "../types";

type TrendMode = "requests" | "tokens";
type RequestScale = "count" | "percent";
type TokenMetric = "total" | "input" | "output";
type RequestGroup = "success" | "upstreamRejected" | "error" | "clientAbort";

const requestGroups: RequestGroup[] = [
  "success",
  "upstreamRejected",
  "error",
  "clientAbort"
];

const emptyResults = (): MetricsResults => ({
  success: 0,
  upstreamRejected: 0,
  upstreamError: 0,
  timeout: 0,
  networkError: 0,
  clientAbort: 0
});

function groupSeries(series: MetricsSeriesPoint[], maximum = 36): MetricsSeriesPoint[] {
  if (series.length <= maximum) return series;
  const size = Math.ceil(series.length / maximum);
  const groups: MetricsSeriesPoint[] = [];
  for (let index = 0; index < series.length; index += size) {
    const slice = series.slice(index, index + size);
    const first = slice[0];
    if (!first) continue;
    const results = emptyResults();
    for (const point of slice) {
      for (const key of Object.keys(results) as Array<keyof MetricsResults>) {
        results[key] += point.results[key];
      }
    }
    groups.push({
      start: first.start,
      requests: slice.reduce((sum, point) => sum + point.requests, 0),
      results,
      tokens: {
        input: slice.reduce((sum, point) => sum + point.tokens.input, 0),
        output: slice.reduce((sum, point) => sum + point.tokens.output, 0),
        observedRequests: slice.reduce((sum, point) => sum + point.tokens.observedRequests, 0)
      }
    });
  }
  return groups;
}

function requestValues(results: MetricsResults): Record<RequestGroup, number> {
  return {
    success: results.success,
    upstreamRejected: results.upstreamRejected,
    error: results.upstreamError + results.timeout + results.networkError,
    clientAbort: results.clientAbort
  };
}

function resultLabel(key: RequestGroup, t: Translator): string {
  if (key === "success") return t("metrics.success");
  if (key === "upstreamRejected") return t("metrics.rejected");
  if (key === "clientAbort") return t("metrics.clientAbort");
  return t("metrics.errors");
}

function niceMaximum(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function bucketLabel(locale: Locale, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit"
  }).format(date);
}

function tokenValue(point: MetricsSeriesPoint, metric: TokenMetric): number {
  if (metric === "input") return point.tokens.input;
  if (metric === "output") return point.tokens.output;
  return point.tokens.input + point.tokens.output;
}

function lineSegments(
  series: MetricsSeriesPoint[],
  metric: TokenMetric,
  x: (index: number) => number,
  y: (value: number) => number
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  series.forEach((point, index) => {
    if (point.tokens.observedRequests === 0) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? "M" : "L"} ${x(index)} ${y(tokenValue(point, metric))}`);
  });
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

function lastPopulatedIndex(series: MetricsSeriesPoint[]): number {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if ((series[index]?.requests ?? 0) > 0) return index;
  }
  return 0;
}

export const TrendExplorer = memo(function TrendExplorer({
  series,
  locale,
  t
}: {
  series: MetricsSeriesPoint[];
  locale: Locale;
  t: Translator;
}) {
  const [mode, setMode] = useState<TrendMode>("requests");
  const [requestScale, setRequestScale] = useState<RequestScale>("count");
  const [tokenMetric, setTokenMetric] = useState<TokenMetric>("total");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const grouped = useMemo(() => groupSeries(series), [series]);
  const activeIndex = selectedIndex !== null && selectedIndex < grouped.length
    ? selectedIndex
    : lastPopulatedIndex(grouped);
  const selected = grouped[activeIndex] ?? null;

  const width = 920;
  const height = 176;
  const margin = { top: 10, right: 18, bottom: 30, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const step = grouped.length > 0 ? plotWidth / grouped.length : plotWidth;
  const requestMaximum = requestScale === "percent"
    ? 100
    : niceMaximum(Math.max(0, ...grouped.map((point) => point.requests)));
  const tokenMaximum = niceMaximum(Math.max(0, ...grouped.map((point) => (
    point.tokens.observedRequests > 0 ? tokenValue(point, tokenMetric) : 0
  ))));
  const maximum = mode === "requests" ? requestMaximum : tokenMaximum;
  const x = (index: number) => margin.left + step * index + step / 2;
  const y = (value: number) => margin.top + plotHeight - (value / maximum) * plotHeight;
  const tokenPaths = mode === "tokens"
    ? lineSegments(grouped, tokenMetric, x, y)
    : [];
  const axisTicks = [0, 0.25, 0.5, 0.75, 1];
  const xLabelIndexes = new Set([
    0,
    Math.floor((grouped.length - 1) / 2),
    Math.max(0, grouped.length - 1)
  ]);

  return (
    <div className="trend-explorer">
      <div className="trend-toolbar">
        <div className="segmented-control" aria-label={t("overview.trendMetric")}>
          <button type="button" aria-pressed={mode === "requests"} onClick={() => setMode("requests")}>
            {t("overview.requestsTab")}
          </button>
          <button type="button" aria-pressed={mode === "tokens"} onClick={() => setMode("tokens")}>
            {t("overview.tokensTab")}
          </button>
        </div>
        {mode === "requests" ? (
          <div className="segmented-control trend-secondary-control" aria-label={t("overview.requestScale")}>
            <button type="button" aria-pressed={requestScale === "count"} onClick={() => setRequestScale("count")}>
              {t("overview.countScale")}
            </button>
            <button type="button" aria-pressed={requestScale === "percent"} onClick={() => setRequestScale("percent")}>
              {t("overview.percentScale")}
            </button>
          </div>
        ) : (
          <div className="segmented-control trend-secondary-control" aria-label={t("overview.tokenMetric")}>
            {(["total", "input", "output"] as TokenMetric[]).map((metric) => (
              <button key={metric} type="button" aria-pressed={tokenMetric === metric} onClick={() => setTokenMetric(metric)}>
                {t(`overview.${metric}Tokens`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="trend-legend" aria-label={t("overview.legend")}>
        {mode === "requests" ? requestGroups.map((key) => (
          <span key={key}><i className={`legend-${key}`} />{resultLabel(key, t)}</span>
        )) : (
          <>
            <span><i className="legend-token" />{t(`overview.${tokenMetric}Tokens`)}</span>
            <span className="trend-gap-key"><i />{t("overview.unobservedGap")}</span>
          </>
        )}
      </div>

      <div className="trend-canvas" onPointerLeave={() => setSelectedIndex(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t(mode === "requests"
          ? "overview.requestTrendDescription"
          : "overview.tokenTrendDescription")}>
          {axisTicks.map((tick) => {
            const value = maximum * tick;
            const py = y(value);
            return (
              <g key={tick}>
                <line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={py} y2={py} />
                <text className="chart-axis-label" x={margin.left - 10} y={py + 4} textAnchor="end">
                  {mode === "requests" && requestScale === "percent"
                    ? `${Math.round(value)}%`
                    : formatCompactNumber(locale, Math.round(value))}
                </text>
              </g>
            );
          })}

          {mode === "requests" ? grouped.map((point, index) => {
            const values = requestValues(point.results);
            const total = Math.max(1, Object.values(values).reduce((sum, value) => sum + value, 0));
            let offset = 0;
            const barWidth = Math.max(4, Math.min(22, step * 0.62));
            return (
              <g key={point.start}>
                {requestGroups.map((key) => {
                  const raw = values[key];
                  const value = requestScale === "percent" ? raw / total * 100 : raw;
                  const top = y(offset + value);
                  const bottom = y(offset);
                  offset += value;
                  return value > 0 ? (
                    <rect
                      key={key}
                      className={`chart-result-${key}`}
                      x={x(index) - barWidth / 2}
                      y={top}
                      width={barWidth}
                      height={Math.max(1, bottom - top)}
                      rx={1.5}
                    />
                  ) : null;
                })}
                <rect
                  className="trend-hit-area"
                  x={margin.left + step * index}
                  y={margin.top}
                  width={step}
                  height={plotHeight}
                  tabIndex={0}
                  aria-label={`${formatDate(locale, point.start, true)} · ${formatNumber(locale, point.requests)} ${t("overview.requestsShort")}`}
                  onFocus={() => setSelectedIndex(index)}
                  onPointerEnter={() => setSelectedIndex(index)}
                />
              </g>
            );
          }) : (
            <>
              {tokenPaths.map((path, index) => <path className="trend-token-line" d={path} key={index} />)}
              {grouped.map((point, index) => (
                <g key={point.start}>
                  {point.tokens.observedRequests > 0 ? (
                    <circle className="trend-token-point" cx={x(index)} cy={y(tokenValue(point, tokenMetric))} r={selectedIndex === index ? 4 : 2.5} />
                  ) : null}
                  <rect
                    className="trend-hit-area"
                    x={margin.left + step * index}
                    y={margin.top}
                    width={step}
                    height={plotHeight}
                    tabIndex={0}
                    aria-label={`${formatDate(locale, point.start, true)} · ${point.tokens.observedRequests > 0
                      ? formatNumber(locale, tokenValue(point, tokenMetric))
                      : t("forwarding.notObserved")}`}
                    onFocus={() => setSelectedIndex(index)}
                    onPointerEnter={() => setSelectedIndex(index)}
                  />
                </g>
              ))}
            </>
          )}

          {grouped.map((point, index) => xLabelIndexes.has(index) ? (
            <text
              className="chart-axis-label"
              x={x(index)}
              y={height - 12}
              textAnchor={index === 0 ? "start" : index === grouped.length - 1 ? "end" : "middle"}
              key={point.start}
            >
              {bucketLabel(locale, point.start)}
            </text>
          ) : null)}
        </svg>
      </div>

      {selected ? (
        <div className="trend-selection" aria-live="polite" aria-atomic="true">
          <strong>{formatDate(locale, selected.start, true)}</strong>
          {mode === "requests" ? requestGroups.map((key) => (
            <span key={key}><i className={`legend-${key}`} />{resultLabel(key, t)} <b>{formatNumber(locale, requestValues(selected.results)[key])}</b></span>
          )) : (
            <>
              <span>{t("overview.inputTokens")} <b>{selected.tokens.observedRequests > 0 ? formatNumber(locale, selected.tokens.input) : "-"}</b></span>
              <span>{t("overview.outputTokens")} <b>{selected.tokens.observedRequests > 0 ? formatNumber(locale, selected.tokens.output) : "-"}</b></span>
              <span>{t("overview.tokenCoverageRequests")} <b>{formatNumber(locale, selected.tokens.observedRequests)}</b></span>
            </>
          )}
        </div>
      ) : null}

      <div className="visually-hidden chart-data-table">
        <table>
          <caption>{t("overview.trendData")}</caption>
          <thead><tr>
            <th>{t("common.time")}</th>
            <th>{t("overview.requestVolume")}</th>
            <th>{t("metrics.success")}</th>
            <th>{t("metrics.rejected")}</th>
            <th>{t("metrics.errors")}</th>
            <th>{t("metrics.clientAbort")}</th>
            <th>{t("overview.inputTokens")}</th>
            <th>{t("overview.outputTokens")}</th>
          </tr></thead>
          <tbody>{grouped.map((point) => {
            const results = requestValues(point.results);
            return <tr key={point.start}>
              <th>{formatDate(locale, point.start, true)}</th>
              <td>{point.requests}</td><td>{results.success}</td><td>{results.upstreamRejected}</td>
              <td>{results.error}</td><td>{results.clientAbort}</td>
              <td>{point.tokens.observedRequests > 0 ? point.tokens.input : ""}</td>
              <td>{point.tokens.observedRequests > 0 ? point.tokens.output : ""}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </div>
  );
});
