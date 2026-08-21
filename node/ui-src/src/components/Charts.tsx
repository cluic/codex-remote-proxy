import { memo } from "react";

import { formatCompactNumber, formatDate, formatNumber, type Translator } from "../i18n";
import type {
  Locale,
  MetricsResultKey,
  MetricsResults,
  MetricsSeriesPoint,
  TokenTotals
} from "../types";

const resultKeys: MetricsResultKey[] = [
  "success",
  "upstreamRejected",
  "upstreamError",
  "timeout",
  "networkError",
  "clientAbort"
];

const overviewResultKeys = ["success", "upstreamRejected", "error"] as const;
type OverviewResultKey = typeof overviewResultKeys[number];

const emptyResults = (): MetricsResults => ({
  success: 0,
  upstreamRejected: 0,
  upstreamError: 0,
  timeout: 0,
  networkError: 0,
  clientAbort: 0
});

function groupSeries(series: MetricsSeriesPoint[], maximum = 28): MetricsSeriesPoint[] {
  if (series.length <= maximum) return series;
  const size = Math.ceil(series.length / maximum);
  const grouped: MetricsSeriesPoint[] = [];
  for (let index = 0; index < series.length; index += size) {
    const slice = series.slice(index, index + size);
    const first = slice[0];
    if (!first) continue;
    const results = emptyResults();
    const tokens: TokenTotals = { input: 0, output: 0, observedRequests: 0 };
    let requests = 0;
    for (const point of slice) {
      requests += point.requests;
      for (const key of resultKeys) results[key] += point.results[key];
      tokens.input += point.tokens.input;
      tokens.output += point.tokens.output;
      tokens.observedRequests += point.tokens.observedRequests;
    }
    grouped.push({ start: first.start, requests, results, tokens });
  }
  return grouped;
}

function resultLabels(t: Translator): Record<MetricsResultKey, string> {
  return {
    success: t("metrics.success"),
    upstreamRejected: t("metrics.rejected"),
    upstreamError: t("metrics.upstreamError"),
    timeout: t("metrics.timeout"),
    networkError: t("metrics.networkError"),
    clientAbort: t("metrics.clientAbort")
  };
}

function overviewResults(results: MetricsResults): Record<OverviewResultKey, number> {
  return {
    success: results.success,
    upstreamRejected: results.upstreamRejected,
    error: results.upstreamError + results.timeout + results.networkError + results.clientAbort
  };
}

