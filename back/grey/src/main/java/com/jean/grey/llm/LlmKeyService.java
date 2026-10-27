package com.jean.grey.llm;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.common.ApiException;
import com.jean.grey.llm.entity.LlmKey;
import com.jean.grey.llm.mapper.LlmKeyMapper;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class LlmKeyService {

	public static final Set<String> PROVIDERS = Set.of("openai", "anthropic", "deepseek", "moonshot",
			"qwen", "zhipu", "ollama", "custom");

	/** 只给确认兼容 /chat/completions 的供应商填默认地址，其余必须显式给 baseUrl。 */
	private static final Map<String, String> DEFAULT_BASE_URLS = Map.of(
			"openai", "https://api.openai.com/v1",
			"deepseek", "https://api.deepseek.com/v1",
			"moonshot", "https://api.moonshot.cn/v1",
			"qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1",
			"zhipu", "https://open.bigmodel.cn/api/paas/v4",
			"ollama", "http://127.0.0.1:11434/v1");

	private final LlmKeyMapper keyMapper;
	private final KeyCipher cipher;

	public LlmKeyService(LlmKeyMapper keyMapper, KeyCipher cipher) {
		this.keyMapper = keyMapper;
		this.cipher = cipher;
	}

	public record KeyView(Long id, String provider, String label, String baseUrl, String status,
			LocalDateTime lastUsedAt) {
	}

	public record ResolvedKey(Long id, String provider, String baseUrl, String secret) {
	}

	public KeyView create(Long userId, String provider, String label, String baseUrl, String apiKey) {
		if (!PROVIDERS.contains(provider)) {
			throw ApiException.badRequest("provider_unknown", "不支持的供应商: " + provider);
		}
		String resolvedBase = baseUrl == null || baseUrl.isBlank()
				? DEFAULT_BASE_URLS.get(provider)
				: baseUrl.trim();
		if (resolvedBase == null || resolvedBase.isBlank()) {
			throw ApiException.badRequest("base_url_required", "该供应商必须显式提供 baseUrl");
		}
		while (resolvedBase.endsWith("/")) {
			resolvedBase = resolvedBase.substring(0, resolvedBase.length() - 1);
		}

		LlmKey key = new LlmKey();
		key.setUserId(userId);
		key.setProvider(provider);
		key.setLabel(label == null || label.isBlank() ? "default" : label);
		key.setBaseUrl(resolvedBase);
		key.setSecretCipher(cipher.encrypt(apiKey));
		key.setStatus("active");
		try {
			keyMapper.insert(key);
		}
		catch (org.springframework.dao.DuplicateKeyException ex) {
			throw new ApiException(HttpStatus.CONFLICT, "llm_key_exists", "同名密钥已存在");
		}
		return view(key);
	}

	public List<KeyView> list(Long userId) {
		return keyMapper.selectList(Wrappers.<LlmKey>lambdaQuery()
				.eq(LlmKey::getUserId, userId)
				.orderByAsc(LlmKey::getCreatedAt))
				.stream()
				.map(LlmKeyService::view)
				.toList();
	}

	public void delete(Long userId, Long keyId) {
		LlmKey key = keyMapper.selectById(keyId);
		if (key == null || !key.getUserId().equals(userId)) {
			throw ApiException.notFound("llm_key_not_found", "密钥不存在");
		}
		keyMapper.deleteById(keyId);
	}

	/** 轮换取用：最久没用的先上，避免一个 key 被打满。 */
	public ResolvedKey pick(Long userId, String provider) {
		List<LlmKey> candidates = keyMapper.selectList(Wrappers.<LlmKey>lambdaQuery()
				.eq(LlmKey::getUserId, userId)
				.eq(LlmKey::getStatus, "active")
				.eq(provider != null && !provider.isBlank(), LlmKey::getProvider, provider)
				.orderByAsc(LlmKey::getLastUsedAt));
		if (candidates.isEmpty()) {
			throw new ApiException(HttpStatus.CONFLICT, "no_llm_key",
					"没有可用的供应商密钥，请先在设置里添加");
		}
		LlmKey chosen = candidates.getFirst();
		keyMapper.update(null, Wrappers.<LlmKey>lambdaUpdate()
				.set(LlmKey::getLastUsedAt, LocalDateTime.now())
				.eq(LlmKey::getId, chosen.getId()));
		return new ResolvedKey(chosen.getId(), chosen.getProvider(), chosen.getBaseUrl(),
				cipher.decrypt(chosen.getSecretCipher()));
	}

	private static KeyView view(LlmKey key) {
		return new KeyView(key.getId(), key.getProvider(), key.getLabel(), key.getBaseUrl(),
				key.getStatus(), key.getLastUsedAt());
	}

}
