package com.jean.grey.storage;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.common.ApiException;
import com.jean.grey.config.StorageProperties;
import com.jean.grey.storage.entity.StorageObject;
import com.jean.grey.storage.mapper.StorageObjectMapper;
import java.time.LocalDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.BucketAlreadyExistsException;
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.NoSuchBucketException;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedGetObjectRequest;
import software.amazon.awssdk.services.s3.presigner.model.PresignedPutObjectRequest;

/**
 * 对象存储门面：元数据记账 + 预签名直传/直下。
 * 控制面不代理字节流——客户端拿到预签名 URL 后直连 RustFS，服务端只做鉴权与校验。
 */
@Service
public class StorageService {

	private final StorageProperties properties;
	private final ObjectProvider<S3Client> s3Provider;
	private final ObjectProvider<S3Presigner> presignerProvider;
	private final StorageObjectMapper mapper;

	public StorageService(StorageProperties properties, ObjectProvider<S3Client> s3Provider,
			ObjectProvider<S3Presigner> presignerProvider, StorageObjectMapper mapper) {
		this.properties = properties;
		this.s3Provider = s3Provider;
		this.presignerProvider = presignerProvider;
		this.mapper = mapper;
	}

	public record ConfigView(boolean enabled, String bucket, long maxObjectBytes,
			long presignTtlSeconds, String reason) {
	}

	public record UploadTicket(Long id, String objectKey, String uploadUrl, String method,
			String contentType) {
	}

	public record ObjectView(Long id, String bucket, String objectKey, String name,
			String contentType, Long sizeBytes, String sha256, String kind, String visibility,
			String status, LocalDateTime createdAt) {

		static ObjectView of(StorageObject row) {
			return new ObjectView(row.getId(), row.getBucket(), row.getObjectKey(),
					row.getName(), row.getContentType(), row.getSizeBytes(), row.getSha256(),
					row.getKind(), row.getVisibility(), row.getStatus(), row.getCreatedAt());
		}
	}

	public record DownloadTicket(String url, LocalDateTime expiresAt, boolean direct) {
	}

	public ConfigView config() {
		if (!properties.active()) {
			return new ConfigView(false, properties.bucket(), properties.maxObjectBytes(),
					properties.presignTtl().toSeconds(), properties.missingReason());
		}
		return new ConfigView(true, properties.bucket(), properties.maxObjectBytes(),
				properties.presignTtl().toSeconds(), null);
	}

	/** 创建上传票据：先落 pending 元数据，再给一条预签名 PUT。 */
	public UploadTicket createUpload(Long userId, String name, String contentType,
			Long sizeBytes, String sha256, String visibility) {
		requireActive();
		if (name == null || name.isBlank()) {
			throw ApiException.badRequest("name_required", "文件名不能为空");
		}
		long size = sizeBytes == null ? 0 : sizeBytes;
		if (size <= 0) {
			throw ApiException.badRequest("size_invalid", "sizeBytes 必须为正数");
		}
		if (size > properties.maxObjectBytes()) {
			throw ApiException.badRequest("object_too_large",
					"超过单对象上限 " + properties.maxObjectBytes() + " 字节");
		}

		String cleanName = sanitizeName(name);
		String key = "u%d/%s/%s-%s".formatted(userId,
				LocalDateTime.now().toLocalDate(), shortUuid(), cleanName);
		String type = contentType == null || contentType.isBlank()
				? "application/octet-stream"
				: contentType;

		StorageObject row = new StorageObject();
		row.setUserId(userId);
		row.setBucket(properties.bucket());
		row.setObjectKey(key);
		row.setName(cleanName);
		row.setContentType(type);
		row.setSizeBytes(size);
		row.setSha256(sha256 == null || sha256.isBlank() ? null : sha256.toLowerCase(Locale.ROOT));
		row.setKind("file");
		row.setVisibility("public".equals(visibility) ? "public" : "private");
		row.setStatus("pending");
		row.setSource("upload");
		mapper.insert(row);

		ensureBucket();
		S3Presigner presigner = presignerProvider.getObject();
		PresignedPutObjectRequest presigned = presigner.presignPutObject(
				software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest
						.builder()
						.signatureDuration(properties.presignTtl())
						.putObjectRequest(PutObjectRequest.builder()
								.bucket(properties.bucket())
								.key(key)
								.contentType(type)
								.build())
						.build());
		return new UploadTicket(row.getId(), key, presigned.url().toString(), "PUT", type);
	}

	/** 客户端 PUT 完成后回执：HEAD 校验实际大小，落 ready。 */
	public ObjectView completeUpload(Long userId, Long objectId) {
		StorageObject row = requireOwned(userId, objectId);
		if (!"pending".equals(row.getStatus())) {
			throw ApiException.badRequest("status_invalid", "对象不在待确认状态");
		}
		requireActive();
		HeadObjectResponse head;
		try {
			head = s3Provider.getObject().headObject(HeadObjectRequest.builder()
					.bucket(row.getBucket())
					.key(row.getObjectKey())
					.build());
		}
		catch (NoSuchKeyException | NoSuchBucketException ex) {
			throw ApiException.badRequest("object_not_uploaded",
					"S3 上还没有这个对象，请先完成 PUT");
		}
		if (row.getSizeBytes() != null && head.contentLength() != row.getSizeBytes().longValue()) {
			throw ApiException.badRequest("size_mismatch",
					"实际大小 %d 与声明 %d 不一致".formatted(head.contentLength(),
							row.getSizeBytes()));
		}
		StorageObject patch = new StorageObject();
		patch.setId(row.getId());
		patch.setStatus("ready");
		mapper.updateById(patch);
		return get(userId, objectId);
	}

