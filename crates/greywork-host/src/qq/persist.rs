use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub app_id: String,
    pub app_secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人与「谁在用这台机器」的归属人 + 被动回复凭据。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的 QQ 用户 = 默认只答复的主人。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    #[serde(default)]
    pub msg_id: String,
    /// 同一 `msg_id` 的回复序号：每次回发 +1（重复的 msg_id + msg_seq 会被服务端拒绝）。
    #[serde(default)]
    pub msg_seq: u64,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记录被动回复凭据；`msg_id` 变了就把序号重置为 0（新消息重新计数）。
    pub fn remember(&mut self, peer: &str, msg_id: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            msg_id: msg_id.to_string(),
            msg_seq: 0,
            last_at: at,
        });
        if entry.msg_id != msg_id {
            entry.msg_id = msg_id.to_string();
            entry.msg_seq = 0;
        }
        entry.last_at = at;
    }

    /// 取下一次回发要用的 (msg_id, msg_seq)。
    pub fn next_reply(&mut self, peer: &str) -> Option<(String, u64)> {
        let entry = self.peers.get_mut(peer)?;
        if entry.msg_id.is_empty() {
            return None;
        }
        entry.msg_seq += 1;
        Some((entry.msg_id.clone(), entry.msg_seq))
    }

    pub fn claim_owner(&mut self, sender: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(sender.to_string());
        true
    }

    pub fn allows(&self, sender: &str, allow_other_senders: bool) -> bool {
        allow_other_senders || self.owner.as_deref() == Some(sender)
    }
}
