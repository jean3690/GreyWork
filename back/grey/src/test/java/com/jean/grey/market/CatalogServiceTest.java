package com.jean.grey.market;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.jean.grey.market.CatalogTypes.McpEnv;
import com.jean.grey.market.CatalogTypes.McpPackage;
import com.jean.grey.market.CatalogTypes.McpPayload;
import com.jean.grey.market.CatalogTypes.McpRepository;
import com.jean.grey.market.CatalogTypes.SkillFile;
import com.jean.grey.market.CatalogTypes.SkillPayload;
import com.jean.grey.market.entity.CatalogItem;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * 目录读取面的契约：形状必须与桌面端两条通道逐字段对齐，
 * 否则「填个地址就能装」会在客户端静默失败（例如 skill_id 缺失 → 列表全是空名字）。
 */
class CatalogServiceTest {

	private final JsonMapper mapper = JsonMapper.builder().build();

	private FakeRepository repository;

	private CatalogService service;

	@BeforeEach
	void setUp() {
		repository = new FakeRepository();
		service = new CatalogService(mapper, repository);
	}

	@Test
	@DisplayName("搜索返回客户端要的 snake_case 形状")
	void searchUsesSnakeCaseShape() {
		addSkill("greywork/skills/todo-scan", "todo-scan", "TODO 扫描", true);
		List<Map<String, Object>> found = service.searchSkills("todo");
		assertThat(found).hasSize(1);
		assertThat(found.getFirst()).containsEntry("ref", "greywork/skills/todo-scan")
				.containsEntry("skill_id", "todo-scan")
				.containsEntry("source", "greywork")
				.containsEntry("downloadable", true);
		assertThat(found.getFirst()).doesNotContainKey("skillId");
	}

	@Test
	@DisplayName("停用条目不出现在搜索里，下载按 404 处理")
	void disabledSkillIsHidden() {
		addSkill("greywork/skills/off", "off", "下架技能", false);
		assertThat(service.searchSkills("")).isEmpty();
		assertThatThrownBy(() -> service.downloadSkill("greywork", "skills", "off"))
				.isInstanceOf(CatalogService.CatalogMissException.class);
	}

	@Test
	@DisplayName("快照含文件与内容指纹")
	void snapshotHasFilesAndHash() {
		addSkill("greywork/skills/todo-scan", "todo-scan", "TODO 扫描", true);
		Map<String, Object> snapshot = service.downloadSkill("greywork", "skills", "todo-scan");
		@SuppressWarnings("unchecked")
		List<Map<String, String>> files = (List<Map<String, String>>) snapshot.get("files");
		assertThat(files).hasSize(2);
		assertThat(files).anySatisfy(file -> assertThat(file).containsEntry("path", "SKILL.md"));
		assertThat((String) snapshot.get("hash")).hasSize(64);
	}

	@Test
	@DisplayName("MCP 预设是官方 registry 形状")
	void mcpPresetsUseRegistryShape() {
		addMcp("io.greywork/memory", "本地记忆");
		Map<String, Object> body = service.searchMcp("记忆", 10);
		@SuppressWarnings("unchecked")
		List<Map<String, Object>> servers = (List<Map<String, Object>>) body.get("servers");
		assertThat(servers).hasSize(1);
		@SuppressWarnings("unchecked")
		Map<String, Object> server = (Map<String, Object>) servers.getFirst().get("server");
		assertThat(server).containsEntry("name", "io.greywork/memory");
		@SuppressWarnings("unchecked")
		List<Map<String, Object>> packages = (List<Map<String, Object>>) server.get("packages");
		assertThat(packages.getFirst()).containsEntry("registryType", "npm");
	}

	@Test
	@DisplayName("payload 坏掉的条目不拖垮整个目录")
	void brokenPayloadIsSkipped() {
		CatalogItem broken = item("skill", "greywork/skills/broken", "broken", "坏条目", 0, true);
		broken.setPayload("{not json");
		repository.insert(broken);
		addSkill("greywork/skills/ok", "ok", "正常技能", true);
		assertThat(service.searchSkills("")).hasSize(1);
	}

	private void addSkill(String ref, String skillId, String name, boolean enabled) {
		CatalogItem item = item("skill", ref, skillId, name, 7, enabled);
		item.setPayload(mapper.writeValueAsString(new SkillPayload(List.of(
				new SkillFile("SKILL.md", "---\nname: " + skillId + "\n---\n\n# " + name + "\n"),
				new SkillFile("examples.md", "# 示例\n")))));
		repository.insert(item);
	}

	private void addMcp(String name, String title) {
		CatalogItem item = item("mcp", name, name, name, 0, true);
		item.setTitle(title);
		item.setPayload(mapper.writeValueAsString(new McpPayload("0.1.0",
				new McpRepository("https://github.com/modelcontextprotocol/servers"),
				List.of(new McpPackage("npm", "@modelcontextprotocol/server-memory", "latest",
						List.of(new McpEnv("MEMORY_FILE_PATH")))),
				List.of())));
		repository.insert(item);
	}

	private static CatalogItem item(String kind, String ref, String slug, String name, int installs,
			boolean enabled) {
		CatalogItem item = new CatalogItem();
		item.setKind(kind);
		item.setItemRef(ref);
		item.setSlug(slug);
		item.setName(name);
		item.setDescription(name);
		item.setInstalls(installs);
		item.setEnabled(enabled);
		item.setUpdatedAt(LocalDateTime.now());
		return item;
	}

	/** 内存仓库：只为读取面单测，不模拟事务/并发。 */
	private static final class FakeRepository implements CatalogRepository {

		private final List<CatalogItem> items = new ArrayList<>();

		private long nextId = 1;

		@Override
		public List<CatalogItem> listEnabled(String kind) {
			return items.stream().filter(item -> kind.equals(item.getKind()))
					.filter(item -> Boolean.TRUE.equals(item.getEnabled()))
					.toList();
		}

		@Override
		public List<CatalogItem> listAll() {
			return List.copyOf(items);
		}

		@Override
		public Optional<CatalogItem> findById(long id) {
			return items.stream().filter(item -> item.getId() != null && item.getId() == id).findFirst();
		}

		@Override
		public Optional<CatalogItem> findByRef(String kind, String itemRef) {
			return items.stream()
					.filter(item -> kind.equals(item.getKind()) && itemRef.equals(item.getItemRef()))
					.findFirst();
		}

		@Override
		public void insert(CatalogItem item) {
			item.setId(nextId++);
			items.add(item);
		}

		@Override
		public void update(CatalogItem item) {
			int index = items.indexOf(item);
			if (index >= 0) {
				items.set(index, item);
			}
		}

		@Override
		public void deleteById(long id) {
			items.removeIf(item -> item.getId() != null && item.getId() == id);
		}

		@Override
		public long count(String kind) {
			return items.stream().filter(item -> kind.equals(item.getKind())).count();
		}

	}

}
