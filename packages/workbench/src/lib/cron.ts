// 5 段 cron（分 时 日 月 周）：解析 / 校验 / 人类描述 / 下次运行预览。
//
// 为什么渲染端也要一份：编辑触发时间时要即时校验，并预览「接下来几次什么时候跑」；
// 每次按键走 IPC 问宿主既慢、又要在宿主侧维护会话。宿主侧 `src-tauri/src/cron.rs`
// 是无人值守判定的权威实现。**两份语义必须一致**，改动要双向同步：
//
// - 宏：`@yearly` / `@annually`、`@monthly`、`@weekly`、`@daily` / `@midnight`、`@hourly`
// - 字段：`*`、`N`、`A-B`、`*` 步进、区间步进、`N` 步进，以及逗号列表；
//   月可用 `JAN-DEC`、周可用 `SUN-SAT`（大小写不敏感）
// - 周：`0` 与 `7` 都是周日，`1`=周一 … `6`=周六（标准 cron）
// - 日与周字段：都以 `*` 开头时按 AND；任一受限则两者都受限时按 OR（Vixie cron 语义）
// - 任一字段非法（段数不对 / 越界 / 空列表项 / 步进 0）→ 整个表达式无效，
//   运行时安全降级为「永不触发」（宁可错过，不误触发）

import { i18n } from "../i18n";

const t = i18n.global.t;

export type CronFieldName = "minute" | "hour" | "day" | "month" | "weekday";

interface FieldDef {
  name: CronFieldName;
  min: number;
  max: number;
  names: readonly (readonly [string, number])[];
}

/** 月名 → 1..12（`JAN` = 1）。 */
const MONTH_NAMES = [
  ["JAN", 1],
  ["FEB", 2],
  ["MAR", 3],
  ["APR", 4],
  ["MAY", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AUG", 8],
  ["SEP", 9],
  ["OCT", 10],
  ["NOV", 11],
  ["DEC", 12],
] as const;

/** 周名 → cron 周值（`SUN` = 0）。 */
const WEEKDAY_NAMES = [
  ["SUN", 0],
  ["MON", 1],
  ["TUE", 2],
  ["WED", 3],
  ["THU", 4],
  ["FRI", 5],
  ["SAT", 6],
] as const;

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59, names: [] },
  { name: "hour", min: 0, max: 23, names: [] },
  { name: "day", min: 1, max: 31, names: [] },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "weekday", min: 0, max: 7, names: WEEKDAY_NAMES },
];

/** 宏 → 5 段表达式（持久化时展开，避免宏与字段两套词法并存）。 */
export const CRON_MACROS: Readonly<Record<string, string>> = {
  "@YEARLY": "0 0 1 1 *",
  "@ANNUALLY": "0 0 1 1 *",
  "@MONTHLY": "0 0 1 * *",
  "@WEEKLY": "0 0 * * 0",
  "@DAILY": "0 0 * * *",
  "@MIDNIGHT": "0 0 * * *",
  "@HOURLY": "0 * * * *",
};

