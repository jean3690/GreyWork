package com.jean.grey.automation;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** 通知只唤醒认领，队列才是真源；断线不影响可靠投递。连接每分钟重建并重新鉴权。 */
@Component
public class AutomationNotifications {
	private record Subscriber(Long userId, Long deviceId, SseEmitter emitter) {}
	private final Set<Subscriber> subscribers = ConcurrentHashMap.newKeySet();

	public SseEmitter subscribe(Long userId, Long deviceId) {
		SseEmitter emitter = new SseEmitter(60_000L);
		Subscriber subscriber = new Subscriber(userId, deviceId, emitter);
		subscribers.add(subscriber);
		Runnable remove = () -> subscribers.remove(subscriber);
		emitter.onCompletion(remove);
		emitter.onTimeout(remove);
		emitter.onError(error -> remove.run());
		send(subscriber, "ready");
		return emitter;
	}

	public void notifyDue(Long userId, Long deviceId) {
		for (Subscriber subscriber : subscribers) {
			if (userId.equals(subscriber.userId())
					&& (deviceId == null || deviceId.equals(subscriber.deviceId()))) {
				send(subscriber, "due");
			}
		}
	}

	private void send(Subscriber subscriber, String name) {
		try {
			subscriber.emitter().send(SseEmitter.event().name(name).data("claim"));
		} catch (IOException | IllegalStateException error) {
			subscribers.remove(subscriber);
			subscriber.emitter().complete();
		}
	}
}
