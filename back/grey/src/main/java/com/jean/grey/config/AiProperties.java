package com.jean.grey.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务端 AI 服务默认参数。真实密钥仍来自用户自己的供应商密钥池。
 */
@ConfigurationProperties("grey.ai")
public record AiProperties(String defaultModel, int maxTokens, double temperature) {

	public AiProperties {
		defaultModel = defaultModel == null ? "" : defaultModel.trim();
		maxTokens = maxTokens <= 0 ? 2048 : Math.min(maxTokens, 32768);
		temperature = temperature < 0 || temperature > 2 ? 0.2 : temperature;
	}

	public String normalizedDefaultModel() {
		return defaultModel.isBlank() ? null : defaultModel;
	}

}
