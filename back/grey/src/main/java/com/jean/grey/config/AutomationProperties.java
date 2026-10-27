package com.jean.grey.config;

import java.time.Duration;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 自动化任务调度参数。见 application.yml 的 grey.automation 段。
 */
@ConfigurationProperties("grey.automation")
public record AutomationProperties(long tickMs, Duration claimLease, int cloudConcurrency,
		int retentionDays, String zone) {

	public AutomationProperties {
		tickMs = tickMs <= 0 ? 30_000 : Math.max(tickMs, 1_000);
		claimLease = claimLease == null || claimLease.isNegative() || claimLease.isZero()
				? Duration.ofMinutes(30)
				: claimLease;
		cloudConcurrency = cloudConcurrency <= 0 ? 4 : Math.min(cloudConcurrency, 32);
		retentionDays = retentionDays <= 0 ? 30 : retentionDays;
		zone = zone == null ? "" : zone.trim();
	}

	public ZoneId scheduleZone() {
		return zone.isEmpty() ? ZoneId.systemDefault() : ZoneId.of(zone);
	}

}
