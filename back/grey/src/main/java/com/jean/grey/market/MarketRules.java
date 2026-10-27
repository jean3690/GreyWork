package com.jean.grey.market;

import com.jean.grey.common.ApiException;
import java.net.URI;
import java.util.List;
import java.util.Set;

/**
 * 与 Rust 宿主 plugin_market::validate 保持一致的规则：
 * 在这里放行的东西，宿主那边也必须能过。
 */
public final class MarketRules {

	private static final Set<String> GITHUB_HOSTS = Set.of("github.com",
			"raw.githubusercontent.com", "objects.githubusercontent.com", "githubusercontent.com");

	private MarketRules() {
	}

	public static void requireSlug(String slug) {
		boolean ok = slug != null && !slug.isEmpty() && slug.length() <= 96
				&& (Character.isLowerCase(slug.charAt(0)) || Character.isDigit(slug.charAt(0)))
				&& slug.chars().allMatch(ch -> (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
						|| ch == '.' || ch == '-' || ch == '_' || ch == ':');
		if (!ok) {
			throw ApiException.badRequest("market_slug_invalid", "插件 id 只允许小写字母/数字/._:-");
		}
	}

	public static void requireVersion(String version) {
		String[] parts = version == null ? new String[0] : version.split("\\.", -1);
		boolean ok = parts.length == 3 && List.of(parts).stream()
				.allMatch(part -> !part.isEmpty() && part.chars().allMatch(Character::isDigit));
		if (!ok) {
			throw ApiException.badRequest("market_version_invalid", "版本号必须是 x.y.z");
		}
	}

	public static void requireSha256(String sha256) {
		boolean ok = sha256 != null && sha256.length() == 64
				&& sha256.chars().allMatch(ch -> (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'));
		if (!ok) {
			throw ApiException.badRequest("market_sha256_invalid", "sha256 必须是 64 位小写十六进制");
		}
	}

	public static void requireDownloadUrl(String raw, boolean strictGithub) {
		URI uri;
		try {
			uri = URI.create(raw == null ? "" : raw);
		}
		catch (IllegalArgumentException ex) {
			throw ApiException.badRequest("market_url_invalid", "下载地址不是合法 URL");
		}
		if (!"https".equals(uri.getScheme())) {
			throw ApiException.badRequest("market_url_invalid", "下载地址必须是 https");
		}
		if (strictGithub && !GITHUB_HOSTS.contains(uri.getHost())) {
			throw ApiException.badRequest("market_url_host_rejected",
					"宿主只接受 GitHub 域名的下载地址: " + uri.getHost());
		}
	}

	public static void requireRollout(int percent) {
		if (percent < 0 || percent > 100) {
			throw ApiException.badRequest("market_rollout_invalid", "灰度比例必须在 0-100");
		}
	}

	/** x.y.z 数值比较，publish 阶段已保证格式。 */
	public static int compareVersions(String left, String right) {
		String[] a = left.split("\\.");
		String[] b = right.split("\\.");
		for (int i = 0; i < 3; i++) {
			int diff = Integer.compare(Integer.parseInt(a[i]), Integer.parseInt(b[i]));
			if (diff != 0) {
				return diff;
			}
		}
		return 0;
	}

}
