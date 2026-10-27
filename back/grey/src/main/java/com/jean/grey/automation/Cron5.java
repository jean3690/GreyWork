package com.jean.grey.automation;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * 标准 5 段 cron（分 时 日 月 周）的解析与下次触发计算。
 *
 * <p>
 * 语义必须与渲染端 {@code packages/workbench/src/lib/cron.ts} 和宿主 {@code cron.rs} 保持一致：
 * <ul>
 * <li>宏：{@code @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly}</li>
 * <li>字段：{@code *}、{@code N}、{@code A-B}、{@code *}{@code /n}、{@code A-B/n}、{@code N/n}，逗号列表</li>
 * <li>月可用 {@code JAN-DEC}，周可用 {@code SUN-SAT}；周 0 与 7 都是周日</li>
 * <li>日与周都受限时按 OR（Vixie cron）；任一为 {@code *} 时按 AND</li>
 * <li>无效表达式解析为 null，运行时安全降级为「永不触发」</li>
 * </ul>
 *
 * <p>
 * 这里只做「下一次」计算，不做秒级调度；调用方拿到结果后写入 {@code next_run_at}，
 * 由定时扫描批量推进，避免每个任务各挂一个定时器。
 */
public final class Cron5 {

	private static final Map<String, String> MACROS = Map.ofEntries(
			Map.entry("@YEARLY", "0 0 1 1 *"),
			Map.entry("@ANNUALLY", "0 0 1 1 *"),
			Map.entry("@MONTHLY", "0 0 1 * *"),
			Map.entry("@WEEKLY", "0 0 * * 0"),
			Map.entry("@DAILY", "0 0 * * *"),
			Map.entry("@MIDNIGHT", "0 0 * * *"),
			Map.entry("@HOURLY", "0 * * * *"));

	/** 最多向后找 5 年；覆盖 2/29 等长周期表达式。 */
	private static final int MAX_DAYS = 366 * 5;

	private static final Map<Field, FieldDef> DEFS = new EnumMap<>(Field.class);

	static {
		DEFS.put(Field.MINUTE, new FieldDef(0, 59, Map.of(), false));
		DEFS.put(Field.HOUR, new FieldDef(0, 23, Map.of(), false));
		DEFS.put(Field.DAY, new FieldDef(1, 31, Map.of(), false));
		DEFS.put(Field.MONTH, new FieldDef(1, 12, Map.ofEntries(
				Map.entry("JAN", 1), Map.entry("FEB", 2), Map.entry("MAR", 3), Map.entry("APR", 4),
				Map.entry("MAY", 5), Map.entry("JUN", 6), Map.entry("JUL", 7), Map.entry("AUG", 8),
				Map.entry("SEP", 9), Map.entry("OCT", 10), Map.entry("NOV", 11), Map.entry("DEC", 12)),
				false));
		DEFS.put(Field.WEEKDAY, new FieldDef(0, 7, Map.ofEntries(
				Map.entry("SUN", 0), Map.entry("MON", 1), Map.entry("TUE", 2), Map.entry("WED", 3),
				Map.entry("THU", 4), Map.entry("FRI", 5), Map.entry("SAT", 6)), true));
	}

	private final String normalized;
	private final Set<Integer> minutes;
	private final Set<Integer> hours;
	private final Set<Integer> days;
	private final Set<Integer> months;
	private final Set<Integer> weekdays;
	private final boolean daysRestricted;
	private final boolean weekdaysRestricted;

	private Cron5(String normalized, Set<Integer> minutes, Set<Integer> hours, Set<Integer> days,
			Set<Integer> months, Set<Integer> weekdays, boolean daysRestricted,
			boolean weekdaysRestricted) {
		this.normalized = normalized;
		this.minutes = minutes;
		this.hours = hours;
		this.days = days;
		this.months = months;
		this.weekdays = weekdays;
		this.daysRestricted = daysRestricted;
		this.weekdaysRestricted = weekdaysRestricted;
	}

	/** 解析表达式；非法返回 null。 */
	public static Cron5 parse(String expression) {
		if (expression == null || expression.isBlank()) {
			return null;
		}
		String trimmed = expression.trim();
		String expanded = MACROS.getOrDefault(trimmed.toUpperCase(Locale.ROOT), trimmed);
		String[] fields = expanded.split("\\s+");
		if (fields.length != 5) {
			return null;
		}

		Set<Integer> minutes = parseField(fields[0], DEFS.get(Field.MINUTE));
		Set<Integer> hours = parseField(fields[1], DEFS.get(Field.HOUR));
		Set<Integer> days = parseField(fields[2], DEFS.get(Field.DAY));
		Set<Integer> months = parseField(fields[3], DEFS.get(Field.MONTH));
		Set<Integer> weekdays = parseField(fields[4], DEFS.get(Field.WEEKDAY));
		if (minutes == null || hours == null || days == null || months == null || weekdays == null) {
			return null;
		}
		return new Cron5(String.join(" ", fields), minutes, hours, days, months, weekdays,
				!fields[2].startsWith("*"), !fields[4].startsWith("*"));
	}

	public static boolean isValid(String expression) {
		return parse(expression) != null;
	}

	/** 规范化后的 5 段表达式（宏已展开）。 */
	public String normalized() {
		return normalized;
	}

