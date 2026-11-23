package com.jean.grey.sync;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.jean.grey.common.ApiException;
import java.util.Set;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/** 首批跨设备偏好白名单；不存放权限、密钥、路径或运行/安装状态。 */
@Component
public class PreferencesCodec {

	public static final String KIND = "settings";
	public static final String OBJECT_ID = "client-preferences-v1";
	private final ObjectMapper mapper;

	public PreferencesCodec(ObjectMapper mapper) { this.mapper = mapper; }

	@JsonIgnoreProperties(ignoreUnknown = true)
	public record Preferences(int schemaVersion, String theme, String colorMode, String fontSize,
			String radius, String locale) {
	}

	public Preferences decode(String raw) {
		Preferences value;
		try { value = raw == null ? null : mapper.readValue(raw, Preferences.class); }
		catch (RuntimeException error) { throw invalid(); }
		if (value == null || value.schemaVersion() != 1
				|| !member(value.theme(), "codex", "greywork", "night-blue", "night-green", "github", "fox", "liquid-glass")
				|| !member(value.colorMode(), "dark", "light", "system")
				|| !member(value.fontSize(), "small", "medium", "large")
				|| !member(value.radius(), "none", "small", "large")
				|| !member(value.locale(), "zh-CN", "en-US")) throw invalid();
		return value;
	}

	/** 重新序列化只包含白名单字段的 record，附带的私密字段不会进入同步对象或历史。 */
	public String sanitize(String raw) { return mapper.writeValueAsString(decode(raw)); }

	private static boolean member(String value, String... allowed) {
		return value != null && Set.of(allowed).contains(value);
	}
	private static ApiException invalid() {
		return ApiException.badRequest("sync_preferences_invalid", "同步偏好格式无效或版本不兼容，请更新客户端后重试");
	}
}
