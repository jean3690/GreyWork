package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.common.Hashes;
import java.time.LocalDateTime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * 首次启动时准备一枚一次性入场码：优先用 GREY_ENROLL_CODE，否则随机生成并打到日志。
 */
@Component
public class EnrollmentCodeBootstrap implements ApplicationRunner {

	private static final Logger log = LoggerFactory.getLogger(EnrollmentCodeBootstrap.class);
	private final EnrollmentCodeMapper enrollmentCodeMapper;
	private final String configuredCode;

	public EnrollmentCodeBootstrap(EnrollmentCodeMapper enrollmentCodeMapper,
			@Value("${grey.auth.enroll-code:}") String configuredCode) {
		this.enrollmentCodeMapper = enrollmentCodeMapper;
		this.configuredCode = configuredCode;
	}

	@Override
	public void run(ApplicationArguments args) {
		if (configuredCode != null && !configuredCode.isBlank()) {
			register(configuredCode.trim());
			return;
		}
		Long active = enrollmentCodeMapper.selectCount(Wrappers.<EnrollmentCode>lambdaQuery()
				.isNull(EnrollmentCode::getUsedAt)
				.gt(EnrollmentCode::getExpiresAt, LocalDateTime.now()));
		if (active != null && active > 0) {
			return;
		}
		String code = EnrollmentCodes.random();
		register(code);
		log.warn("未设置 GREY_ENROLL_CODE，已生成一次性入场码：{}（24 小时内有效，仅显示这一次）", code);
	}

	private void register(String rawCode) {
		String hash = Hashes.sha256Hex(rawCode);
		EnrollmentCode existing = enrollmentCodeMapper.selectOne(Wrappers.<EnrollmentCode>lambdaQuery()
				.eq(EnrollmentCode::getCodeHash, hash));
		if (existing != null) {
			if (existing.getUsedAt() != null) {
				enrollmentCodeMapper.update(null, Wrappers.<EnrollmentCode>lambdaUpdate()
						.set(EnrollmentCode::getUsedAt, null)
						.set(EnrollmentCode::getExpiresAt, LocalDateTime.now().plusDays(1))
						.eq(EnrollmentCode::getId, existing.getId()));
				log.info("入场码已重置");
			}
			return;
		}
		EnrollmentCode code = new EnrollmentCode();
		code.setCodeHash(hash);
		code.setExpiresAt(LocalDateTime.now().plusDays(1));
		enrollmentCodeMapper.insert(code);
	}

}
