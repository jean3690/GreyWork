package com.jean.grey.market;

import com.jean.grey.market.CatalogTypes.McpPackage;
import com.jean.grey.market.CatalogTypes.McpPayload;
import com.jean.grey.market.CatalogTypes.McpRemote;
import com.jean.grey.market.CatalogTypes.McpServer;
import com.jean.grey.market.CatalogTypes.SkillEntry;
import com.jean.grey.market.CatalogTypes.SkillFile;
import com.jean.grey.market.CatalogTypes.SkillPayload;
import com.jean.grey.market.entity.CatalogItem;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * 能力目录读取面（桌面端匿名可用）。
 *
 * 数据以库为准（{@code catalog_item}），首次启动由 {@link CatalogSeedBootstrap} 用
 * 内置 JSON 播种。输出形状必须与客户端已实现的通道逐字段对齐，否则「填个地址就能用」不成立：
 * - 技能：{@code GET /api/skills?q=} 返回数组（snake_case），{@code GET /api/download/{owner}/{repo}/{skill}}
 *   返回 {@code {files:[{path,contents}], hash}} —— 宿主 skills_search / skills_download 的形状；
 * - MCP：{@code GET /api/market/mcp/v0/servers} 复刻官方 registry 的响应（camelCase + servers[].server）。
 */
@Service
public class CatalogService {

	private static final Logger log = LoggerFactory.getLogger(CatalogService.class);

	/** 一次返回上限：搜索框是给人看的，不是导出接口。 */
	private static final int MAX_LIMIT = 100;

	private final ObjectMapper objectMapper;
	private final CatalogRepository repository;

	public CatalogService(ObjectMapper objectMapper, CatalogRepository repository) {
		this.objectMapper = objectMapper;
		this.repository = repository;
	}

	/** 技能搜索：命中 name / slug / description。 */
	public List<Map<String, Object>> searchSkills(String query) {
		String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
		return repository.listEnabled("skill").stream()
				.map(this::toSkill)
				.filter(skill -> skill != null)
				.filter(skill -> needle.isEmpty() || matches(needle, skill))
				.map(CatalogService::skillSummary)
				.toList();
	}

	private static boolean matches(String needle, SkillEntry skill) {
		return contains(skill.skillId(), needle) || contains(skill.name(), needle)
				|| contains(skill.description(), needle);
	}

	private static boolean contains(String value, String needle) {
		return value != null && value.toLowerCase(Locale.ROOT).contains(needle);
	}

	/** 技能快照：{@code owner/repo/skill} 三段定位；停用或不存在都按 404 处理。 */
	public Map<String, Object> downloadSkill(String owner, String repo, String skill) {
		String ref = owner + "/" + repo + "/" + skill;
		SkillEntry entry = repository.findByRef("skill", ref)
				.filter(item -> Boolean.TRUE.equals(item.getEnabled()))
				.map(this::toSkill)
				.orElseThrow(() -> new CatalogMissException(ref));
		List<Map<String, String>> files = new ArrayList<>();
		for (SkillFile file : entry.files() == null ? List.<SkillFile>of() : entry.files()) {
			files.add(Map.of("path", file.path(), "contents", file.contents()));
		}
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("files", files);
		body.put("hash", hash(entry.files()));
		return body;
	}

	/** 内容指纹：按 (path, contents) 顺序拼接后取 sha256，与客户端展示的 hash 同义。 */
	static String hash(List<SkillFile> files) {
		try {
			MessageDigest digest = MessageDigest.getInstance("SHA-256");
			for (SkillFile file : files == null ? List.<SkillFile>of() : files) {
				digest.update(file.path().getBytes(StandardCharsets.UTF_8));
				digest.update((byte) 0);
				digest.update(file.contents().getBytes(StandardCharsets.UTF_8));
				digest.update((byte) 0);
			}
			return HexFormat.of().formatHex(digest.digest());
		}
		catch (NoSuchAlgorithmException error) {
			return "";
		}
	}

	/** MCP 预设：输出官方 registry 的 {servers:[{server:…,_meta:…}]} 形状。 */
	public Map<String, Object> searchMcp(String search, int limit) {
		return searchMcp(search, limit, "");
	}