export interface CronSpec {
  /** 规范化表达式（宏已展开、5 段单空格分隔）；预览与回显用它。 */
  normalized: string;
  /** 命中值升序去重：分 / 时 / 日 / 月 / 周（周 0=周日）。 */
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** 日 / 周字段是否受限（非 `*` 开头）——决定两者按 OR 还是 AND 组合。 */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

export interface CronError {
  /** `automation.cron.<messageKey>`；params 供插值。 */
  messageKey: "errorEmpty" | "errorFields" | "errorField";
  field?: CronFieldName;
  min?: number;
  max?: number;
}

interface ParsedField {
  values: Set<number>;
}

function fieldValue(token: string, def: FieldDef): number | null {
  const text = token.trim().toUpperCase();
  const named = def.names.find(([name]) => name === text);
  if (named) return named[1];
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

/** 单字段解析；返回 null = 该字段非法（整个表达式随之失效）。 */
function parseField(raw: string, def: FieldDef): ParsedField | null {
  const values = new Set<number>();
  for (const rawPart of raw.split(",")) {
    const part = rawPart.trim();
    if (part === "") return null;
    const chunks = part.split("/");
    if (chunks.length > 2) return null;
    const rangeText = chunks[0].trim();
    let step = 1;
    if (chunks.length === 2) {
      const parsed = Number(chunks[1].trim());
      if (!Number.isInteger(parsed) || parsed < 1) return null;
      step = parsed;
    }
    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = def.min;
      hi = def.max;
    } else {
      const bounds = rangeText.split("-");
      if (bounds.length > 2) return null;
      const first = fieldValue(bounds[0], def);
      if (first === null) return null;
      if (bounds.length === 2) {
        const second = fieldValue(bounds[1], def);
        if (second === null) return null;
        lo = first;
        hi = second;
      } else {
        lo = first;
        hi = first;
      }
    }
    if (lo < def.min || hi > def.max || lo > hi) return null;
    for (let value = lo; value <= hi; value += step) {
      // 周字段 7 = 周日 = 0；其余字段 max < 7 不受影响。
      values.add(def.name === "weekday" ? value % 7 : value);
    }
  }
  if (values.size === 0) return null;
  return { values };
}

/** 解析为匹配用规格；null = 表达式无效。 */
export function parseCron(expr: string): CronSpec | null {
  const trimmed = expr.trim();
  if (trimmed === "") return null;
  const macro = CRON_MACROS[trimmed.toUpperCase()];
  const source = macro ?? trimmed;
  const fields = source.split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed: ParsedField[] = [];
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = parseField(fields[index], FIELDS[index]);
    if (field === null) return null;
    parsed.push(field);
  }
  const sorted = (values: Set<number>): number[] => [...values].sort((a, b) => a - b);
  return {
    normalized: fields.join(" "),
    minutes: sorted(parsed[0].values),
    hours: sorted(parsed[1].values),
    days: sorted(parsed[2].values),
    months: sorted(parsed[3].values),
    weekdays: sorted(parsed[4].values),
    daysRestricted: !fields[2].trim().startsWith("*"),
    weekdaysRestricted: !fields[4].trim().startsWith("*"),
  };
}

/** 校验表达式；null = 合法。错误按字段报，便于界面就地标红。 */
export function validateCron(expr: string): CronError | null {
  const trimmed = expr.trim();
  if (trimmed === "") return { messageKey: "errorEmpty" };
  const macro = CRON_MACROS[trimmed.toUpperCase()];
  if (!macro && trimmed.split(/\s+/).length !== 5) return { messageKey: "errorFields" };
  const fields = (macro ?? trimmed).split(/\s+/);
  for (let index = 0; index < FIELDS.length; index += 1) {
    const def = FIELDS[index];
    if (parseField(fields[index], def) === null) {
      return { messageKey: "errorField", field: def.name, min: def.min, max: def.max };
    }
  }
  return null;
}

/** 该日的月 / 日 / 周是否命中（日与周同时受限按 OR）。时与分由候选值本身保证。 */
function dayMatches(spec: CronSpec, day: Date): boolean {
  if (!spec.months.includes(day.getMonth() + 1)) return false;
  const dayHit = spec.days.includes(day.getDate());
  const weekdayHit = spec.weekdays.includes(day.getDay());
  if (spec.daysRestricted && spec.weekdaysRestricted) return dayHit || weekdayHit;
  return dayHit && weekdayHit;
}

/**
 * 严格晚于 `from` 的下 `count` 次触发时刻（本地时区）。
 * 起点取分钟边界：`from` 正落在整分则该分钟仍算候选，否则从下一分钟起。
 * 扫描上限 `horizonDays` 天（兜底防无解表达式死循环，如 `0 0 30 2 *`）。
 */
