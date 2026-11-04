package com.jean.grey.admin;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.account.entity.AppUser;
import com.jean.grey.account.mapper.AppUserMapper;
import com.jean.grey.auth.AuditService;
import com.jean.grey.auth.RolePolicy;
import com.jean.grey.auth.entity.AuditLog;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.mapper.AuditLogMapper;
import com.jean.grey.auth.entity.UserDevice;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.auth.mapper.UserDeviceMapper;
import com.jean.grey.channel.ChannelService;
import com.jean.grey.channel.entity.ChannelBinding;
import com.jean.grey.channel.mapper.ChannelBindingMapper;
import com.jean.grey.host.HostService;
import com.jean.grey.host.entity.HostInstance;
import com.jean.grey.host.mapper.HostInstanceMapper;
import com.jean.grey.llm.entity.LlmUsage;
import com.jean.grey.llm.mapper.LlmKeyMapper;
import com.jean.grey.llm.mapper.LlmUsageMapper;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 运维台首页聚合：一次请求把「有多少人、多少设备、多少宿主在线、多少通道在跑、
 * 模型用了多少 token、最近做了什么」算齐，前端不用并发打七八个接口再自己拼。
 *
 * 口径都取**服务端时区**（与 cron / created_at 一致），前端只负责展示，不再做时区换算 ——
 * 否则「今日新增」会随浏览器所在时区变化，和自己看到的审计时间对不上。
 */
@Service
public class AdminOverviewService {

	/** 趋势图固定 7 天（含今天）。 */
	private static final int TREND_DAYS = 7;

	private final AppUserMapper appUserMapper;
	private final UserDeviceMapper userDeviceMapper;
	private final EnrollmentCodeMapper enrollmentCodeMapper;
	private final HostInstanceMapper hostInstanceMapper;
	private final HostService hostService;
	private final ChannelBindingMapper channelBindingMapper;
	private final ChannelService channelService;
	private final LlmKeyMapper llmKeyMapper;
	private final LlmUsageMapper llmUsageMapper;
	private final AuditService auditService;
	private final AuditLogMapper auditLogMapper;

	public AdminOverviewService(AppUserMapper appUserMapper, UserDeviceMapper userDeviceMapper,
			EnrollmentCodeMapper enrollmentCodeMapper, HostInstanceMapper hostInstanceMapper,
			HostService hostService, ChannelBindingMapper channelBindingMapper,
			ChannelService channelService, LlmKeyMapper llmKeyMapper, LlmUsageMapper llmUsageMapper,
			AuditService auditService, AuditLogMapper auditLogMapper) {
		this.appUserMapper = appUserMapper;
		this.userDeviceMapper = userDeviceMapper;
		this.enrollmentCodeMapper = enrollmentCodeMapper;
		this.hostInstanceMapper = hostInstanceMapper;
		this.hostService = hostService;
		this.channelBindingMapper = channelBindingMapper;
		this.channelService = channelService;
		this.llmKeyMapper = llmKeyMapper;
		this.llmUsageMapper = llmUsageMapper;
		this.auditService = auditService;
		this.auditLogMapper = auditLogMapper;
	}

	public record UserStats(long total, long active, long disabled, long admins, long newToday,
			long new7d) {
	}

	public record DeviceStats(long total, long active24h) {
	}

	public record CodeStats(long active, long used, long expired, long issuedToday) {
	}

	public record HostStats(long total, long alive, long bindings) {
	}

	public record ChannelStats(long total, long active, long degraded, long disabled) {
	}

	public record LlmStats(long keys, long requests7d, long tokens7d, long tokensToday) {
	}

	public record AuditStats(long today, long total7d) {
	}

	public record TrendPoint(String date, long users, long audits, long llmRequests) {
	}

	public record Overview(UserStats users, DeviceStats devices, CodeStats codes, HostStats hosts,
			ChannelStats channels, LlmStats llm, AuditStats audit, List<TrendPoint> trend,
			List<AuditLog> recentAudits, LocalDateTime generatedAt) {
	}

