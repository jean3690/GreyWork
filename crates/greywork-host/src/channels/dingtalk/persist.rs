use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::channel_common::now_ms;

use super::protocol::*;
use super::*;

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人凭据 + 「谁在用这台机器」的归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的人 = 默认只答复的本人（可在设置里放开）。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    pub webhook: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub nick: String,
}

impl PeerBook {
    /// 记录（或刷新）某个联系人可用的回发凭据。
    pub fn remember(&mut self, peer: &str, message: &ChatbotMessage) -> bool {
        let Some(webhook) = message
            .session_webhook
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return false;
        };
        let expires_at = message
            .session_webhook_expired_time
            .unwrap_or_else(|| now_ms() + DEFAULT_WEBHOOK_TTL_MS);
        self.peers.insert(
            peer.to_string(),
            PeerRecord {
                webhook: webhook.to_string(),
                expires_at,
                nick: message.display_nick(),
            },
        );
        true
    }

    pub fn claim_owner(&mut self, peer: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(peer.to_string());
        true
    }

    /// 该联系人的回发凭据（过期即视为没有）。
    pub fn live_webhook(&self, peer: &str, now: i64) -> Option<&PeerRecord> {
        self.peers
            .get(peer)
            .filter(|record| record.expires_at > now)
    }
}
