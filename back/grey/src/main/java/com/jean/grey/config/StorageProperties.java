package com.jean.grey.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 对象存储配置。默认对接 RustFS（S3 兼容），也可指向 MinIO / AWS S3 / 阿里云 OSS 的 S3 网关。
 *
 * <p>
 * 未开启时整个存储模块保持只读降级：{@code /api/storage/config} 可以访问，
 * 上传/下载接口返回 {@code storage_disabled}，不影响其他功能启动。
 */
@ConfigurationProperties("grey.storage")
public record StorageProperties(boolean enabled, String endpoint, String region, String accessKey,
		String secretKey, String bucket, boolean pathStyle, Duration presignTtl,
		long maxObjectBytes, String publicBaseUrl, Duration pendingTtl) {

	public StorageProperties {
		endpoint = normalize(endpoint, "http://127.0.0.1:9000");
		region = normalize(region, "us-east-1");
		bucket = normalize(bucket, "greywork");
		presignTtl = presignTtl == null || presignTtl.isNegative() || presignTtl.isZero()
				? Duration.ofMinutes(15)
				: presignTtl;
		pendingTtl = pendingTtl == null || pendingTtl.isNegative() || pendingTtl.isZero()
				? Duration.ofHours(24)
				: pendingTtl;
		maxObjectBytes = maxObjectBytes <= 0 ? 500L * 1024 * 1024 : maxObjectBytes;
		publicBaseUrl = trimTrailingSlash(publicBaseUrl);
	}

	/** 配置齐全才真正启用；缺凭证时保持降级而不是让整个应用起不来。 */
	public boolean active() {
		return enabled && !isBlank(endpoint) && !isBlank(accessKey) && !isBlank(secretKey)
				&& !isBlank(bucket);
	}

	public String missingReason() {
		if (!enabled) {
			return "对象存储未启用（设置 GREY_S3_ENABLED=true）";
		}
		if (isBlank(accessKey) || isBlank(secretKey)) {
			return "对象存储缺少访问凭证（GREY_S3_ACCESS_KEY / GREY_S3_SECRET_KEY）";
		}
		return "对象存储配置不完整";
	}

	private static String normalize(String value, String fallback) {
		return isBlank(value) ? fallback : value.trim();
	}

	private static String trimTrailingSlash(String value) {
		String text = value == null ? "" : value.trim();
		while (text.endsWith("/")) {
			text = text.substring(0, text.length() - 1);
		}
		return text;
	}

	private static boolean isBlank(String value) {
		return value == null || value.isBlank();
	}

}
