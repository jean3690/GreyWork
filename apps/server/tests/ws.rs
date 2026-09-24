//! WebSocket 事件总线集成测试：真实端口 + 真实客户端（升级无法 oneshot）。

mod common;

use std::net::SocketAddr;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use common::{harness, login, serve, PASSWORD};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 读下一帧并解析为 JSON（跳过 ping/pong）。
async fn next_json(socket: &mut Ws) -> Value {
    loop {
        let message = socket.next().await.expect("连接应保持").expect("帧应合法");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).expect("事件应为 JSON"),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("意外帧: {other:?}"),
        }
    }
}

fn ws_url(addr: SocketAddr, token: Option<&str>) -> String {
    match token {
        Some(token) => format!("ws://{addr}/api/events?token={token}"),
        None => format!("ws://{addr}/api/events"),
    }
}

#[tokio::test]
async fn ws_requires_auth() {
    let h = harness("ws-auth");
    let addr = serve(h.router.clone()).await;
    let result = tokio_tungstenite::connect_async(ws_url(addr, None)).await;
    assert!(result.is_err(), "未认证不应完成 WS 升级");
}

#[tokio::test]
async fn ws_delivers_events_to_cookie_client() {
    let h = harness("ws-events");
    let token = login(&h.router, PASSWORD).await;
    let addr = serve(h.router.clone()).await;

    // 浏览器 WS API 不能设 Authorization，故走 cookie。
    let mut request = ws_url(addr, None)
        .into_client_request()
        .expect("构造 WS 请求");
    request
        .headers_mut()
        .insert("cookie", format!("gw_session={token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("cookie 升级应成功");

    let hello = next_json(&mut socket).await;
    assert_eq!(hello["event"], "host://hello");

    h.state.bus.publish("test://event", json!({ "n": 1 }));
    let event = next_json(&mut socket).await;
    assert_eq!(event["event"], "test://event");
    assert_eq!(event["payload"]["n"], 1);
}

#[tokio::test]
async fn ws_accepts_query_token() {
    let h = harness("ws-query");
    let token = login(&h.router, PASSWORD).await;
    let addr = serve(h.router.clone()).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url(addr, Some(&token)))
        .await
        .expect("token 升级应成功");
    let hello = next_json(&mut socket).await;
    assert_eq!(hello["event"], "host://hello");
}

#[tokio::test]
async fn publish_after_disconnect_is_not_an_error() {
    let h = harness("ws-drop");
    let token = login(&h.router, PASSWORD).await;
    let addr = serve(h.router.clone()).await;
    let (socket, _) = tokio_tungstenite::connect_async(ws_url(addr, Some(&token)))
        .await
        .unwrap();
    drop(socket);
    // 订阅者已消失；publish 不应 panic。
    h.state.bus.publish("test://event", json!({}));
}
