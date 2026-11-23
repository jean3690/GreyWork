package com.jean.grey.market.web;

import com.jean.grey.common.ApiException;
import com.jean.grey.market.CatalogService;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

/**
 * 能力目录端点（匿名可读：目录是随版本发布的公开内容，不含用户数据）。
 *
 * 路径刻意不是 /api/market/skills 这类「本项目风格」：桌面端的技能市场早就实现了
 * skills.sh 协议（{@code /api/skills}、{@code /api/download/{owner}/{repo}/{skill}}），
 * 服务端照这个形状开口，客户端只要在「技能源」里填一个地址就能用，零改动。
 * MCP 那半边同理，复刻官方 registry 的 {@code /v0/servers}。
 */
@RestController
public class MarketController {

	private final CatalogService catalog;

	public MarketController(CatalogService catalog) {
		this.catalog = catalog;
	}

	/** 技能搜索。返回数组（不是包装对象）：宿主 skills_search 直接透传给渲染端。 */
	@GetMapping("/api/skills")
	public List<Map<String, Object>> skills(@RequestParam(name = "q", defaultValue = "") String query) {
		return catalog.searchSkills(query);
	}

	/** 技能快照：{files:[{path,contents}], hash}，宿主会再做一遍路径/体积校验。 */
	@GetMapping("/api/download/{owner}/{repo}/{skill}")
	public Map<String, Object> download(@PathVariable String owner, @PathVariable String repo,
			@PathVariable String skill) {
		try {
			return catalog.downloadSkill(owner, repo, skill);
		}
		catch (CatalogService.CatalogMissException error) {
			throw ApiException.notFound("catalog_miss", error.getMessage());
		}
	}

	/** MCP 预设：把控制面地址 + /api/market/mcp 填进客户端的 registry 地址即可浏览。 */
	@GetMapping("/api/market/mcp/v0/servers")
	public Map<String, Object> mcpServers(@RequestParam(name = "search", defaultValue = "") String search,
			@RequestParam(name = "limit", defaultValue = "20") int limit) {
		return catalog.searchMcp(search, limit,
				ServletUriComponentsBuilder.fromCurrentContextPath().build().toUriString());
	}

}
