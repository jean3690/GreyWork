package com.jean.grey.admin;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.automation.mapper.AutomationDueMapper;
import com.jean.grey.automation.mapper.AutomationRunMapper;
import com.jean.grey.automation.mapper.AutomationTaskMapper;
import com.jean.grey.storage.entity.StorageObject;
import com.jean.grey.storage.mapper.StorageObjectMapper;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 运维台的平台侧只读视图：对象存储与自动化任务。
 *
 * 这两块原本只有「当前用户」接口（/api/storage、/api/automation），管理员看不到别人的用量，
 * 容量和积压就只能靠登服务器查库。这里给的是聚合 + 最近明细，口径与概览页一致：
 * 字节数只算 ready（pending 是还没确认上传的空壳，算进去会虚高），时间用服务端时区。
 *
 * 只读：没有「删除别人的对象」「停掉别人的任务」这类入口——真出事走用户禁用（一次掐断
 * 该用户所有对外行为），比逐个删资源更可靠，也不会让运维台变成第二个业务面。
 */
@Service
public class AdminPlatformService {

	/** 明细列表上限：运维台用于排查，不做导出。 */
	private static final int MAX_LIST = 100;
	/** 用量统计窗口：与概览/模型的 7 天口径对齐。 */
	private static final int RUN_WINDOW_DAYS = 7;

	private final StorageObjectMapper storageObjectMapper;
	private final AutomationTaskMapper automationTaskMapper;
	private final AutomationDueMapper automationDueMapper;
	private final AutomationRunMapper automationRunMapper;

	public AdminPlatformService(StorageObjectMapper storageObjectMapper,
			AutomationTaskMapper automationTaskMapper, AutomationDueMapper automationDueMapper,
			AutomationRunMapper automationRunMapper) {
		this.storageObjectMapper = storageObjectMapper;
		this.automationTaskMapper = automationTaskMapper;
		this.automationDueMapper = automationDueMapper;
		this.automationRunMapper = automationRunMapper;
	}

	public record StorageKindUsage(String kind, long objects, long bytes) {
	}

	public record StorageObjectItem(Long id, Long userId, String ownerEmail, String name, String kind,
			long sizeBytes, String visibility, String status, LocalDateTime createdAt) {
	}

	public record StorageOverview(long objects, long bytes, long pending, List<StorageKindUsage> byKind,
			List<StorageObjectItem> recent) {
	}

	public record AutomationTaskItem(String id, Long userId, String ownerEmail, String name,
			String execution, boolean enabled, LocalDateTime nextRunAt, LocalDateTime lastRunAt) {
	}

	public record AutomationOverview(long tasks, long enabled, long duePending, long dueOverdue,
			long runs7d, long runsFailed7d, List<AutomationTaskItem> recent) {
	}

	public StorageOverview storage() {
		Map<String, Object> ready = storageObjectMapper.readySummary();
		long pending = storageObjectMapper.selectCount(Wrappers.<StorageObject>lambdaQuery()
				.eq(StorageObject::getStatus, "pending"));
		List<StorageKindUsage> byKind = storageObjectMapper.summaryByKind().stream()
				.map(row -> new StorageKindUsage(asString(row.get("kind")),
						asLong(row.get("objects")), asLong(row.get("bytes"))))
				.toList();
		List<StorageObjectItem> recent = storageObjectMapper.recent(MAX_LIST).stream()
				.map(row -> new StorageObjectItem(asLongObject(row.get("id")),
						asLongObject(row.get("userId")), asString(row.get("ownerEmail")),
						asString(row.get("name")), asString(row.get("kind")),
						asLong(row.get("sizeBytes")), asString(row.get("visibility")),
						asString(row.get("status")), asDateTime(row.get("createdAt"))))
				.toList();
		return new StorageOverview(asLong(ready.get("objects")), asLong(ready.get("bytes")),
				pending, byKind, recent);
	}

	public AutomationOverview automation() {
		Map<String, Object> summary = automationTaskMapper.summary();
		Map<String, Long> backlog = new HashMap<>();
		for (Map<String, Object> row : automationDueMapper.backlog()) {
			backlog.put(asString(row.get("status")), asLong(row.get("count")));
		}
		long overdue = automationDueMapper.overdueCount(LocalDateTime.now());
		Map<String, Object> runs = automationRunMapper.statsSince(
				LocalDateTime.now().minusDays(RUN_WINDOW_DAYS));
		List<AutomationTaskItem> recent = automationTaskMapper.recent(MAX_LIST).stream()
				.map(row -> new AutomationTaskItem(asString(row.get("id")),
						asLongObject(row.get("userId")), asString(row.get("ownerEmail")),
						asString(row.get("name")), asString(row.get("execution")),
						asBoolean(row.get("enabled")), asDateTime(row.get("nextRunAt")),
						asDateTime(row.get("lastRunAt"))))
				.toList();
		return new AutomationOverview(asLong(summary.get("total")), asLong(summary.get("enabled")),
				backlog.getOrDefault("pending", 0L), overdue, asLong(runs.get("total")),
				asLong(runs.get("failed")), recent);
	}

	private static long asLong(Object value) {
		return value instanceof Number number ? number.longValue() : 0L;
	}

	private static Long asLongObject(Object value) {
		return value instanceof Number number ? number.longValue() : null;
	}

	private static String asString(Object value) {
		return value == null ? "" : String.valueOf(value);
	}

	/** tinyint(1) 在 JDBC 里可能是 Boolean 也可能是 0/1，两种都要认。 */
	private static boolean asBoolean(Object value) {
		if (value instanceof Boolean bool) {
			return bool;
		}
		return value instanceof Number number && number.intValue() != 0;
	}

	/** Map 结果里的时间列由驱动决定类型：MySQL 给 LocalDateTime，个别驱动给 Timestamp。 */
	private static LocalDateTime asDateTime(Object value) {
		if (value instanceof LocalDateTime dateTime) {
			return dateTime;
		}
		if (value instanceof java.sql.Timestamp timestamp) {
			return timestamp.toLocalDateTime();
		}
		return null;
	}

}