export function nextCronRuns(expr: string, from: Date, count: number, horizonDays = 730): Date[] {
  const spec = parseCron(expr);
  if (!spec || count <= 0) return [];
  const cursor = new Date(from.getTime());
  if (cursor.getSeconds() !== 0 || cursor.getMilliseconds() !== 0) {
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
  } else {
    cursor.setMilliseconds(0);
  }
  const results: Date[] = [];
  const base = { year: cursor.getFullYear(), month: cursor.getMonth(), date: cursor.getDate() };
  for (let offset = 0; offset <= horizonDays && results.length < count; offset += 1) {
    // 按日历日推进（每次从组件重算，不受夏令时偏移影响）。
    const sample = new Date(base.year, base.month, base.date + offset, 0, 0, 0, 0);
    if (!dayMatches(spec, sample)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = new Date(base.year, base.month, base.date + offset, hour, minute, 0, 0);
        if (candidate.getTime() < cursor.getTime()) continue;
        results.push(candidate);
        if (results.length >= count) return results;
      }
    }
  }
  return results;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function joinList(items: string[]): string {
  return items.join(t("automation.cron.listSeparator"));
}

function weekdayNames(values: number[], key: "weekday" | "weekdayShort"): string {
  return joinList(values.map((value) => t(`automation.cron.${key}.${value}`)));
}

function timesPhrase(hours: number[], minutes: number[], limit = 6): string | null {
  if (hours.length * minutes.length > limit) return null;
  const times: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      times.push(`${pad2(hour)}:${pad2(minute)}`);
    }
  }
  return joinList(times);
}

/**
 * 人类可读描述（当前语言）；无法简洁表达时返回 null（界面回退显示原始表达式）。
 * 只承诺常见形态：每 N 分钟 / 每 N 小时 / 每小时第 M 分 / 每天 · 每周 · 每月 · 每年定点。
 */
export function describeCron(expr: string): string | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  const { minutes, hours, days, months, weekdays, daysRestricted, weekdaysRestricted } = spec;
  const [rawMinute, rawHour] = spec.normalized.split(" ");
  const minuteStep = /^\*\/(\d+)$/.exec(rawMinute);
  if (minuteStep && rawHour === "*" && !daysRestricted && !weekdaysRestricted) {
    return t("automation.cron.everyMinutes", { count: Number(minuteStep[1]) });
  }
  const hourStep = /^\*\/(\d+)$/.exec(rawHour);
  if (minutes.length === 1 && minutes[0] === 0 && hourStep && !daysRestricted && !weekdaysRestricted) {
    return t("automation.cron.everyHours", { count: Number(hourStep[1]) });
  }
  if (hours.length === 24 && minutes.length === 1 && !daysRestricted && !weekdaysRestricted) {
    return t("automation.cron.hourlyAt", { minute: pad2(minutes[0]) });
  }
  const time = timesPhrase(hours, minutes);
  if (time === null) return null;
  const onDay = daysRestricted && weekdaysRestricted ? null : daysRestricted ? "monthly" : weekdaysRestricted ? "weekly" : "daily";
  if (onDay === "monthly" && days.length > 1) return null;
  if (months.length < 12) {
    if (onDay !== "monthly" || days.length !== 1) return null;
    return t("automation.cron.yearlyAt", {
      month: months.map((value) => t(`automation.cron.month.${value}`)).join(t("automation.cron.listSeparator")),
      day: days[0],
      time,
    });
  }
  if (onDay === "weekly") return t("automation.cron.weeklyAt", { days: weekdayNames(weekdays, "weekdayShort"), time });
  if (onDay === "monthly") return t("automation.cron.monthlyAt", { day: days[0], time });
  if (onDay === "daily") return t("automation.cron.dailyAt", { time });
  return null;
}

