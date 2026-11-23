package com.jean.grey.sync;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.common.ApiException;
import com.jean.grey.sync.entity.SyncChange;
import com.jean.grey.sync.entity.SyncObject;
import com.jean.grey.sync.mapper.SyncChangeMapper;
import com.jean.grey.sync.mapper.SyncObjectMapper;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SyncService {

	/** 允许同步的对象类型白名单，避免客户端把任意表当同步通道。 */
	private static final Set<String> KINDS = Set.of("settings", "workspace", "contact", "plugin");

	private final SyncObjectMapper syncObjectMapper;
	private final SyncChangeMapper syncChangeMapper;
	private final PreferencesCodec preferences;

	public SyncService(SyncObjectMapper syncObjectMapper, SyncChangeMapper syncChangeMapper, PreferencesCodec preferences) {
		this.syncObjectMapper = syncObjectMapper;
		this.syncChangeMapper = syncChangeMapper;
		this.preferences = preferences;
	}

	public record ChangeView(String kind, String objectId, Long revision, boolean deleted,
			String payload) {
	}

	public record PullResult(Long revision, boolean hasMore, List<ChangeView> changes) {
	}

	public record PushResult(String kind, String objectId, Long revision) {
	}

	public ChangeView get(Long userId, String kind, String objectId) {
		requireKind(kind);
		var current = syncObjectMapper.find(userId, kind, objectId);
		return current == null ? null : new ChangeView(kind, objectId, current.getRevision(),
				Boolean.TRUE.equals(current.getDeleted()), current.getPayload());
	}

	public PullResult pull(Long userId, long since, int limit) {
		int size = Math.clamp(limit, 1, 500);
		List<SyncChange> rows = syncChangeMapper.selectList(Wrappers.<SyncChange>lambdaQuery()
				.eq(SyncChange::getUserId, userId)
				.gt(SyncChange::getId, since)
				.orderByAsc(SyncChange::getId)
				.last("LIMIT " + (size + 1)));
		boolean hasMore = rows.size() > size;
		List<SyncChange> page = hasMore ? rows.subList(0, size) : rows;
		long revision = page.isEmpty() ? since : page.getLast().getId();
		List<ChangeView> changes = page.stream()
				.map(row -> new ChangeView(row.getKind(), row.getObjectId(), row.getId(),
						Boolean.TRUE.equals(row.getDeleted()), row.getPayload()))
				.toList();
		return new PullResult(revision, hasMore, changes);
	}

	@Transactional
	public PushResult push(Long userId, String kind, String objectId, Long baseRevision,
			String payload) {
		requireKind(kind);
		if (PreferencesCodec.KIND.equals(kind) && PreferencesCodec.OBJECT_ID.equals(objectId)) payload = preferences.sanitize(payload);
		return save(userId, kind, objectId, baseRevision, payload, false);
	}

	@Transactional
	public PushResult remove(Long userId, String kind, String objectId, Long baseRevision) {
		requireKind(kind);
		return save(userId, kind, objectId, baseRevision, null, true);
	}

	private PushResult save(Long userId, String kind, String objectId, Long baseRevision,
			String payload, boolean deleted) {
		SyncObject current = syncObjectMapper.find(userId, kind, objectId);
		checkRevision(kind, objectId, baseRevision, current);

		SyncChange change = new SyncChange();
		change.setUserId(userId);
		change.setKind(kind);
		change.setObjectId(objectId);
		change.setDeleted(deleted);
		change.setPayload(payload);
		syncChangeMapper.insert(change);

		LocalDateTime now = LocalDateTime.now();
		if (current == null) {
			SyncObject created = new SyncObject();
			created.setUserId(userId);
			created.setKind(kind);
			created.setObjectId(objectId);
			created.setRevision(change.getId());
			created.setDeleted(deleted);
			created.setPayload(payload);
			created.setUpdatedAt(now);
			try { syncObjectMapper.insert(created); }
			catch (DuplicateKeyException error) { throw lostRace(); }
		}
		else {
			current.setRevision(change.getId());
			current.setDeleted(deleted);
			current.setPayload(payload);
			current.setUpdatedAt(now);
			// CAS 与版本检查在数据库同一条 UPDATE 中完成。失败抛异常，事务也回滚本次 change。
			if (syncObjectMapper.update(current, baseRevision) != 1) throw lostRace();
		}
		return new PushResult(kind, objectId, change.getId());
	}

	private static void checkRevision(String kind, String objectId, Long baseRevision,
			SyncObject current) {
		Long expected = current == null ? null : current.getRevision();
		if (java.util.Objects.equals(expected, baseRevision)) {
			return;
		}
		throw conflict(current);
	}

	private static ApiException conflict(SyncObject current) {
		Map<String, Object> details = new LinkedHashMap<>();
		if (current == null) {
			details.put("current", null);
		}
		else {
			Map<String, Object> snapshot = new LinkedHashMap<>();
			snapshot.put("revision", current.getRevision());
			snapshot.put("deleted", Boolean.TRUE.equals(current.getDeleted()));
			snapshot.put("payload", current.getPayload());
			details.put("current", snapshot);
		}
		return new ApiException(HttpStatus.CONFLICT, "sync_conflict",
				"对象已被其他设备修改，请先拉取再重试", details);
	}

	private static ApiException lostRace() {
		// 当前事务的快照/一级缓存可能仍是旧行，不把它冒充成最新版本；回滚后由客户端重新 GET。
		return new ApiException(HttpStatus.CONFLICT, "sync_conflict",
				"对象已被其他设备修改，请先拉取再重试", Map.of("reload", true));
	}

	private static void requireKind(String kind) {
		if (!KINDS.contains(kind)) {
			throw ApiException.badRequest("sync_kind_unknown", "不支持同步的对象类型: " + kind);
		}
	}

}
