package com.jean.grey.sync.web;

import com.jean.grey.auth.AuthPrincipal;
import com.jean.grey.common.ApiException;
import com.jean.grey.sync.PreferencesCodec;
import com.jean.grey.sync.SyncService;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** 读取最新对象而非扫描全账号历史；新接口的 revision 始终是十进制字符串。 */
@RestController
@RequestMapping("/api/sync/preferences")
public class PreferencesSyncController {

	private final SyncService sync;
	private final PreferencesCodec codec;
	public PreferencesSyncController(SyncService sync, PreferencesCodec codec) {
		this.sync = sync; this.codec = codec;
	}
	public record Snapshot(String revision, boolean deleted, PreferencesCodec.Preferences payload) {
	}
	public record Push(JsonNode baseRevision, JsonNode payload) {
	}
	public record Receipt(String revision) {
	}

	@GetMapping
	public Snapshot get(@AuthenticationPrincipal AuthPrincipal principal) {
		var value = sync.get(principal.userId(), PreferencesCodec.KIND, PreferencesCodec.OBJECT_ID);
		return value == null ? new Snapshot(null, false, null)
				: new Snapshot(value.revision().toString(), value.deleted(), value.deleted() ? null : codec.decode(value.payload()));
	}

	@PutMapping
	public Receipt put(@AuthenticationPrincipal AuthPrincipal principal, @RequestBody Push request) {
		Long revision = parseRevision(request.baseRevision());
		String payload = request.payload() == null ? null : request.payload().toString();
		var result = sync.push(principal.userId(), PreferencesCodec.KIND, PreferencesCodec.OBJECT_ID, revision, payload);
		return new Receipt(result.revision().toString());
	}

	private static Long parseRevision(JsonNode raw) {
		if (raw == null || raw.isNull()) return null;
		try {
			if (!raw.isString()) throw new NumberFormatException();
			String value = raw.asString();
			if (!value.matches("[1-9][0-9]{0,18}")) throw new NumberFormatException();
			return Long.valueOf(value);
		} catch (NumberFormatException error) {
			throw ApiException.badRequest("sync_revision_invalid", "同步版本号必须是有效的正整数十进制字符串");
		}
	}
}
