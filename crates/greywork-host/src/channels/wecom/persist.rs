use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub bot_id: String,
    pub secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人档案 + 归属人 + 被动回复凭据（最近一次回调的 req_id）。
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
    /// 最近一次回调的 req_id（被动回复凭据，24 小时内有效）。
    #[serde(default)]
    pub req_id: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    pub fn remember(&mut self, peer: &str, req_id: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            req_id: req_id.to_string(),
            last_at: at,
        });
        if !req_id.is_empty() {
            entry.req_id = req_id.to_string();
        }
        entry.last_at = at;
    }

    /// 被动回复凭据（可能已过期，由服务端裁决）。
    pub fn reply_credential(&self, peer: &str) -> Option<String> {
        self.peers
            .get(peer)
            .map(|record| record.req_id.clone())
            .filter(|value| !value.is_empty())
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
