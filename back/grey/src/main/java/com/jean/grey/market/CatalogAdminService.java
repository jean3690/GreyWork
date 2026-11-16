package com.jean.grey.market;

import com.jean.grey.common.ApiException;
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
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

/**
 * 运维台 · 能力目录维护。
 *
 * 校验刻意与宿主 {@code skills.ts} 的落盘规则同口径（技能 id 小写 slug、相对路径、单文件
 * 256KB / 128 文件、必须有 SKILL.md）—— 控制面放行的条目，桌面端一定装得上；
 * 反过来这里放宽只会让用户在下发后才看到失败。
 */
@Service
public class CatalogAdminService {

	/** 与宿主 validateSkillId 一致：小写字母数字与连字符，长度 ≤64。 */
	private static final Pattern SKILL_ID = Pattern.compile("[a-z0-9][a-z0-9-]{0,63}");

	private static final Pattern ENV_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");

	private static final int MAX_FILES = 128;

	private static final int MAX_FILE_BYTES = 256 * 1024;

	/** 宿主只认 npm / pypi 两个 launcher，多出来的类型登记后会「不可登记」。 */
	private static final List<String> PACKAGE_TYPES = List.of("npm", "pypi");

	private final ObjectMapper objectMapper;

	private final CatalogRepository repository;

	public CatalogAdminService(ObjectMapper objectMapper, CatalogRepository repository) {
		this.objectMapper = objectMapper;
		this.repository = repository;
	}

	public record SkillInput(String ref, String skillId, String name, String description, Integer installs,
			Boolean enabled, List<SkillFile> files) {
	}

	public record McpInput(String name, String title, String description, String version, String repositoryUrl,
			String registryType, String identifier, String packageVersion, List<String> envNames, Boolean enabled) {
	}

	/**
	 * 列表项：只带元数据（正文走 detail），避免运维台一次拉几百 KB。
	 *
	 * id 用 String 而不是 Long：雪花 id 超过 2^53，浏览器 JSON.parse 会丢精度，
	 * 一按「编辑/删除」就 404。管理员面统一按字符串传（其它视图同类问题见 ISSUE 记录）。
	 */
	public record ItemView(String id, String kind, String ref, String slug, String name, String title,
			String description, int installs, boolean enabled, int fileCount, String packageLabel,
			LocalDateTime updatedAt) {
	}

	/** 编辑用完整快照：把 payload 原样摊平，前端直接渲染成 JSON 文本框。 */
	public record ItemDetail(ItemView item, List<SkillFile> files, McpPayload mcp) {
	}

	public List<ItemView> list(String kind) {
		String filter = kind == null ? "" : kind.trim();
		return repository.listAll().stream()
				.filter(item -> filter.isEmpty() || "all".equals(filter) || filter.equals(item.getKind()))
				.map(this::view)
				.toList();
	}

	public ItemDetail detail(long id) {
		CatalogItem item = require(id);
		if ("skill".equals(item.getKind())) {
			SkillPayload payload = readPayload(item, SkillPayload.class);
			return new ItemDetail(view(item), payload == null ? List.of() : payload.files(), null);
		}
		McpPayload payload = readPayload(item, McpPayload.class);
		return new ItemDetail(view(item), null, payload);
	}

	@Transactional
	public ItemView createSkill(SkillInput input) {
		SkillInput normalized = validateSkill(input);
		ensureRefFree("skill", normalized.ref(), null);
		CatalogItem item = new CatalogItem();
		item.setKind("skill");
		applySkill(item, normalized);
		repository.insert(item);
		return view(require(item.getId()));
	}

	@Transactional
	public ItemView updateSkill(long id, SkillInput input) {
		CatalogItem item = require(id);
		requireKind(item, "skill");
		SkillInput normalized = validateSkill(input);
		ensureRefFree("skill", normalized.ref(), id);
		applySkill(item, normalized);
		repository.update(item);
		return view(require(id));
	}

	@Transactional
	public ItemView createMcp(McpInput input) {
		McpInput normalized = validateMcp(input);
		ensureRefFree("mcp", normalized.name(), null);
		CatalogItem item = new CatalogItem();
		item.setKind("mcp");
		applyMcp(item, normalized);
		repository.insert(item);
		return view(require(item.getId()));
	}

	@Transactional
	public ItemView updateMcp(long id, McpInput input) {
		CatalogItem item = require(id);
		requireKind(item, "mcp");
		McpInput normalized = validateMcp(input);
		ensureRefFree("mcp", normalized.name(), id);
		applyMcp(item, normalized);
		repository.update(item);
		return view(require(id));
	}