	public ObjectView get(Long userId, Long objectId) {
		return ObjectView.of(requireOwned(userId, objectId));
	}

	public List<ObjectView> list(Long userId, int limit) {
		return mapper.selectList(Wrappers.<StorageObject>lambdaQuery()
				.eq(StorageObject::getUserId, userId)
				.orderByDesc(StorageObject::getCreatedAt)
				.last("LIMIT " + Math.clamp(limit, 1, 200)))
				.stream().map(ObjectView::of).toList();
	}

	/** 预签名下载；public 且配了 publicBaseUrl 时直接给直链。 */
	public DownloadTicket download(Long userId, Long objectId) {
		StorageObject row = requireOwned(userId, objectId);
		if (!"ready".equals(row.getStatus())) {
			throw ApiException.badRequest("object_not_ready", "对象尚未完成上传确认");
		}
		if ("public".equals(row.getVisibility()) && properties.publicBaseUrl() != null) {
			return new DownloadTicket(
					properties.publicBaseUrl() + "/" + row.getBucket() + "/" + row.getObjectKey(),
					null, true);
		}
		requireActive();
		PresignedGetObjectRequest presigned = presignerProvider.getObject()
				.presignGetObject(
						software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest
								.builder()
								.signatureDuration(properties.presignTtl())
								.getObjectRequest(GetObjectRequest.builder()
										.bucket(row.getBucket())
										.key(row.getObjectKey())
										.build())
								.build());
		return new DownloadTicket(presigned.url().toString(),
				LocalDateTime.now().plus(properties.presignTtl()), false);
	}

	public void delete(Long userId, Long objectId) {
		StorageObject row = requireOwned(userId, objectId);
		if (properties.active()) {
			try {
				s3Provider.getObject().deleteObject(DeleteObjectRequest.builder()
						.bucket(row.getBucket())
						.key(row.getObjectKey())
						.build());
			}
			catch (NoSuchBucketException | NoSuchKeyException ex) {
				// S3 侧已经没了，元数据照删
			}
		}
		mapper.deleteById(row);
	}

	@Scheduled(fixedDelay = 3_600_000)
	public void scheduledCleanup() {
		cleanupPending();
	}

	/** 过期未确认的上传清理：S3 侧孤儿对象留给生命周期规则，这里只收元数据。 */
	public void cleanupPending() {
		if (!properties.active()) {
			return;
		}
		LocalDateTime cutoff = LocalDateTime.now().minus(properties.pendingTtl());
		mapper.delete(Wrappers.<StorageObject>lambdaQuery()
				.eq(StorageObject::getStatus, "pending")
				.lt(StorageObject::getCreatedAt, cutoff));
	}

	StorageObject requireOwned(Long userId, Long objectId) {
		StorageObject row = mapper.selectById(objectId);
		if (row == null || !row.getUserId().equals(userId)) {
			throw new ApiException(HttpStatus.NOT_FOUND, "object_not_found",
					"对象不存在: " + objectId);
		}
		return row;
	}

	private void requireActive() {
		if (!properties.active() || s3Provider.getIfAvailable() == null) {
			throw new ApiException(HttpStatus.CONFLICT, "storage_disabled",
					properties.missingReason());
		}
	}

	/** 自托管友好：桶不存在就建，避免每个部署都手工开桶。 */
	private void ensureBucket() {
		S3Client s3 = s3Provider.getObject();
		try {
			s3.headBucket(HeadBucketRequest.builder().bucket(properties.bucket()).build());
		}
		catch (NoSuchBucketException ex) {
			try {
				s3.createBucket(CreateBucketRequest.builder().bucket(properties.bucket()).build());
			}
			catch (BucketAlreadyExistsException | BucketAlreadyOwnedByYouException ignored) {
				// 并发建桶，无害
			}
		}
		catch (S3Exception ex) {
			// 403 等：无 head 权限就让后续操作自己报错
		}
	}

	private static String sanitizeName(String name) {
		// 只留文件名部分，替换路径分隔符与控制字符
		String clean = name.replace("\\", "/");
		int slash = clean.lastIndexOf('/');
		clean = slash >= 0 ? clean.substring(slash + 1) : clean;
		clean = clean.replaceAll("[\\x00-\\x1f]", "").trim();
		if (clean.isEmpty()) {
			clean = "file";
		}
		return clean.length() > 120 ? clean.substring(clean.length() - 120) : clean;
	}

	private static String shortUuid() {
		byte[] bytes = new byte[6];
		new java.security.SecureRandom().nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

}
