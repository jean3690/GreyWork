import type { CoworkMail, MailKind } from "./types";

/** 见 {@link Mailbox.write}；单列出来是为了让 kind 可选而其余必填。 */
export interface MailInput {
  from: string;
  to: string;
  body: string;
  kind?: MailKind;
  summary?: string;
  taskId?: string;
}

export interface MailboxDeps {
  runId: string;
  /** 信件直接存在 run 快照的数组上，归档时随 run 一起落盘。 */
  store: CoworkMail[];
  now(): number;
  id(): string;
}

export interface Mailbox {
  write(input: MailInput): CoworkMail;
  /**
   * 取走某成员位的全部未读并在同一个同步临界区内标记已读。
   *
   * 必须是同步的：中间一旦出现 await，两个并发唤醒会读到同一批未读并把同一封信
   * 注入两次。这是整套机制唯一的去重手段。
   */
  drain(slotId: string): CoworkMail[];
  /** 未读数；省略 slotId 时统计全 run（引用计数式静止判定的一半输入）。 */
  unread(slotId?: string): number;
  /** 某成员位的收发历史，最新在前。 */
  historyOf(slotId: string, limit?: number): CoworkMail[];
}

export function createMailbox(deps: MailboxDeps): Mailbox {
  const { runId, store, now, id } = deps;

  return {
    write(input) {
      const mail: CoworkMail = {
        id: id(),
        runId,
        from: input.from,
        to: input.to,
        kind: input.kind ?? "message",
        body: input.body,
        summary: input.summary,
        taskId: input.taskId,
        createdAt: now(),
        read: false,
      };
      store.push(mail);
      return mail;
    },

    drain(slotId) {
      const taken: CoworkMail[] = [];
      for (const mail of store) {
        if (mail.read || mail.to !== slotId) continue;
        mail.read = true;
        taken.push(mail);
      }
      return taken;
    },

    unread(slotId) {
      let count = 0;
      for (const mail of store) {
        if (mail.read) continue;
        if (slotId !== undefined && mail.to !== slotId) continue;
        count += 1;
      }
      return count;
    },

    historyOf(slotId, limit) {
      const related = store.filter((mail) => mail.to === slotId || mail.from === slotId);
      related.reverse();
      return limit === undefined ? related : related.slice(0, limit);
    },
  };
}