	@Transactional
	public ItemView setEnabled(long id, boolean enabled) {
		CatalogItem item = require(id);
		item.setEnabled(enabled);
		repository.update(item);
		return view(require(id));
	}

	@Transactional
	public void delete(long id) {
		require(id);
		repository.deleteById(id);
	}

	/* ===== 校验 ===== */

	private SkillInput validateSkill(SkillInput input) {
		if (input == null) {
			throw ApiException.badRequest("catalog_invalid", "缺少条目内容");
		}
		String skillId = input.skillId() == null ? "" : input.skillId().trim();
		if (!SKILL_ID.matcher(skillId).matches()) {
			throw ApiException.badRequest("catalog_invalid", "skillId 必须是小写 slug（字母数字与连字符，≤64）: " + skillId);
		}
		String ref = input.ref() == null ? "" : input.ref().trim();
		String[] parts = ref.split("/", -1);
		if (parts.length != 3 || List.of(parts).contains("")) {
			throw ApiException.badRequest("catalog_invalid", "ref 必须是 owner/repo/skill 三段: " + ref);
		}
		if (!skillId.equals(parts[2])) {
			throw ApiException.badRequest("catalog_invalid", "ref 的第三段必须等于 skillId: " + ref);
		}
		String name = requireText(input.name(), "name", 128);
		String description = optionalText(input.description(), 512);
		List<SkillFile> files = input.files() == null ? List.of() : new ArrayList<>(input.files());
		if (files.isEmpty()) {
			throw ApiException.badRequest("catalog_invalid", "技能至少要有一个文件（含 SKILL.md）");
		}
		if (files.size() > MAX_FILES) {
			throw ApiException.badRequest("catalog_invalid", "单个技能最多 " + MAX_FILES + " 个文件");
		}
		boolean hasSkillDoc = false;
		for (SkillFile file : files) {
			String path = file.path() == null ? "" : file.path().trim();
			validateRelativePath(path);
			if ("SKILL.md".equals(path)) {
				hasSkillDoc = true;
			}
			String contents = file.contents() == null ? "" : file.contents();
			if (contents.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_FILE_BYTES) {
				throw ApiException.badRequest("catalog_invalid", "单个文件不得超过 256KB: " + path);
			}
			if (contents.isEmpty()) {
				throw ApiException.badRequest("catalog_invalid", "文件内容不能为空: " + path);
			}
		}
		if (!hasSkillDoc) {
			throw ApiException.badRequest("catalog_invalid", "技能根目录必须有 SKILL.md（agent 靠它识别技能）");
		}
		int installs = input.installs() == null ? 0 : Math.max(0, input.installs());
		return new SkillInput(ref, skillId, name, description, installs, input.enabled() == null || input.enabled(),
				files);
	}

