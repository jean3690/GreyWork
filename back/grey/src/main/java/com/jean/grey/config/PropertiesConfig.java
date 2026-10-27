package com.jean.grey.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties({ OidcProperties.class, StorageProperties.class,
		AiProperties.class, AutomationProperties.class })
public class PropertiesConfig {

}
