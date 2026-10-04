use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::channel_common::now_ms;

use super::protocol::*;

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub app_id: String,
    pub app_secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人档案：回消息需要的接收方信息 + 「谁在用这台机器」的归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// "open_id" / "chat_id"。
    pub receive_id_type: String,
    pub receive_id: String,
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_message_id: Option<String>,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    pub fn remember(&mut self, peer: &str, event: &MessageEvent) -> bool {
        let Some((receive_id_type, receive_id)) = event.reply_target() else {
            return false;
        };
        let last_message_id = event
            .event
            .message
            .as_ref()
            .and_then(|message| message.message_id.clone());
        self.peers.insert(
            peer.to_string(),
            PeerRecord {
                receive_id_type: receive_id_type.to_string(),
                receive_id,
                nick: event.display_nick(),
                last_message_id,
                last_at: now_ms(),
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

    pub fn target(&self, peer: &str) -> Option<&PeerRecord> {
        self.peers.get(peer)
    }
}
