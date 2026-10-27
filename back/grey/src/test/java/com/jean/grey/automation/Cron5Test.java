package com.jean.grey.automation;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

class Cron5Test {

	private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

	@Test
	void macrosExpandToCanonicalForm() {
		assertThat(Cron5.macros()).containsExactly("@ANNUALLY", "@DAILY", "@HOURLY",
				"@MIDNIGHT", "@MONTHLY", "@WEEKLY", "@YEARLY");
		Cron5 yearly = Cron5.parse("@yearly");
		assertThat(yearly).isNotNull();
		assertThat(yearly.normalized()).isEqualTo("0 0 1 1 *");
	}

	@Test
	void parsesRangesStepsAndLists() {
		Cron5 cron = Cron5.parse("*/15 8-17 * JAN-MAR 1,3");
		assertThat(cron).isNotNull();
		assertThat(cron.describe()).containsExactly("0,15,30,45", "8,9,10,11,12,13,14,15,16,17",
				"1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31",
				"1,2,3", "1,3");
	}

	@Test
	void weekdaySevenMeansSunday() {
		// 2026-11-01 是周日
		LocalDateTime fire = Cron5.parse("0 12 * * 7").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2026, 11, 1, 12, 0));
	}

	@Test
	void dayAndWeekdayBothRestrictedIsOr() {
		// 每月 1 号或周一，取先到者：2026-11-02 是周一（1 号是周日，也应命中——1 号更早）
		LocalDateTime fire = Cron5.parse("0 9 1 * 1").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2026, 11, 1, 9, 0));
	}

	@Test
	void dayOrWeekdayRestrictedIsAndWhenOneIsStar() {
		// 每周一 9 点
		LocalDateTime fire = Cron5.parse("0 9 * * 1").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2026, 11, 2, 9, 0));
	}

	@Test
	void skipsToNextMonthWhenMonthRestricted() {
		LocalDateTime fire = Cron5.parse("0 0 1 2 *").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2027, 2, 1, 0, 0));
	}

	@Test
	void nextIsStrictlyAfterGivenTime() {
		LocalDateTime base = LocalDateTime.of(2026, 11, 2, 9, 0);
		LocalDateTime fire = Cron5.parse("0 9 * * 1").next(base, ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2026, 11, 9, 9, 0));
	}

	@Test
	void handlesLeapDayWithFiveYearHorizon() {
		LocalDateTime fire = Cron5.parse("0 0 29 2 *").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE);
		assertThat(fire).isEqualTo(LocalDateTime.of(2028, 2, 29, 0, 0));
	}

	@Test
	void invalidExpressionsReturnNull() {
		assertThat(Cron5.parse(null)).isNull();
		assertThat(Cron5.parse("")).isNull();
		assertThat(Cron5.parse("* * *")).isNull();
		assertThat(Cron5.parse("60 * * * *")).isNull();
		assertThat(Cron5.parse("* 24 * * *")).isNull();
		assertThat(Cron5.parse("* * 32 * *")).isNull();
		assertThat(Cron5.parse("* * * 13 *")).isNull();
		assertThat(Cron5.parse("* * * * FOO")).isNull();
		assertThat(Cron5.parse("*/0 * * * *")).isNull();
		assertThat(Cron5.parse("5-1 * * * *")).isNull();
		assertThat(Cron5.parse("a * * * *")).isNull();
		assertThat(Cron5.isValid("@daily")).isTrue();
	}

	@Test
	void unmatchableExpressionReturnsNullWithinHorizon() {
		// 2 月 30 日永不存在：parse 合法，但 5 年内 next() 找不到触发点
		assertThat(Cron5.parse("0 0 30 2 *")).isNotNull();
		assertThat(Cron5.parse("0 0 30 2 *").next(LocalDateTime.of(2026, 10, 31, 12, 0),
				ZONE)).isNull();
	}

	@Test
	void listAccessorIsDefensiveCopy() {
		Cron5 cron = Cron5.parse("0,30 * * * *");
		List<Integer> minutes = cron.minutes();
		minutes.clear();
		assertThat(cron.minutes()).containsExactly(0, 30);
	}

}
