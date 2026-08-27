import { memo, useMemo, useState } from "react";

import { ApiError } from "../api";
import {
  formatNumber,
  type Translator
} from "../i18n";
import type { Locale, TokenHeatmapDay, TokenHeatmapOverview } from "../types";

type HeatmapCell = TokenHeatmapDay & {
  key: string;
  state: "empty" | "unobserved" | "partial" | "observed";
  total: number;
  level: number;
};

type HeatmapWeek = {
  key: string;
  days: Array<HeatmapCell | null>;
};

function utcDayKey(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString().slice(0, 10);
}

function utcDate(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function addUtcDays(dayKey: string, days: number): string {
  const date = utcDate(dayKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatUtcDate(locale: Locale, dayKey: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(utcDate(dayKey));
}

function dayState(day: TokenHeatmapDay): HeatmapCell["state"] {
  if (day.requests === 0) return "empty";
  if (day.tokens.observedRequests === 0) return "unobserved";
  if (day.tokens.observedRequests < day.requests) return "partial";
  return "observed";
}

function buildWeeks(days: TokenHeatmapDay[], maximum: number): { cells: HeatmapCell[]; weeks: HeatmapWeek[] } {
  const byDay = new Map<string, TokenHeatmapDay>();
  for (const day of days) {
    const key = utcDayKey(day.start);
    if (key !== null) byDay.set(key, day);
  }
  const keys = [...byDay.keys()].sort();
  if (keys.length === 0) return { cells: [], weeks: [] };

  const first = keys[0];
  if (!first) return { cells: [], weeks: [] };
  const last = keys.at(-1) ?? first;
  const firstDate = utcDate(first);
  const lastDate = utcDate(last);
  const weekStart = addUtcDays(first, -firstDate.getUTCDay());
  const weekEnd = addUtcDays(last, 6 - lastDate.getUTCDay());
  const cells: HeatmapCell[] = [];
  const weeks: HeatmapWeek[] = [];
  for (let start = weekStart; start <= weekEnd; start = addUtcDays(start, 7)) {
    const weekDays: Array<HeatmapCell | null> = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const key = addUtcDays(start, weekday);
      const day = byDay.get(key);
      if (!day) {
        weekDays.push(null);
        continue;
      }
      const total = day.tokens.input + day.tokens.output;
      const state = dayState(day);
      const cell = {
        ...day,
        key,
        state,
        total,
        level: state === "empty" || state === "unobserved" || maximum <= 0
          ? 0
          : Math.max(1, Math.min(4, Math.ceil(total / maximum * 4)))
      } satisfies HeatmapCell;
      cells.push(cell);
      weekDays.push(cell);
    }
    weeks.push({ key: start, days: weekDays });
  }
  return { cells, weeks };
}

function cellLabel(locale: Locale, cell: HeatmapCell, t: Translator): string {
  const date = formatUtcDate(locale, cell.key, { dateStyle: "medium" });
  if (cell.state === "empty") return `${date} · ${t("overview.heatmapNoRequests")}`;
  if (cell.state === "unobserved") {
    return `${date} · ${formatNumber(locale, cell.requests)} ${t("overview.requestsShort")} · ${t("overview.heatmapUnobserved")}`;
  }
  return `${date} · ${formatNumber(locale, cell.total)} ${t("overview.totalTokens")} · ${formatNumber(locale, cell.requests)} ${t("overview.requestsShort")}`;
}

function cellDetail(locale: Locale, cell: HeatmapCell, t: Translator): string {
  if (cell.state === "empty") return t("overview.heatmapNoRequests");
  if (cell.state === "unobserved") return t("overview.heatmapUnobserved");
  return cell.state === "partial"
    ? t("overview.heatmapPartial", { observed: formatNumber(locale, cell.tokens.observedRequests), total: formatNumber(locale, cell.requests) })
    : t("overview.heatmapComplete");
}

export const DailyTokenHeatmap = memo(function DailyTokenHeatmap({
  heatmap,
  error,
  locale,
  t
}: {
  heatmap: TokenHeatmapOverview | null;
  error: ApiError | null;
  locale: Locale;
  t: Translator;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const days = heatmap?.days ?? [];
  const maximum = useMemo(() => Math.max(0, ...days.map((day) => (
    day.tokens.observedRequests > 0 ? day.tokens.input + day.tokens.output : 0
  ))), [days]);
  const { cells, weeks } = useMemo(() => buildWeeks(days, maximum), [days, maximum]);
  const unavailable = error !== null || heatmap?.storageState === "unavailable";
  const selected = cells.find((cell) => cell.key === selectedKey)
    ?? [...cells].reverse().find((cell) => cell.state !== "empty")
    ?? cells.at(-1)
    ?? null;
  const weekdays = Array.from({ length: 7 }, (_, index) => formatUtcDate(
    locale,
    `2024-01-${String(7 + index).padStart(2, "0")}`,
    { weekday: "short" }
  ));

  return (
    <div className="token-heatmap" data-testid="token-heatmap">
      {unavailable ? (
        <div className="token-heatmap-error" role="status">
          <strong>{t("overview.heatmapUnavailable")}</strong>
          <span>{t("overview.heatmapUnavailableHelp")}</span>
          {error ? <code>{error.code}</code> : null}
        </div>
      ) : weeks.length === 0 ? (
        <div className="token-heatmap-empty" role="status">{t("overview.heatmapNoData")}</div>
      ) : (
        <>
          <div className="token-heatmap-scroll layout-contained-scroll">
            <div className="token-heatmap-calendar" aria-label={t("overview.heatmapDescription")}>
              <div className="token-heatmap-months" aria-hidden="true">
                <span />
                <div className="token-heatmap-week-grid">
                  {weeks.map((week, index) => {
                    const firstDay = week.days.find(Boolean);
                    const showMonth = index === 0 || firstDay?.key.slice(0, 7) !== weeks[index - 1]?.days.find(Boolean)?.key.slice(0, 7);
                    return <span key={week.key}>{showMonth && firstDay ? formatUtcDate(locale, firstDay.key, { month: "short" }) : ""}</span>;
                  })}
                </div>
              </div>
              <div className="token-heatmap-body">
                <div className="token-heatmap-weekdays" aria-hidden="true">
                  {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
                </div>
                <div className="token-heatmap-week-grid" role="group" aria-label={t("overview.heatmapDescription")}>
                  {weeks.map((week) => (
                    <div className="token-heatmap-week" key={week.key}>
                      {week.days.map((cell, index) => cell ? (
                        <button
                          className={`token-heatmap-cell token-heatmap-cell-level-${cell.level}${cell.state === "partial" ? " is-partial" : ""}${cell.state === "unobserved" ? " is-unobserved" : ""}`}
                          type="button"
                          key={cell.key}
                          aria-label={cellLabel(locale, cell, t)}
                          aria-pressed={selected?.key === cell.key}
                          data-state={cell.state}
                          onClick={() => setSelectedKey(cell.key)}
                          onFocus={() => setSelectedKey(cell.key)}
                          onPointerEnter={() => setSelectedKey(cell.key)}
                        />
                      ) : <span className="token-heatmap-cell token-heatmap-cell-placeholder" aria-hidden="true" key={`${week.key}-${index}`} />)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="token-heatmap-legend" aria-label={t("overview.heatmapLegend")}>
            <span>{t("overview.heatmapLess")}</span>
            {[0, 1, 2, 3, 4].map((level) => <i className={`token-heatmap-cell-level-${level}`} key={level} aria-hidden="true" />)}
            <span>{t("overview.heatmapMore")}</span>
            <span className="token-heatmap-legend-unobserved"><i />{t("overview.heatmapUnobservedShort")}</span>
          </div>
          <div className="token-heatmap-selection" aria-live="polite" aria-atomic="true">
            {selected ? (
              <>
                <strong>{formatUtcDate(locale, selected.key, { dateStyle: "medium" })}</strong>
                <span>{t("overview.totalTokens")} <b>{selected.state === "unobserved" ? "-" : formatNumber(locale, selected.total)}</b></span>
                <span>{t("overview.inputTokens")} <b>{selected.state === "unobserved" ? "-" : formatNumber(locale, selected.tokens.input)}</b></span>
                <span>{t("overview.outputTokens")} <b>{selected.state === "unobserved" ? "-" : formatNumber(locale, selected.tokens.output)}</b></span>
                <span>{t("overview.tokenCoverageRequests")} <b>{formatNumber(locale, selected.tokens.observedRequests)} / {formatNumber(locale, selected.requests)}</b></span>
                <small>{cellDetail(locale, selected, t)}</small>
              </>
            ) : <span>{t("overview.heatmapNoData")}</span>}
          </div>
          <div className="visually-hidden chart-data-table">
            <table>
              <caption>{t("overview.heatmapData")}</caption>
              <thead><tr><th>{t("common.time")}</th><th>{t("overview.requestVolume")}</th><th>{t("overview.totalTokens")}</th><th>{t("overview.inputTokens")}</th><th>{t("overview.outputTokens")}</th><th>{t("overview.tokenCoverageRequests")}</th></tr></thead>
              <tbody>{cells.map((cell) => <tr key={cell.key}>
                <th>{formatUtcDate(locale, cell.key, { dateStyle: "medium" })}</th>
                <td>{cell.requests}</td><td>{cell.state === "unobserved" ? "" : cell.total}</td>
                <td>{cell.state === "unobserved" ? "" : cell.tokens.input}</td><td>{cell.state === "unobserved" ? "" : cell.tokens.output}</td>
                <td>{cell.tokens.observedRequests} / {cell.requests}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
});
