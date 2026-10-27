package com.jean.grey.llm;

import com.jean.grey.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 密钥落库前用 AES-GCM 加密，主密钥只从环境变量来。
 */
@Component
public class KeyCipher {

	private static final int IV_BYTES = 12;
	private static final int TAG_BITS = 128;
	private static final SecureRandom RANDOM = new SecureRandom();

	private final SecretKeySpec key;

	public KeyCipher(@Value("${grey.llm.master-key:}") String base64Key) {
		if (base64Key == null || base64Key.isBlank()) {
			this.key = null;
			return;
		}
		byte[] raw = Base64.getDecoder().decode(base64Key.trim());
		if (raw.length != 32) {
			throw new IllegalStateException("grey.llm.master-key 必须是 32 字节的 base64");
		}
		this.key = new SecretKeySpec(raw, "AES");
	}

	public String encrypt(String plaintext) {
		requireKey();
		try {
			byte[] iv = new byte[IV_BYTES];
			RANDOM.nextBytes(iv);
			Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
			cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
			byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
			byte[] payload = new byte[iv.length + encrypted.length];
			System.arraycopy(iv, 0, payload, 0, iv.length);
			System.arraycopy(encrypted, 0, payload, iv.length, encrypted.length);
			return Base64.getEncoder().encodeToString(payload);
		}
		catch (Exception ex) {
			throw new IllegalStateException("密钥加密失败", ex);
		}
	}

	public String decrypt(String payload) {
		requireKey();
		try {
			byte[] raw = Base64.getDecoder().decode(payload);
			Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
			cipher.init(Cipher.DECRYPT_MODE, key,
					new GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES));
			byte[] plain = cipher.doFinal(raw, IV_BYTES, raw.length - IV_BYTES);
			return new String(plain, StandardCharsets.UTF_8);
		}
		catch (Exception ex) {
			throw new IllegalStateException("密钥解密失败，GREY_MASTER_KEY 可能已更换", ex);
		}
	}

	private void requireKey() {
		if (key == null) {
			throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "master_key_missing",
					"未配置 GREY_MASTER_KEY，无法存取供应商密钥");
		}
	}

}
