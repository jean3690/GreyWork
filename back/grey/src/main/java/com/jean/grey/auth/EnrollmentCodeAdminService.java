package com.jean.grey.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.jean.grey.auth.entity.EnrollmentCode;
import com.jean.grey.auth.mapper.EnrollmentCodeMapper;
import com.jean.grey.common.ApiException;
import com.jean.grey.common.Hashes;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * 运维面的入场码管理。
 *
 * 明文只在**签发那一刻**返回一次：库里只存 sha256（与登录校验同一口径），列表只给哈希前缀
 * 供人对上号。这样即使有人读到库或日志，也拿不到能用的码。
 */
@Service
public class EnrollmentCodeAdminService {

	private static final int MAX_EXPIRES_HOURS = 24 * 30;

	private final EnrollmentCodeMapper enrollmentCodeMapper;

	public EnrollmentCodeAdminService(EnrollmentCodeMapper enrollmentCodeMapper) {
		this.enrollmentCodeMapper = enrollmentCodeMapper;
	}

	public record CodeItem(Long id, String hashPrefix, LocalDateTime expiresAt,
			LocalDateTime usedAt, LocalDateTime createdAt, String status) {
	}

	public record IssuedCode(String code, CodeItem item) {
	}

	public List<CodeItem> list() {
		return enrollmentCodeMapper.selectList(Wrappers.<EnrollmentCode>lambdaQuery()
				.orderByDesc(EnrollmentCode::getCreatedAt)
				.last("LIMIT 100"))
				.stream()
				.map(this::toItem)
				.toList();
	}

	public IssuedCode issue(Integer expiresInHours) {
		int hours = expiresInHours == null ? 24 : Math.min(Math.max(expiresInHours, 1), MAX_EXPIRES_HOURS);
		String raw = EnrollmentCodes.random();
		EnrollmentCode code = new EnrollmentCode();
		code.setCodeHash(Hashes.sha256Hex(raw));
		code.setExpiresAt(LocalDateTime.now().plusHours(hours));
		enrollmentCodeMapper.insert(code);
		return new IssuedCode(raw, toItem(code));
	}

	/** 撤销：只允许删「还没用过」的码；已用过的是审计线索，删掉等于抹掉历史。 */
	public void revoke(Long id) {
		EnrollmentCode code = enrollmentCodeMapper.selectById(id);
		if (code == null) {
			throw ApiException.notFound("enroll_code_not_found", "入场码不存在");
		}
		if (code.getUsedAt() != null) {
			throw ApiException.badRequest("enroll_code_used", "已使用的入场码不能撤销");
		}
		enrollmentCodeMapper.deleteById(id);
	}

	private CodeItem toItem(EnrollmentCode code) {
		String status = code.getUsedAt() != null ? "used"
				: code.getExpiresAt().isBefore(LocalDateTime.now()) ? "expired" : "active";
		return new CodeItem(code.getId(), code.getCodeHash().substring(0, 8),
				code.getExpiresAt(), code.getUsedAt(), code.getCreatedAt(), status);
	}

}
