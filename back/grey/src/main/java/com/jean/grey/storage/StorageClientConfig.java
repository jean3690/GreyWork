package com.jean.grey.storage;

import com.jean.grey.config.StorageProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

/**
 * S3 客户端装配：RustFS / MinIO / 任意 S3 兼容端点。
 * grey.storage.enabled=false 时不装配，整个存储模块保持只读降级。
 */
@Configuration
@ConditionalOnProperty(prefix = "grey.storage", name = "enabled", havingValue = "true")
public class StorageClientConfig {

	@Bean
	public S3Client s3Client(StorageProperties properties) {
		return S3Client.builder()
				.region(Region.of(properties.region()))
				.endpointOverride(java.net.URI.create(properties.endpoint()))
				.credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
						properties.accessKey(), properties.secretKey())))
				.forcePathStyle(properties.pathStyle())
				.build();
	}

	@Bean
	public S3Presigner s3Presigner(StorageProperties properties) {
		// Presigner.Builder 没有 forcePathStyle，路径寻址要经 S3Configuration 打开
		return S3Presigner.builder()
				.region(Region.of(properties.region()))
				.endpointOverride(java.net.URI.create(properties.endpoint()))
				.serviceConfiguration(software.amazon.awssdk.services.s3.S3Configuration.builder()
						.pathStyleAccessEnabled(properties.pathStyle())
						.build())
				.credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
						properties.accessKey(), properties.secretKey())))
				.build();
	}

}