/* ===== 表单形态 ↔ cron =====
 * 界面按「触发方式」给结构化输入（选时间 / 选星期 / 选日），复杂表达式落到
 * 原始 cron 输入框。两个方向的映射都必须保持：反向解不出结构 → 保留原始表达式，
 * 绝不改写用户输入。 */

export type ScheduleSpec =
  | { kind: "manual" }
  /**
   * 指定日期时间跑一次（`at` = epoch ms）。
   *
   * **刻意不折算成 cron**：cron 没有年份字段，`m h d mon *` 是「每年这一天」，
   * 表达不了「就跑这一次」。一次性语义由任务上的 `onceAt` 承载（宿主调度器按
   * 时间戳判定 + 跑过即不再触发），所以这里 compose 出 null。
   */
  | { kind: "once"; at: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "yearly"; month: number; day: number; hour: number; minute: number }
  | { kind: "interval"; unit: "minute" | "hour"; every: number }
  | { kind: "cron"; expr: string };

/** 结构化输入 → cron；null = 手动触发（不排期）或一次性任务（走 `onceAt`）。 */
export function composeCron(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case "manual":
    case "once":
      return null;
    case "daily":
      return `${spec.minute} ${spec.hour} * * *`;
    case "weekly": {
      const days = [...new Set(spec.days)].sort((a, b) => a - b);
      if (days.length === 0) return null;
      return `${spec.minute} ${spec.hour} * * ${days.join(",")}`;
    }
    case "monthly":
      return `${spec.minute} ${spec.hour} ${spec.day} * *`;
    case "yearly":
      return `${spec.minute} ${spec.hour} ${spec.day} ${spec.month} *`;
    case "interval":
      return spec.unit === "minute" ? `*/${spec.every} * * * *` : `0 */${spec.every} * * *`;
    case "cron":
      return spec.expr.trim() === "" ? null : spec.expr.trim();
  }
}

/** cron → 结构化输入；解不出结构时原样保留为 `cron` 形态（不改写）。 */
export function decomposeCron(cron: string | null | undefined, onceAt?: number | null): ScheduleSpec {
  // 一次性任务优先：它的 cron 恒为 null，但即便被写脏也不该被排成循环任务。
  if (typeof onceAt === "number" && Number.isFinite(onceAt) && onceAt > 0) return { kind: "once", at: onceAt };
  const text = (cron ?? "").trim();
  if (text === "") return { kind: "manual" };
  const spec = parseCron(text);
  if (!spec) return { kind: "cron", expr: text };
  const [minuteText, hourText, dayText, monthText, weekdayText] = spec.normalized.split(" ");
  const single = (value: string, min: number, max: number): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return parsed >= min && parsed <= max ? parsed : null;
  };
  const minute = single(minuteText, 0, 59);
  const hour = single(hourText, 0, 23);
  const freeDays = dayText === "*" && monthText === "*";
  if (freeDays && weekdayText === "*") {
    const minuteStep = /^\*\/(\d+)$/.exec(minuteText);
    if (minuteStep) return { kind: "interval", unit: "minute", every: Number(minuteStep[1]) };
    const hourStep = /^\*\/(\d+)$/.exec(hourText);
    if (minuteText === "0" && hourStep) return { kind: "interval", unit: "hour", every: Number(hourStep[1]) };
  }
  if (minute === null || hour === null) return { kind: "cron", expr: text };
  if (freeDays && weekdayText === "*") return { kind: "daily", hour, minute };
  if (freeDays && /^\d+(,\d+)*$/.test(weekdayText)) return { kind: "weekly", days: spec.weekdays, hour, minute };
  if (weekdayText === "*" && /^\d+$/.test(dayText)) {
    const month = single(monthText, 1, 12);
    if (month !== null) return { kind: "yearly", month, day: Number(dayText), hour, minute };
    if (monthText === "*") return { kind: "monthly", day: Number(dayText), hour, minute };
  }
  return { kind: "cron", expr: text };
}