	private static void validateRelativePath(String path) {
		if (path.isEmpty() || path.startsWith("/") || path.contains("\\")) {
			throw ApiException.badRequest("catalog_invalid", "文件路径必须是相对路径: " + path);
		}
		String[] segments = path.split("/");
		if (segments.length > 16) {
			throw ApiException.badRequest("catalog_invalid", "目录层级过深: " + path);
		}
		for (String segment : segments) {
			if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
				throw ApiException.badRequest("catalog_invalid", "文件路径不合法: " + path);
			}
		}
	}

	private McpInput validateMcp(McpInput input) {
		if (input == null) {
			throw ApiException.badRequest("catalog_invalid", "缺少条目内容");
		}
		String name = requireText(input.name(), "name", 200);
		if (name.chars().anyMatch(Character::isWhitespace)) {
			throw ApiException.badRequest("catalog_invalid", "MCP 名称不能包含空白字符: " + name);
		}
		String registryType = input.registryType() == null ? "" : input.registryType().trim().toLowerCase(Locale.ROOT);
		if (!PACKAGE_TYPES.contains(registryType)) {
			throw ApiException.badRequest("catalog_invalid", "只支持 npm / pypi 两种包类型（宿主只认这两个 launcher）");
		}
		String identifier = requireText(input.identifier(), "identifier", 200);
		List<String> envNames = new ArrayList<>();
		for (String envName : input.envNames() == null ? List.<String>of() : input.envNames()) {
			String trimmed = envName == null ? "" : envName.trim();
			if (trimmed.isEmpty()) {
				continue;
			}
			if (!ENV_NAME.matcher(trimmed).matches()) {
				throw ApiException.badRequest("catalog_invalid", "环境变量名不合法: " + trimmed);
			}
			envNames.add(trimmed);
		}
		return new McpInput(name, optionalText(input.title(), 128), optionalText(input.description(), 512),
				optionalText(input.version(), 32), optionalText(input.repositoryUrl(), 512), registryType, identifier,
				optionalText(input.packageVersion(), 32), envNames, input.enabled() == null || input.enabled());
	}

	private static String requireText(String value, String field, int max) {
		String trimmed = value == null ? "" : value.trim();
		if (trimmed.isEmpty()) {
			throw ApiException.badRequest("catalog_invalid", field + " 不能为空");
		}
		if (trimmed.length() > max) {
			throw ApiException.badRequest("catalog_invalid", field + " 过长（上限 " + max + "）");
		}
		return trimmed;
	}

	private static String optionalText(String value, int max) {
		String trimmed = value == null ? "" : value.trim();
		if (trimmed.isEmpty()) {
			return null;
		}
		if (trimmed.length() > max) {
			throw ApiException.badRequest("catalog_invalid", "文本过长（上限 " + max + "）: " + trimmed.substring(0, 16) + "…");
		}
		return trimmed;
	}

	/* ===== 写库 ===== */

	private void applySkill(CatalogItem item, SkillInput input) {
		item.setItemRef(input.ref());
		item.setSlug(input.skillId());
		item.setName(input.name());
		item.setTitle(null);
		item.setDescription(input.description());
		item.setInstalls(input.installs());
		item.setEnabled(input.enabled());
		item.setPayload(writePayload(new SkillPayload(input.files())));
	}

	private void applyMcp(CatalogItem item, McpInput input) {
		item.setItemRef(input.name());
		item.setSlug(input.name());
		item.setName(input.name());
		item.setTitle(input.title());
		item.setDescription(input.description());
		item.setInstalls(0);
		item.setEnabled(input.enabled());
		McpPackage pkg = new McpPackage(input.registryType(), input.identifier(), input.packageVersion(),
				input.envNames().stream().map(McpEnv::new).toList());
		McpPayload payload = new McpPayload(input.version(),
				input.repositoryUrl() == null ? null : new McpRepository(input.repositoryUrl()), List.of(pkg),
				List.of());
		item.setPayload(writePayload(payload));
	}

	private String writePayload(Object payload) {
		try {
			return objectMapper.writeValueAsString(payload);
		}
		catch (Exception error) {
			throw ApiException.badRequest("catalog_invalid", "条目序列化失败: " + error.getMessage());
		}
	}

	private <T> T readPayload(CatalogItem item, Class<T> type) {
		try {
			return objectMapper.readValue(item.getPayload(), type);
		}
		catch (Exception error) {
			throw ApiException.badRequest("catalog_invalid", "条目 payload 不是合法 JSON: " + item.getItemRef());
		}
	}

	private CatalogItem require(long id) {
		return repository.findById(id)
				.orElseThrow(() -> ApiException.notFound("catalog_miss", "目录条目不存在: " + id));
	}

	private static void requireKind(CatalogItem item, String kind) {
		if (!kind.equals(item.getKind())) {
			throw ApiException.badRequest("catalog_invalid", "条目类型是 " + item.getKind() + "，不能按 " + kind + " 编辑");
		}
	}

	/** 唯一键 (kind, item_ref)：新建撞名 → 409，编辑撞别人的 → 409。 */
	private void ensureRefFree(String kind, String ref, Long selfId) {
		repository.findByRef(kind, ref).ifPresent(existing -> {
			if (selfId == null || !existing.getId().equals(selfId)) {
				throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "catalog_duplicate",
						"同名条目已存在: " + ref);
			}
		});
	}

	private ItemView view(CatalogItem item) {
		int fileCount = 0;
		String packageLabel = null;
		if ("skill".equals(item.getKind())) {
			SkillPayload payload = readPayload(item, SkillPayload.class);
			fileCount = payload == null || payload.files() == null ? 0 : payload.files().size();
		}
		else {
			McpPayload payload = readPayload(item, McpPayload.class);
			if (payload != null && payload.packages() != null && !payload.packages().isEmpty()) {
				McpPackage pkg = payload.packages().getFirst();
				packageLabel = pkg.registryType() + ":" + pkg.identifier();
			}
		}
		return new ItemView(String.valueOf(item.getId()), item.getKind(), item.getItemRef(), item.getSlug(), item.getName(),
				item.getTitle(), item.getDescription(), item.getInstalls() == null ? 0 : item.getInstalls(),
				Boolean.TRUE.equals(item.getEnabled()), fileCount, packageLabel, item.getUpdatedAt());
	}

}
