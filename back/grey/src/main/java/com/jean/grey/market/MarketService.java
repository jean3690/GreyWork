package com.jean.grey.market;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Hashes;
import com.jean.grey.market.entity.MarketDownload;
import com.jean.grey.market.entity.MarketPackage;
import com.jean.grey.market.entity.MarketVersion;
import com.jean.grey.market.mapper.MarketDownloadMapper;
import com.jean.grey.market.mapper.MarketPackageMapper;
import com.jean.grey.market.mapper.MarketVersionMapper;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

@Service
public class MarketService {

	private static final Logger log = LoggerFactory.getLogger(MarketService.class);
	private static final Set<String> CHANNELS = Set.of("stable", "beta", "canary");
	private static final Set<String> STATUSES = Set.of("draft", "published", "deprecated");
	private static final int MAX_REGISTRY_PLUGINS = 256;

	private final MarketPackageMapper packageMapper;
	private final MarketVersionMapper versionMapper;
	private final MarketDownloadMapper downloadMapper;
	private final RegistrySigner signer;
	private final ObjectMapper objectMapper;
	private final boolean strictGithubUrl;

	public MarketService(MarketPackageMapper packageMapper, MarketVersionMapper versionMapper,
			MarketDownloadMapper downloadMapper, RegistrySigner signer, ObjectMapper objectMapper,
			@Value("${grey.market.strict-github-url:true}") boolean strictGithubUrl) {
		this.packageMapper = packageMapper;
		this.versionMapper = versionMapper;
		this.downloadMapper = downloadMapper;
		this.signer = signer;
		this.objectMapper = objectMapper;
		this.strictGithubUrl = strictGithubUrl;
	}

	public record PackageView(Long id, String slug, String name, String author, String summary,
			String description, String category, List<String> tags, String status,
			LocalDateTime createdAt) {
	}

	public record VersionView(String version, String downloadUrl, String sha256, String changelog,
			String channel, int rolloutPercent, long downloads, LocalDateTime createdAt) {
	}

	public record DetailView(PackageView pkg, List<VersionView> versions) {
	}

	public record SearchPage(long total, List<PackageView> items) {
	}

	public record RegistryArtifact(byte[] body, String etag) {
	}

	public PackageView createPackage(Long userId, String slug, String name, String author,
			String summary, String description, String category, List<String> tags) {
		MarketRules.requireSlug(slug);
		MarketPackage pkg = new MarketPackage();
		pkg.setOwnerUserId(userId);
		pkg.setSlug(slug);
		pkg.setName(name);
		pkg.setAuthor(author);
		pkg.setSummary(summary);
		pkg.setDescription(description);
		pkg.setCategory(category);
		pkg.setTags(tags == null ? null : objectMapper.writeValueAsString(tags));
		pkg.setStatus("draft");
		try {
			packageMapper.insert(pkg);
		}
		catch (DuplicateKeyException ex) {
			throw new ApiException(HttpStatus.CONFLICT, "market_slug_exists", "该插件 id 已被占用");
		}
		return view(pkg);
	}

	public VersionView addVersion(Long userId, String slug, String version, String downloadUrl,
			String sha256, String changelog, String channel, Integer rolloutPercent) {
		MarketRules.requireVersion(version);
		MarketRules.requireSha256(sha256);
		MarketRules.requireDownloadUrl(downloadUrl, strictGithubUrl);
		String resolvedChannel = channel == null || channel.isBlank() ? "stable" : channel;
		if (!CHANNELS.contains(resolvedChannel)) {
			throw ApiException.badRequest("market_channel_invalid", "channel 只能是 stable/beta/canary");
		}
		int rollout = rolloutPercent == null ? 100 : rolloutPercent;
		MarketRules.requireRollout(rollout);

		MarketPackage pkg = requireOwned(userId, slug);
		MarketVersion row = new MarketVersion();
		row.setPackageId(pkg.getId());
		row.setVersion(version);
		row.setDownloadUrl(downloadUrl);
		row.setSha256(sha256);
		row.setChangelog(changelog);
		row.setChannel(resolvedChannel);
		row.setRolloutPercent(rollout);
		row.setDownloads(0L);
		try {
			versionMapper.insert(row);
		}
		catch (DuplicateKeyException ex) {
			throw new ApiException(HttpStatus.CONFLICT, "market_version_exists", "该版本已存在");
		}
		return toVersionView(row);
	}

