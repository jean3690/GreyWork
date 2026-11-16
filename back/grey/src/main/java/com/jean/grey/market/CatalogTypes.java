package com.jean.grey.market;

import java.util.List;

/** 能力目录的领域类型（磁盘 JSON、数据库 payload、公开端点响应三者共用一套形状）。 */
public final class CatalogTypes {

	public record SkillFile(String path, String contents) {
	}

	/** 目录里的一条技能。 */
	public record SkillEntry(String ref, String skillId, String name, String description, Integer installs,
			List<SkillFile> files) {
	}

	/** 技能的 payload 形状（catalog_item.payload）。 */
	public record SkillPayload(List<SkillFile> files) {
	}

	public record SkillCatalog(List<SkillEntry> skills) {
	}

	public record McpEnv(String name) {
	}

	public record McpPackage(String registryType, String identifier, String version,
			List<McpEnv> environmentVariables) {
	}

	public record McpRemote(String type, String url) {
	}

	public record McpRepository(String url) {
	}

	/** 目录里的一条 MCP 预设。 */
	public record McpServer(String name, String title, String description, String version, McpRepository repository,
			List<McpPackage> packages, List<McpRemote> remotes) {
	}

	public record McpPayload(String version, McpRepository repository, List<McpPackage> packages,
			List<McpRemote> remotes) {
	}

	public record McpCatalog(List<McpServer> servers) {
	}

	private CatalogTypes() {
	}

}