export const ResultsChart = memo(function ResultsChart({
  series,
  locale,
  t,
  showLegend = true
}: {
  series: MetricsSeriesPoint[];
  locale: Locale;
  t: Translator;
  showLegend?: boolean;
}) {
  const labels = resultLabels(t);
  const points = groupSeries(series);
  const width = 720;
  const plotHeight = 334;
  const baseline = 354;
  const plotStart = 38;
  const plotWidth = 664;
  const maxRequests = Math.max(1, ...points.map((point) => point.requests));
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(4, slot - 4);
  const labelIndexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);

  return (
    <div className="chart-wrap">
      {showLegend ? (
        <div className="chart-legend" aria-hidden="true">
          <span><i className="legend-success" />{labels.success}</span>
          <span><i className="legend-upstreamRejected" />{labels.upstreamRejected}</span>
          <span><i className="legend-error" />{t("metrics.errors")}</span>
        </div>
      ) : null}
      <svg className="chart chart-results" viewBox={`0 0 ${width} 410`} role="img" aria-label={t("overview.requestTrend")}>
        <title>{t("overview.requestTrend")}</title>
        {[0, 0.5, 1].map((ratio) => {
          const y = baseline - ratio * plotHeight;
          return <line key={ratio} className="chart-grid" x1={plotStart} x2={plotStart + plotWidth} y1={y} y2={y} />;
        })}
        {points.map((point, pointIndex) => {
          const x = plotStart + pointIndex * slot + (slot - barWidth) / 2;
          const displayed = overviewResults(point.results);
          let used = 0;
          return (
            <g key={`${point.start}-${pointIndex}`}>
              {overviewResultKeys.map((key) => {
                const value = displayed[key];
                const height = value / maxRequests * plotHeight;
                const y = baseline - used - height;
                used += height;
                return height > 0 ? (
                  <rect
                    key={key}
                    className={`chart-result-${key}`}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={height}
                    rx="1"
                  />
                ) : null;
              })}
              {labelIndexes.has(pointIndex) ? (
                <text className="chart-axis-label" x={x + barWidth / 2} y="396" textAnchor="middle">
                  {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit" }).format(new Date(point.start))}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="visually-hidden">
        <table>
          <caption>{t("overview.requestTrend")}</caption>
          <thead><tr><th>{t("common.time")}</th><th>{t("overview.requestVolume")}</th>{resultKeys.map((key) => <th key={key}>{labels[key]}</th>)}</tr></thead>
          <tbody>{points.map((point) => (
            <tr key={point.start}>
              <th>{formatDate(locale, point.start)}</th>
              <td>{point.requests}</td>
              {resultKeys.map((key) => <td key={key}>{point.results[key]}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
});

function linePoints(values: number[], maximum: number, width: number, height: number, x: number, y: number): string {
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => (
    `${x + index * step},${y + height - value / maximum * height}`
  )).join(" ");
}

export const TokenChart = memo(function TokenChart({
  series,
  locale,
  t,
  showLegend = true
}: {
  series: MetricsSeriesPoint[];
  locale: Locale;
  t: Translator;
  showLegend?: boolean;
}) {
  const points = groupSeries(series);
  const input = points.map((point) => point.tokens.input);
  const output = points.map((point) => point.tokens.output);
  const maximum = Math.max(1, ...input, ...output);
  const observed = points.reduce((sum, point) => sum + point.tokens.observedRequests, 0);
  if (observed === 0) {
    return <div className="chart-empty">{t("overview.noTokenUsage")}</div>;
  }
  return (
    <div className="chart-wrap">
      {showLegend ? (
        <div className="chart-legend" aria-hidden="true">
          <span><i className="legend-input" />{t("overview.inputTokens")}</span>
          <span><i className="legend-output" />{t("overview.outputTokens")}</span>
        </div>
      ) : null}
      <svg className="chart chart-token" viewBox="0 0 460 410" role="img" aria-label={t("overview.tokenTrend")}>
        <title>{t("overview.tokenTrend")}</title>
        {[20, 187, 354].map((y) => <line key={y} className="chart-grid" x1="26" x2="444" y1={y} y2={y} />)}
        <polyline
          className="token-line-input"
          points={linePoints(input, maximum, 418, 334, 26, 20)}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="token-line-output"
          points={linePoints(output, maximum, 418, 334, 26, 20)}
          vectorEffect="non-scaling-stroke"
        />
        <text className="chart-axis-label" x="26" y="396">{points[0] ? formatDate(locale, points[0].start) : ""}</text>
        <text className="chart-axis-label" x="444" y="396" textAnchor="end">
          {points.at(-1) ? formatDate(locale, points.at(-1)?.start ?? null) : ""}
        </text>
      </svg>
      <div className="visually-hidden">
        <table>
          <caption>{t("overview.tokenTrend")}</caption>
          <thead><tr><th>{t("common.time")}</th><th>{t("overview.inputTokens")}</th><th>{t("overview.outputTokens")}</th><th>{t("overview.requestVolume")}</th></tr></thead>
          <tbody>{points.map((point) => (
            <tr key={point.start}>
              <th>{formatDate(locale, point.start)}</th>
              <td>{point.tokens.input}</td>
              <td>{point.tokens.output}</td>
              <td>{point.tokens.observedRequests}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
});

export const DistributionChart = memo(function DistributionChart({
  items,
  locale,
  title,
  t
}: {
  items: Array<{ label: string; value: number }>;
  locale: Locale;
  title: string;
  t: Translator;
}) {
  const visible = items;
  const maximum = Math.max(1, ...visible.map((item) => item.value));
  const rowHeight = 38;
  const height = Math.max(78, visible.length * rowHeight + 20);
  return (
    <div className="distribution-chart">
      <svg viewBox={`0 0 720 ${height}`} role="img" aria-label={title}>
        <title>{title}</title>
        {visible.map((item, index) => {
          const y = index * rowHeight + 8;
          const width = item.value / maximum * 330;
          return (
            <g key={`${item.label}-${index}`}>
              <title>{item.label}</title>
              <text className="distribution-label" x="0" y={y + 17}>
                {item.label.length > 30 ? `${item.label.slice(0, 27)}...` : item.label}
              </text>
              <rect className="distribution-track" x="270" y={y} width="330" height="22" rx="3" />
              <rect className="distribution-value" x="270" y={y} width={width} height="22" rx="3" />
              <text className="distribution-count" x="710" y={y + 17} textAnchor="end">
                {formatCompactNumber(locale, item.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="visually-hidden">
        <table>
          <caption>{title}</caption>
          <thead><tr><th>{t("metrics.group")}</th><th>{t("overview.requestVolume")}</th></tr></thead>
          <tbody>{visible.map((item, index) => (
            <tr key={`${item.label}-${index}`}><th>{item.label}</th><td>{formatNumber(locale, item.value)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
});
