use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub token: String,
    /// 保存时探针取回的 bot 用户（展示用，非秘密）。
    #[serde(default)]
    pub bot_user_id: String,
    #[serde(default)]
    pub bot_username: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 私聊会话档案 + 归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个私聊机器人的 Discord 用户 id = 默认只答复的主人。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// 私聊对端的用户 id。
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记一条私聊：对端 id 是私聊频道 id，展示名与用户 id 随最新一条消息更新。
    pub fn remember(&mut self, peer: &str, user_id: &str, nick: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            user_id: user_id.to_string(),
            nick: nick.to_string(),
            last_at: at,
        });
        entry.user_id = user_id.to_string();
        entry.nick = nick.to_string();
        entry.last_at = at;
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
