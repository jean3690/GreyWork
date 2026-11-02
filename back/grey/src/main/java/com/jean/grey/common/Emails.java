package com.jean.grey.common;

import java.util.Locale;

/**
 * 邮箱归一化：入场码与 OIDC 两条登录路径都必须先过这里再落库 / 查库。
 *
 * 不做这一步的后果是同一个邮箱能建出两个账号（{@code A@x.com} 与 {@code a@x.com}），
 * 设备、同步、配额全都按 user_id 分家；而邮箱在 RFC 上地址部分区分大小写、域名不区分，
 * 实际供应商全部按不区分处理，所以统一小写是「与用户预期一致」的做法。
 */
public final class Emails {

	private Emails() {
	}

	/** 去首尾空白 + 全量小写；null / 空白返回 null（调用方自行决定是否视为非法）。 */
	public static String normalize(String raw) {
		if (raw == null) {
			return null;
		}
		String trimmed = raw.trim();
		return trimmed.isEmpty() ? null : trimmed.toLowerCase(Locale.ROOT);
	}

}
