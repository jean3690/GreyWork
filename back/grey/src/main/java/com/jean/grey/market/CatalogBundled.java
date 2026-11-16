package com.jean.grey.market;

import com.jean.grey.market.CatalogTypes.McpCatalog;
import com.jean.grey.market.CatalogTypes.McpServer;
import com.jean.grey.market.CatalogTypes.SkillCatalog;
import com.jean.grey.market.CatalogTypes.SkillEntry;
import java.util.List;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * 随控制面发布的内置目录（`resources/catalog/*.json`）。
 *
 * 它不是运行时的兜底数据源，只是**首次启动的种子**：目录以库为准，
 * 这样运维台删光条目后不会再"复活"，改一条也不需要重新构建后端。
 */
@Component
public class CatalogBundled {

	private static final Logger log = LoggerFactory.getLogger(CatalogBundled.class);

	private final List<SkillEntry> skills;
	private final List<McpServer> servers;

	public CatalogBundled(ObjectMapper objectMapper) {
		this.skills = load(objectMapper, "catalog/skills.json", SkillCatalog.class, SkillCatalog::skills);
		this.servers = load(objectMapper, "catalog/mcp.json", McpCatalog.class, McpCatalog::servers);
		log.info("内置能力目录已读取: {} 个技能 / {} 个 MCP 预设", skills.size(), servers.size());
	}

	private static <T, R> List<R> load(ObjectMapper objectMapper, String resource, Class<T> type,
			Function<T, List<R>> pick) {
		ClassPathResource file = new ClassPathResource(resource);
		if (!file.exists()) {
			log.warn("内置目录缺失: {}", resource);
			return List.of();
		}
		try (var stream = file.getInputStream()) {
			T parsed = objectMapper.readValue(stream, type);
			List<R> items = parsed == null ? null : pick.apply(parsed);
			return items == null ? List.of() : List.copyOf(items);
		}
		catch (Exception error) {
			log.error("内置目录解析失败: {}", resource, error);
			return List.of();
		}
	}

	public List<SkillEntry> skills() {
		return skills;
	}

	public List<McpServer> servers() {
		return servers;
	}

}