	/** Java 自托管 npm 包的相对地址，按当前控制面 URL 展开（不写死 localhost）。 */
	public Map<String, Object> searchMcp(String search, int limit, String baseUrl) {
		String needle = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
		int capped = Math.clamp(limit <= 0 ? 20 : limit, 1, MAX_LIMIT);
		List<Map<String, Object>> items = repository.listEnabled("mcp").stream()
				.map(this::toMcp)
				.filter(server -> server != null)
				.filter(server -> needle.isEmpty() || contains(server.name(), needle)
						|| contains(server.title(), needle) || contains(server.description(), needle))
				.limit(capped)
				.map(server -> registryItem(server, baseUrl))
				.toList();
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("servers", items);
		body.put("metadata", Map.of("count", items.size()));
		return body;
	}

	/** 库行 → 领域对象。payload 坏掉的条目跳过（一条坏数据不该让整个目录 500）。 */
	SkillEntry toSkill(CatalogItem item) {
		try {
			SkillPayload payload = objectMapper.readValue(item.getPayload(), SkillPayload.class);
			return new SkillEntry(item.getItemRef(), item.getSlug(), item.getName(), item.getDescription(),
					item.getInstalls() == null ? 0 : item.getInstalls(),
					payload == null || payload.files() == null ? List.of() : payload.files());
		}
		catch (Exception error) {
			log.warn("技能条目 payload 解析失败，已跳过: {}", item.getItemRef(), error);
			return null;
		}
	}

	McpServer toMcp(CatalogItem item) {
		try {
			McpPayload payload = objectMapper.readValue(item.getPayload(), McpPayload.class);
			return new McpServer(item.getItemRef(), item.getTitle(), item.getDescription(),
					payload == null ? null : payload.version(),
					payload == null ? null : payload.repository(),
					payload == null ? List.of() : payload.packages(),
					payload == null ? List.of() : payload.remotes());
		}
		catch (Exception error) {
			log.warn("MCP 条目 payload 解析失败，已跳过: {}", item.getItemRef(), error);
			return null;
		}
	}

	private static Map<String, Object> skillSummary(SkillEntry skill) {
		// 客户端 skills_search 直接吃这个数组：键名必须是 snake_case（skill_id），
		// 否则 wrapHostSearch 拿到 undefined，列表里全是空名字。
		Map<String, Object> item = new LinkedHashMap<>();
		item.put("ref", skill.ref());
		item.put("skill_id", skill.skillId());
		item.put("name", skill.name());
		item.put("installs", skill.installs() == null ? 0 : skill.installs());
		item.put("source", "greywork");
		item.put("downloadable", true);
		return item;
	}

	private static Map<String, Object> registryItem(McpServer server, String baseUrl) {
		Map<String, Object> detail = new LinkedHashMap<>();
		detail.put("name", server.name());
		detail.put("title", server.title());
		detail.put("description", server.description());
		detail.put("version", server.version());
		detail.put("repository", server.repository() == null ? null : Map.of("url", server.repository().url()));
		McpPackage first = server.packages() == null || server.packages().isEmpty() ? null
				: server.packages().getFirst();
		detail.put("packages", first == null ? List.of() : List.of(packageInfo(first, baseUrl)));
		McpRemote firstRemote = server.remotes() == null || server.remotes().isEmpty() ? null
				: server.remotes().getFirst();
		detail.put("remotes", firstRemote == null ? List.of()
				: List.of(Map.of("type", firstRemote.type(), "url", firstRemote.url())));
		Map<String, Object> item = new LinkedHashMap<>();
		item.put("server", detail);
		item.put("_meta", Map.of("io.modelcontextprotocol.registry/official", Map.of("status", "active")));
		return item;
	}

	private static Map<String, Object> packageInfo(McpPackage pkg, String baseUrl) {
		Map<String, Object> info = new LinkedHashMap<>();
		info.put("registryType", pkg.registryType());
		String identifier = pkg.identifier();
		if ("npm".equals(pkg.registryType()) && identifier != null
				&& identifier.startsWith("/api/market/mcp/packages/") && !baseUrl.isBlank()) {
			identifier = baseUrl.replaceAll("/+$", "") + identifier;
		}
		info.put("identifier", identifier);
		info.put("version", pkg.version());
		info.put("environmentVariables", pkg.environmentVariables() == null ? List.of() : pkg.environmentVariables());
		return info;
	}

	/** 目录里没有这个 ref —— 由控制器翻成 404。 */
	public static class CatalogMissException extends RuntimeException {

		public CatalogMissException(String ref) {
			super("目录里没有这个条目: " + ref);
		}

	}

}
