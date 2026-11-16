package com.jean.grey.market;

import com.jean.grey.market.CatalogTypes.McpPackage;
import com.jean.grey.market.CatalogTypes.McpPayload;
import com.jean.grey.market.CatalogTypes.McpServer;
import com.jean.grey.market.CatalogTypes.SkillEntry;
import com.jean.grey.market.CatalogTypes.SkillPayload;
import com.jean.grey.market.entity.CatalogItem;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * 首次启动把内置 JSON 灌进 catalog_item（各类型只在**完全为空**时播种）。
 *
 * 之后目录以库为准：运维台改了、删了都不会被资源文件覆盖回去；
 * 想重新导入就清空对应 kind 的表再重启。
 */
@Component
public class CatalogSeedBootstrap implements ApplicationRunner {

	private static final Logger log = LoggerFactory.getLogger(CatalogSeedBootstrap.class);

	private final CatalogBundled bundled;

	private final CatalogRepository repository;

	private final ObjectMapper objectMapper;

	public CatalogSeedBootstrap(CatalogBundled bundled, CatalogRepository repository, ObjectMapper objectMapper) {
		this.bundled = bundled;
		this.repository = repository;
		this.objectMapper = objectMapper;
	}

	@Override
	public void run(ApplicationArguments args) {
		if (repository.count("skill") == 0) {
			for (SkillEntry skill : bundled.skills()) {
				CatalogItem item = new CatalogItem();
				item.setKind("skill");
				item.setItemRef(skill.ref());
				item.setSlug(skill.skillId());
				item.setName(skill.name());
				item.setDescription(skill.description());
				item.setInstalls(skill.installs() == null ? 0 : skill.installs());
				item.setEnabled(true);
				item.setPayload(write(new SkillPayload(skill.files())));
				repository.insert(item);
			}
			log.info("技能目录已播种: {} 条", bundled.skills().size());
		}
		if (repository.count("mcp") == 0) {
			for (McpServer server : bundled.servers()) {
				CatalogItem item = new CatalogItem();
				item.setKind("mcp");
				item.setItemRef(server.name());
				item.setSlug(server.name());
				item.setName(server.name());
				item.setTitle(server.title());
				item.setDescription(server.description());
				item.setInstalls(0);
				item.setEnabled(true);
				McpPackage first = server.packages() == null || server.packages().isEmpty() ? null
						: server.packages().getFirst();
				item.setPayload(write(new McpPayload(server.version(), server.repository(),
						first == null ? List.of() : java.util.List.of(first),
						server.remotes() == null ? java.util.List.of() : server.remotes())));
				repository.insert(item);
			}
			log.info("MCP 目录已播种: {} 条", bundled.servers().size());
		}
	}

	private String write(Object payload) {
		try {
			return objectMapper.writeValueAsString(payload);
		}
		catch (Exception error) {
			throw new IllegalStateException("内置目录序列化失败", error);
		}
	}

}