	public Overview overview() {
		LocalDateTime now = LocalDateTime.now();
		LocalDateTime todayStart = LocalDate.now().atStartOfDay();
		LocalDateTime weekStart = todayStart.minusDays(TREND_DAYS - 1L);

		long userTotal = appUserMapper.selectCount(null);
		long userActive = appUserMapper.selectCount(Wrappers.<AppUser>lambdaQuery()
				.eq(AppUser::getStatus, "active"));
		long userAdmins = appUserMapper.selectCount(Wrappers.<AppUser>lambdaQuery()
				.eq(AppUser::getRole, RolePolicy.ADMIN));
		UserStats users = new UserStats(userTotal, userActive, Math.max(0, userTotal - userActive),
				userAdmins,
				countUsersSince(todayStart), countUsersSince(weekStart));

		long deviceTotal = userDeviceMapper.selectCount(null);
		long deviceActive = userDeviceMapper.selectCount(Wrappers.<UserDevice>lambdaQuery()
				.ge(UserDevice::getLastSeenAt, now.minusHours(24)));
		DeviceStats devices = new DeviceStats(deviceTotal, deviceActive);

		long codeUsed = enrollmentCodeMapper.selectCount(Wrappers.<EnrollmentCode>lambdaQuery()
				.isNotNull(EnrollmentCode::getUsedAt));
		long codeActive = enrollmentCodeMapper.selectCount(Wrappers.<EnrollmentCode>lambdaQuery()
				.isNull(EnrollmentCode::getUsedAt)
				.gt(EnrollmentCode::getExpiresAt, now));
		long codeExpired = enrollmentCodeMapper.selectCount(Wrappers.<EnrollmentCode>lambdaQuery()
				.isNull(EnrollmentCode::getUsedAt)
				.le(EnrollmentCode::getExpiresAt, now));
		long codeIssuedToday = enrollmentCodeMapper.selectCount(Wrappers.<EnrollmentCode>lambdaQuery()
				.ge(EnrollmentCode::getCreatedAt, todayStart));
		CodeStats codes = new CodeStats(codeActive, codeUsed, codeExpired, codeIssuedToday);

		List<HostInstance> hosts = hostInstanceMapper.selectList(null);
		long aliveHosts = hosts.stream()
				.filter(host -> hostService.isAlive(host.getDeviceId()))
				.count();
		long bindingTotal = channelBindingMapper.selectCount(null);
		HostStats hostStats = new HostStats(hosts.size(), aliveHosts, bindingTotal);

		List<ChannelBinding> bindings = channelBindingMapper.selectList(null);
		long channelActive = 0;
		long channelDegraded = 0;
		long channelDisabled = 0;
		for (ChannelBinding binding : bindings) {
			switch (channelService.effectiveStatus(binding)) {
				case "disabled" -> channelDisabled++;
				case "degraded" -> channelDegraded++;
				default -> channelActive++;
			}
		}
		ChannelStats channelStats = new ChannelStats(bindings.size(), channelActive, channelDegraded,
				channelDisabled);

		long keys = llmKeyMapper.selectCount(null);
		long requests7d = asLong(llmUsageMapper.summaryAll(weekStart).get("requests"));
		long tokens7d = asLong(llmUsageMapper.summaryAll(weekStart).get("total_tokens"));
		long tokensToday = asLong(llmUsageMapper.summaryAll(todayStart).get("total_tokens"));
		LlmStats llmStats = new LlmStats(keys, requests7d, tokens7d, tokensToday);

		AuditStats auditStats = new AuditStats(auditCountSince(todayStart), auditCountSince(weekStart));

		return new Overview(users, devices, codes, hostStats, channelStats, llmStats, auditStats,
				trend(weekStart), auditService.list(null, null, 8, 0L), now);
	}

	/**
	 * 7 天趋势：三张表各拉一次「只取 created_at」的窄查询，在内存里按天归桶。
	 *
	 * 为什么不在 SQL 里 GROUP BY DATE()：数据量是「自托管单实例」级别（每天几百行以内），
	 * 新增三张表各自的聚合 SQL + mapper 方法不值得；窄查询还能顺带适配 H2 / MySQL 的
	 * 日期函数差异。
	 */
	private List<TrendPoint> trend(LocalDateTime since) {
		Map<LocalDate, long[]> buckets = new LinkedHashMap<>();
		LocalDate today = LocalDate.now();
		for (int i = TREND_DAYS - 1; i >= 0; i--) {
			buckets.put(today.minusDays(i), new long[3]);
		}

		appUserMapper.selectList(Wrappers.<AppUser>lambdaQuery()
				.select(AppUser::getId, AppUser::getCreatedAt)
				.ge(AppUser::getCreatedAt, since))
				.forEach(user -> bump(buckets, user.getCreatedAt(), 0));
		auditLogMapper.selectList(Wrappers.<AuditLog>lambdaQuery()
				.select(AuditLog::getId, AuditLog::getCreatedAt)
				.ge(AuditLog::getCreatedAt, since))
				.forEach(log -> bump(buckets, log.getCreatedAt(), 1));
		llmUsageMapper.selectList(Wrappers.<LlmUsage>lambdaQuery()
				.select(LlmUsage::getId, LlmUsage::getCreatedAt)
				.ge(LlmUsage::getCreatedAt, since))
				.forEach(usage -> bump(buckets, usage.getCreatedAt(), 2));

		List<TrendPoint> points = new ArrayList<>(buckets.size());
		buckets.forEach((date, values) -> points.add(new TrendPoint(date.toString(), values[0],
				values[1], values[2])));
		return points;
	}

	private static void bump(Map<LocalDate, long[]> buckets, LocalDateTime at, int index) {
		if (at == null) {
			return;
		}
		long[] values = buckets.get(at.toLocalDate());
		if (values != null) {
			values[index]++;
		}
	}

	private long countUsersSince(LocalDateTime since) {
		return appUserMapper.selectCount(Wrappers.<AppUser>lambdaQuery()
				.ge(AppUser::getCreatedAt, since));
	}

	private long auditCountSince(LocalDateTime since) {
		return auditLogMapper.selectCount(Wrappers.<AuditLog>lambdaQuery()
				.ge(AuditLog::getCreatedAt, since));
	}

	private static long asLong(Object value) {
		return value instanceof Number number ? number.longValue() : 0L;
	}

}
