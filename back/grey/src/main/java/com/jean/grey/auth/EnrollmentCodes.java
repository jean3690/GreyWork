package com.jean.grey.auth;

import java.security.SecureRandom;

/**
 * 入场码生成：去掉了容易看错的 0/O/1/I，10 位 ≈ 50 bit 熵，配合单次使用与限流足够。
 *
 * 抽出来是为了让「首次启动自动生成」与「运维端点签发」产出同一形态的码，而不是两处各抄一份字母表。
 */
public final class EnrollmentCodes {

	private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	private static final int LENGTH = 10;
	private static final SecureRandom RANDOM = new SecureRandom();

	private EnrollmentCodes() {
	}

	public static String random() {
		StringBuilder builder = new StringBuilder(LENGTH);
		for (int i = 0; i < LENGTH; i++) {
			builder.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
		}
		return builder.toString();
	}

}
