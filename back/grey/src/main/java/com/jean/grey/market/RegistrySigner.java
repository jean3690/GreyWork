package com.jean.grey.market;

import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * registry.json 的 ed25519 签名。
 *
 * 注意：宿主只认官方公钥，且只对「官方 registry 地址」强制验签。
 * 自建源的正确做法是不签名（留空）；只有当运营方持有官方私钥，
 * 或 fork 时改掉了宿主侧公钥常量，才需要配置这个 key。
 */
@Component
public class RegistrySigner {

	private final PrivateKey privateKey;

	public RegistrySigner(@Value("${grey.market.signing-key:}") String base64Pkcs8) {
		if (base64Pkcs8 == null || base64Pkcs8.isBlank()) {
			this.privateKey = null;
			return;
		}
		try {
			byte[] der = Base64.getDecoder().decode(base64Pkcs8.trim());
			this.privateKey = KeyFactory.getInstance("Ed25519")
					.generatePrivate(new PKCS8EncodedKeySpec(der));
		}
		catch (Exception ex) {
			throw new IllegalStateException("grey.market.signing-key 不是合法的 ed25519 PKCS8 base64", ex);
		}
	}

	public Optional<String> sign(byte[] message) {
		if (privateKey == null) {
			return Optional.empty();
		}
		try {
			Signature signature = Signature.getInstance("Ed25519");
			signature.initSign(privateKey);
			signature.update(message);
			return Optional.of(Base64.getEncoder().encodeToString(signature.sign()));
		}
		catch (Exception ex) {
			throw new IllegalStateException("registry 签名失败", ex);
		}
	}

}
