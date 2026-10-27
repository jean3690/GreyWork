package com.jean.grey;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class GreyApplication {

	public static void main(String[] args) {
		SpringApplication.run(GreyApplication.class, args);
	}

}