	public VersionView setRollout(Long userId, String slug, String version, int percent) {
		MarketRules.requireRollout(percent);
		MarketPackage pkg = requireOwned(userId, slug);
		MarketVersion row = requireVersion(pkg.getId(), version);
		row.setRolloutPercent(percent);
		versionMapper.updateById(row);
		return toVersionView(row);
	}

	public PackageView setStatus(Long userId, String slug, String status) {
		if (!STATUSES.contains(status)) {
			throw ApiException.badRequest("market_status_invalid", "status 只能是 draft/published/deprecated");
		}
		MarketPackage pkg = requireOwned(userId, slug);
		pkg.setStatus(status);
		packageMapper.updateById(pkg);
		return view(pkg);
	}

	public SearchPage search(String query, String category, int page, int size) {
		int pageNo = Math.max(page, 1);
		int pageSize = Math.clamp(size, 1, 50);
		var wrapper = Wrappers.<MarketPackage>lambdaQuery()
				.eq(MarketPackage::getStatus, "published")
				.eq(category != null && !category.isBlank(), MarketPackage::getCategory, category)
				.orderByDesc(MarketPackage::getCreatedAt);
		if (query != null && !query.isBlank()) {
			String needle = query.trim();
			wrapper.and(w -> w.like(MarketPackage::getSlug, needle)
					.or().like(MarketPackage::getName, needle)
					.or().like(MarketPackage::getSummary, needle));
		}
		IPage<MarketPackage> result = packageMapper.selectPage(new Page<>(pageNo, pageSize), wrapper);
		return new SearchPage(result.getTotal(),
				result.getRecords().stream().map(this::view).toList());
	}

	public DetailView detail(String slug) {
		MarketPackage pkg = requireBySlug(slug);
		List<MarketVersion> versions = versionMapper.selectList(Wrappers.<MarketVersion>lambdaQuery()
				.eq(MarketVersion::getPackageId, pkg.getId())
				.orderByDesc(MarketVersion::getCreatedAt));
		return new DetailView(view(pkg), versions.stream().map(MarketService::toVersionView).toList());
	}

	/** 下载统计 + 302 到真实产物地址。 */
	@Transactional
	public String download(String slug, String version) {
		MarketPackage pkg = requireBySlug(slug);
		MarketVersion row = requireVersion(pkg.getId(), version);
		versionMapper.incrementDownloads(row.getId());
		MarketDownload event = new MarketDownload();
		event.setPackageId(pkg.getId());
		event.setVersionId(row.getId());
		event.setSlug(slug);
		event.setVersion(version);
		downloadMapper.insert(event);
		return row.getDownloadUrl();
	}

