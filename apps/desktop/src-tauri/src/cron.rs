//! 5 段 cron 解析与匹配（分 时 日 月 周）——宿主侧权威实现。
//!
//! 渲染端 `packages/workbench/src/lib/cron.ts` 有一份同语义的 TS 实现（编辑时即时
//! 校验与预览下次运行）；两份必须一致，改动双向同步。语义：
//! - 宏：@yearly / @annually / @monthly / @weekly / @daily / @midnight / @hourly
//! - 字段：`*`、`N`、`A-B`、星号或区间带步进、`N` 带步进，逗号列表；月名 JAN-DEC、
//!   周名 SUN-SAT（大小写不敏感）
//! - 周：0 与 7 都是周日，1=周一 … 6=周六（标准 cron）
//! - 日与周字段：都以 `*` 开头 → AND；任一受限 → 两者都受限时 OR（Vixie cron 语义）
//! - 非法表达式（段数不对 / 越界 / 空列表项 / 步进 0）→ **永不匹配**：
//!   宁可错过一次，也不按误读的时间触发。

const MONTH_NAMES: [(&str, u32); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const WEEKDAY_NAMES: [(&str, u32); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

/// 宏 → 5 段表达式。
const MACROS: [(&str, &str); 7] = [
    ("@YEARLY", "0 0 1 1 *"),
    ("@ANNUALLY", "0 0 1 1 *"),
    ("@MONTHLY", "0 0 1 * *"),
    ("@WEEKLY", "0 0 * * 0"),
    ("@DAILY", "0 0 * * *"),
    ("@MIDNIGHT", "0 0 * * *"),
    ("@HOURLY", "0 * * * *"),
];

/// 编译后的表达式：逐值布尔表（`u32` 组件直接下标查表，无哈希、无分配）。
pub struct CronSpec {
    minutes: [bool; 60],
    hours: [bool; 24],
    days: [bool; 32],
    months: [bool; 13],
    weekdays: [bool; 7],
    days_restricted: bool,
    weekdays_restricted: bool,
}

impl CronSpec {
    fn new() -> Self {
        Self {
            minutes: [false; 60],
            hours: [false; 24],
            days: [false; 32],
            months: [false; 13],
            weekdays: [false; 7],
            days_restricted: false,
            weekdays_restricted: false,
        }
    }

    /// 该时刻是否命中。`month` / `day` 为 1 起算的日历值，
    /// `cron_weekday` 为 0=周日 … 6=周六（chrono 的 `num_days_from_sunday`）。
    pub fn matches(&self, month: u32, day: u32, cron_weekday: u32, hour: u32, minute: u32) -> bool {
        if minute > 59 || hour > 23 || day > 31 || month > 12 || cron_weekday > 6 {
            return false;
        }
        if !self.minutes[minute as usize] || !self.hours[hour as usize] || !self.months[month as usize]
        {
            return false;
        }
        let day_hit = self.days[day as usize];
        let weekday_hit = self.weekdays[cron_weekday as usize];
        if self.days_restricted && self.weekdays_restricted {
            day_hit || weekday_hit
        } else {
            day_hit && weekday_hit
        }
    }
}

/// 解析表达式；None = 非法（调用方按「永不触发」处理）。
pub fn parse(expr: &str) -> Option<CronSpec> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    let source = MACROS
        .iter()
        .find(|(name, _)| *name == upper)
        .map(|(_, expansion)| *expansion)
        .unwrap_or(trimmed);
    let fields: Vec<&str> = source.split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }
    let mut spec = CronSpec::new();
    for value in parse_field(fields[0], 0, 59, &[])? {
        spec.minutes[value as usize] = true;
    }
    for value in parse_field(fields[1], 0, 23, &[])? {
        spec.hours[value as usize] = true;
    }
    for value in parse_field(fields[2], 1, 31, &[])? {
        spec.days[value as usize] = true;
    }
    for value in parse_field(fields[3], 1, 12, &MONTH_NAMES)? {
        spec.months[value as usize] = true;
    }
    for value in parse_field(fields[4], 0, 7, &WEEKDAY_NAMES)? {
        spec.weekdays[(value % 7) as usize] = true; // 7 = 周日 = 0
    }
    spec.days_restricted = !fields[2].trim_start().starts_with('*');
    spec.weekdays_restricted = !fields[4].trim_start().starts_with('*');
    Some(spec)
}