	/**
	 * 下一次触发时刻（严格晚于 {@code after}）；5 年内找不到返回 null。
	 */
	public LocalDateTime next(LocalDateTime after, ZoneId zone) {
		ZonedDateTime cursor = after.atZone(zone)
				.withSecond(0)
				.withNano(0)
				.plusMinutes(1);
		LocalDate limit = after.toLocalDate().plusDays(MAX_DAYS);
		while (!cursor.toLocalDate().isAfter(limit)) {
			if (!months.contains(cursor.getMonthValue())) {
				cursor = nextMonth(cursor, zone);
				continue;
			}
			if (!dayMatches(cursor)) {
				cursor = startOfDay(cursor.toLocalDate().plusDays(1), zone);
				continue;
			}
			if (!hours.contains(cursor.getHour())) {
				cursor = nextHour(cursor, zone);
				continue;
			}
			if (!minutes.contains(cursor.getMinute())) {
				cursor = cursor.plusMinutes(1);
				continue;
			}
			return cursor.toLocalDateTime();
		}
		return null;
	}

	private boolean dayMatches(ZonedDateTime cursor) {
		boolean dayOk = days.contains(cursor.getDayOfMonth());
		// Java: MON=1..SUN=7；cron: SUN=0, MON=1..SAT=6
		boolean weekOk = weekdays.contains(cursor.getDayOfWeek().getValue() % 7);
		return daysRestricted && weekdaysRestricted ? (dayOk || weekOk) : (dayOk && weekOk);
	}

	private static ZonedDateTime nextMonth(ZonedDateTime cursor, ZoneId zone) {
		LocalDate first = cursor.toLocalDate().withDayOfMonth(1).plusMonths(1);
		return startOfDay(first, zone);
	}

	private static ZonedDateTime nextHour(ZonedDateTime cursor, ZoneId zone) {
		ZonedDateTime next = cursor.plusHours(1).withMinute(0);
		if (next.getDayOfMonth() != cursor.getDayOfMonth()) {
			return startOfDay(next.toLocalDate(), zone);
		}
		return next;
	}

	private static ZonedDateTime startOfDay(LocalDate date, ZoneId zone) {
		return date.atStartOfDay(zone);
	}

	private static Set<Integer> parseField(String raw, FieldDef def) {
		if (raw == null || raw.isEmpty()) {
			return null;
		}
		Set<Integer> values = new TreeSet<>();
		for (String rawPart : raw.split(",", -1)) {
			String part = rawPart.trim();
			if (part.isEmpty()) {
				return null;
			}
			String[] chunks = part.split("/", -1);
			if (chunks.length > 2 || chunks[0].isEmpty() || (chunks.length == 2 && chunks[1].isEmpty())) {
				return null;
			}
			int step = 1;
			if (chunks.length == 2) {
				step = parsePositiveInt(chunks[1]);
				if (step <= 0) {
					return null;
				}
			}
			String range = chunks[0].trim();
			int lo;
			int hi;
			if ("*".equals(range)) {
				lo = def.min();
				hi = def.max();
			}
			else {
				String[] bounds = range.split("-", -1);
				if (bounds.length > 2 || bounds[0].isEmpty()
						|| (bounds.length == 2 && bounds[1].isEmpty())) {
					return null;
				}
				Integer first = fieldValue(bounds[0], def);
				if (first == null) {
					return null;
				}
				if (bounds.length == 2) {
					Integer second = fieldValue(bounds[1], def);
					if (second == null) {
						return null;
					}
					lo = first;
					hi = second;
				}
				else {
					lo = first;
					hi = first;
				}
			}
			if (lo < def.min() || hi > def.max() || lo > hi) {
				return null;
			}
			for (int value = lo; value <= hi; value += step) {
				values.add(def.weekday() ? value % 7 : value);
			}
		}
		return values.isEmpty() ? null : Collections.unmodifiableSet(values);
	}

	private static int parsePositiveInt(String text) {
		try {
			return Integer.parseInt(text.trim());
		}
		catch (NumberFormatException ex) {
			return -1;
		}
	}

	private static Integer fieldValue(String token, FieldDef def) {
		String text = token.trim().toUpperCase(Locale.ROOT);
		Integer named = def.names().get(text);
		if (named != null) {
			return named;
		}
		if (!text.matches("\\d+")) {
			return null;
		}
		try {
			return Integer.parseInt(text);
		}
		catch (NumberFormatException ex) {
			return null;
		}
	}

	/** 给预览/调试用的字段快照。 */
	public List<Integer> minutes() {
		return new ArrayList<>(minutes);
	}

	public List<Integer> hours() {
		return new ArrayList<>(hours);
	}

	public List<Integer> days() {
		return new ArrayList<>(days);
	}

	public List<Integer> months() {
		return new ArrayList<>(months);
	}

	public List<Integer> weekdays() {
		return new ArrayList<>(weekdays);
	}

	public List<String> describe() {
		return List.of(
				minutes.stream().map(String::valueOf).collect(Collectors.joining(",")),
				hours.stream().map(String::valueOf).collect(Collectors.joining(",")),
				days.stream().map(String::valueOf).collect(Collectors.joining(",")),
				months.stream().map(String::valueOf).collect(Collectors.joining(",")),
				weekdays.stream().map(String::valueOf).collect(Collectors.joining(",")));
	}

	private enum Field {
		MINUTE, HOUR, DAY, MONTH, WEEKDAY
	}

  private record FieldDef(int min, int max, Map<String, Integer> names, boolean weekday) {
  }

	@Override
	public String toString() {
		return normalized;
	}

  /** 仅供测试：列出所有已知宏。 */
  static List<String> macros() {
    return MACROS.keySet().stream().sorted().toList();
  }

}