	/**
	 * 生成宿主可消费的 registry.json（schemaVersion / plugins / signature）。
	 * bucket 用于灰度：只有 rolloutPercent > bucket 的版本才会被选中。
	 */
	public RegistryArtifact registry(int bucket, String channel) {
		String resolvedChannel = channel == null || channel.isBlank() ? "stable" : channel;
		int bucketValue = Math.clamp(bucket, 0, 99);

		ObjectNode root = objectMapper.createObjectNode();
		root.put("schemaVersion", 1);
		ArrayNode plugins = root.putArray("plugins");

		List<MarketPackage> packages = packageMapper.selectList(Wrappers.<MarketPackage>lambdaQuery()
				.eq(MarketPackage::getStatus, "published")
				.orderByAsc(MarketPackage::getSlug));
		if (packages.size() > MAX_REGISTRY_PLUGINS) {
			log.warn("published packages exceed registry limit, truncating to {}", MAX_REGISTRY_PLUGINS);
			packages = packages.subList(0, MAX_REGISTRY_PLUGINS);
		}
		for (MarketPackage pkg : packages) {
			MarketVersion picked = pickVersion(pkg.getId(), resolvedChannel, bucketValue);
			if (picked == null) {
				continue;
			}
			ObjectNode entry = plugins.addObject();
			entry.put("id", pkg.getSlug());
			entry.put("name", pkg.getName());
			entry.put("version", picked.getVersion());
			entry.put("description", pkg.getSummary());
			entry.put("author", pkg.getAuthor());
			entry.put("downloadUrl", picked.getDownloadUrl());
			entry.put("sha256", picked.getSha256());
		}

		byte[] unsigned = objectMapper.writeValueAsBytes(root);
		signer.sign(unsigned).ifPresent(signature -> root.put("signature", signature));
		byte[] body = objectMapper.writeValueAsBytes(root);
		return new RegistryArtifact(body, "\"" + Hashes.sha256Hex(new String(body,
				java.nio.charset.StandardCharsets.UTF_8)) + "\"");
	}

	private MarketVersion pickVersion(Long packageId, String channel, int bucket) {
		List<MarketVersion> candidates = versionMapper.selectList(Wrappers.<MarketVersion>lambdaQuery()
				.eq(MarketVersion::getPackageId, packageId)
				.eq(MarketVersion::getChannel, channel)
				.gt(MarketVersion::getRolloutPercent, bucket));
		MarketVersion best = null;
		for (MarketVersion candidate : candidates) {
			if (best == null || MarketRules.compareVersions(candidate.getVersion(), best.getVersion()) > 0) {
				best = candidate;
			}
		}
		return best;
	}

	private MarketPackage requireBySlug(String slug) {
		MarketPackage pkg = packageMapper.selectOne(Wrappers.<MarketPackage>lambdaQuery()
				.eq(MarketPackage::getSlug, slug));
		if (pkg == null) {
			throw ApiException.notFound("market_package_not_found", "插件不存在");
		}
		return pkg;
	}

	private MarketPackage requireOwned(Long userId, String slug) {
		MarketPackage pkg = requireBySlug(slug);
		if (!pkg.getOwnerUserId().equals(userId)) {
			throw new ApiException(HttpStatus.FORBIDDEN, "market_not_owner", "只有发布者能改动这个插件");
		}
		return pkg;
	}

	private MarketVersion requireVersion(Long packageId, String version) {
		MarketVersion row = versionMapper.selectOne(Wrappers.<MarketVersion>lambdaQuery()
				.eq(MarketVersion::getPackageId, packageId)
				.eq(MarketVersion::getVersion, version));
		if (row == null) {
			throw ApiException.notFound("market_version_not_found", "版本不存在");
		}
		return row;
	}

	private PackageView view(MarketPackage pkg) {
		return new PackageView(pkg.getId(), pkg.getSlug(), pkg.getName(), pkg.getAuthor(),
				pkg.getSummary(), pkg.getDescription(), pkg.getCategory(), readTags(pkg.getTags()),
				pkg.getStatus(), pkg.getCreatedAt());
	}

	private static VersionView toVersionView(MarketVersion row) {
		return new VersionView(row.getVersion(), row.getDownloadUrl(), row.getSha256(),
				row.getChangelog(), row.getChannel(),
				row.getRolloutPercent() == null ? 100 : row.getRolloutPercent(),
				row.getDownloads() == null ? 0L : row.getDownloads(), row.getCreatedAt());
	}

	private List<String> readTags(String raw) {
		if (raw == null || raw.isBlank()) {
			return List.of();
		}
		JsonNode node = objectMapper.readTree(raw);
		List<String> tags = new ArrayList<>();
		node.forEach(item -> tags.add(item.asString()));
		return tags;
	}

}
