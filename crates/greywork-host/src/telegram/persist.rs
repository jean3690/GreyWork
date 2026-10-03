use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub token: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 「谁在用这台机器」+ 联系人档案。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的 chat = 默认只答复的主人（可在设置里放开）。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记录（或刷新）联系人档案。
    pub fn remember(&mut self, peer: &str, nick: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            nick: nick.to_string(),
            last_at: at,
        });
        if !nick.is_empty() {
            entry.nick = nick.to_string();
        }
        entry.last_at = at;
    }

    pub fn claim_owner(&mut self, peer: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(peer.to_string());
        true
    }

    /// 是否允许答复该对端（归属人策略的唯一判定点，连接参数与档案共同决定）。
    pub fn allows(&self, peer: &str, allow_other_senders: bool) -> bool {
        allow_other_senders || self.owner.as_deref() == Some(peer)
    }
}