/// 便捷入口：解析 + 匹配（非法表达式 → false）。
pub fn matches(expr: &str, month: u32, day: u32, cron_weekday: u32, hour: u32, minute: u32) -> bool {
    parse(expr)
        .map(|spec| spec.matches(month, day, cron_weekday, hour, minute))
        .unwrap_or(false)
}

/// 单字段展开为值列表；None = 非法。
fn parse_field(raw: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Option<Vec<u32>> {
    let mut values = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        let (range_text, step) = match part.split_once('/') {
            Some((range, step_text)) => {
                if step_text.contains('/') {
                    return None;
                }
                let step = step_text.trim().parse::<u32>().ok()?;
                if step == 0 {
                    return None;
                }
                (range.trim(), step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if range_text == "*" {
            (min, max)
        } else if let Some((from, to)) = range_text.split_once('-') {
            (field_value(from.trim(), names)?, field_value(to.trim(), names)?)
        } else {
            let value = field_value(range_text, names)?;
            (value, value)
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut value = lo;
        while value <= hi {
            values.push(value);
            value += step;
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

/// 词元 → 值：先查名称表（月 / 周），再按数字解析。
fn field_value(token: &str, names: &[(&str, u32)]) -> Option<u32> {
    let upper = token.to_ascii_uppercase();
    if let Some((_, value)) = names.iter().find(|(name, _)| *name == upper) {
        return Some(*value);
    }
    upper.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 组件顺序：月 日 cron 周 时 分。
    fn hit(expr: &str, month: u32, day: u32, weekday: u32, hour: u32, minute: u32) -> bool {
        matches(expr, month, day, weekday, hour, minute)
    }

    #[test]
    fn every_minute_wildcard() {
        assert!(hit("* * * * *", 9, 14, 1, 10, 30));
        assert!(hit("* * * * *", 2, 1, 0, 0, 0));
    }

    #[test]
    fn exact_hour_minute_daily() {
        // 每天 09:00
        assert!(hit("0 9 * * *", 9, 14, 1, 9, 0));
        assert!(!hit("0 9 * * *", 9, 14, 1, 8, 59));
        assert!(!hit("0 9 * * *", 9, 14, 1, 9, 1));
        assert!(hit("0 9 * * *", 12, 25, 3, 9, 0), "每日不限月日周");
    }

    #[test]
    fn weekday_is_standard_cron_semantics() {
        // 每周五 18:00：周五 = 5（0/7 = 周日）
        assert!(hit("0 18 * * 5", 9, 18, 5, 18, 0));
        assert!(!hit("0 18 * * 5", 9, 17, 4, 18, 0), "周四不触发");
        assert!(!hit("0 18 * * 5", 9, 18, 5, 17, 0));
        // 0 与 7 都是周日
        assert!(hit("0 0 * * 0", 9, 20, 0, 0, 0));
        assert!(hit("0 0 * * 7", 9, 20, 0, 0, 0));
        assert!(!hit("0 0 * * 7", 9, 20, 1, 0, 0), "周一不是周日");
    }

    #[test]
    fn weekday_and_month_names() {
        assert!(hit("0 9 * * MON-FRI", 9, 14, 1, 9, 0), "周一名命中");
        assert!(!hit("0 9 * * MON-FRI", 9, 19, 6, 9, 0), "周六不命中");
        assert!(hit("0 0 1 JAN-MAR *", 2, 1, 0, 0, 0), "FEB 在区间内");
        assert!(!hit("0 0 1 JAN-MAR *", 4, 1, 0, 0, 0), "APR 不在区间内");
    }

    #[test]
    fn day_of_month_restriction() {
        assert!(hit("0 9 15 * *", 9, 15, 2, 9, 0));
        assert!(!hit("0 9 15 * *", 9, 16, 2, 9, 0));
        assert!(hit("0 9 1,15 * *", 10, 1, 4, 9, 0));
    }

    #[test]
    fn day_or_weekday_when_both_restricted() {
        // 每月 1 日或每周一 09:00（OR 语义）
        assert!(hit("0 9 1 * 1", 9, 1, 2, 9, 0), "1 日命中（周几无关）");
        assert!(hit("0 9 1 * 1", 9, 14, 1, 9, 0), "周一命中（1 日无关）");
        assert!(!hit("0 9 1 * 1", 9, 15, 2, 9, 0), "两者都不满足");
        // 任一字段以 * 开头 → AND（*/2 按 Vixie cron 从字段下界展开：日字段下界是 1，
        // 故 */2 = 1,3,5… 奇数日）
        assert!(hit("0 9 */2 * 1", 9, 15, 1, 9, 0), "周一 + 奇数日");
        assert!(!hit("0 9 */2 * 1", 9, 14, 1, 9, 0), "周一但偶数日");
        assert!(!hit("0 9 1 * *", 9, 14, 1, 9, 0), "日受限、周自由 → 只看日");
    }

    #[test]
    fn steps_ranges_and_lists() {
        assert!(hit("*/15 * * * *", 9, 14, 1, 12, 0));
        assert!(hit("*/15 * * * *", 9, 14, 1, 12, 45));
        assert!(!hit("*/15 * * * *", 9, 14, 1, 12, 20));
        assert!(hit("0 9-11 * * *", 9, 14, 1, 10, 0));
        assert!(!hit("0 9-11 * * *", 9, 14, 1, 12, 0));
        assert!(hit("0 9,18 * * *", 9, 14, 1, 18, 0));
        assert!(!hit("0 9,18 * * *", 9, 14, 1, 12, 0));
        assert!(hit("0-30/15 * * * *", 9, 14, 1, 0, 30));
        assert!(!hit("0-30/15 * * * *", 9, 14, 1, 0, 45));
    }

    #[test]
    fn macros_expand_to_five_fields() {
        assert!(hit("@daily", 9, 14, 1, 0, 0));
        assert!(!hit("@daily", 9, 14, 1, 9, 0));
        assert!(hit("@hourly", 9, 14, 1, 7, 0));
        assert!(hit("@weekly", 9, 20, 0, 0, 0), "周日 00:00");
        assert!(hit("@monthly", 9, 1, 2, 0, 0));
        assert!(hit("@yearly", 1, 1, 4, 0, 0));
    }

    #[test]
    fn invalid_expression_never_matches() {
        assert!(!hit("", 9, 14, 1, 0, 0));
        assert!(!hit("0 9 * *", 9, 14, 1, 9, 0), "四段非法");
        assert!(!hit("0 9 * * * *", 9, 14, 1, 9, 0), "六段非法");
        assert!(!hit("x x x x x", 9, 14, 1, 9, 0));
        assert!(!hit("0 25 * * *", 9, 14, 1, 9, 0), "越界时字段");
        assert!(!hit("60 9 * * *", 9, 14, 1, 9, 0), "越界分字段");
        assert!(!hit("0 9 32 * *", 9, 14, 1, 9, 0), "越界日字段");
        assert!(!hit("0 9 * * 8", 9, 14, 1, 9, 0), "越界周字段");
        assert!(!hit("*/0 * * * *", 9, 14, 1, 9, 0), "步进 0");
        assert!(!hit("0 9,,10 * * *", 9, 14, 1, 9, 0), "空列表项");
    }

    #[test]
    fn out_of_range_components_never_match() {
        assert!(!hit("* * * * *", 13, 14, 1, 10, 0));
        assert!(!hit("* * * * *", 9, 32, 1, 10, 0));
        assert!(!hit("* * * * *", 9, 14, 7, 10, 0));
        assert!(!hit("* * * * *", 9, 14, 1, 10, 60));
    }
}
