import { describe, expect, it } from "vitest";
import { createMailbox } from "../../src/mailbox";
import type { CoworkMail } from "../../src/types";

function harness() {
  const store: CoworkMail[] = [];
  let seq = 0;
  let clock = 1000;
  const mailbox = createMailbox({
    runId: "cr-test",
    store,
    now: () => {
      clock += 1;
      return clock;
    },
    id: () => {
      seq += 1;
      return `cm-${seq}`;
    },
  });
  return { store, mailbox };
}

describe("createMailbox", () => {
  it("写信默认未读、带 runId 与递增 id", () => {
    const { mailbox, store } = harness();
    const mail = mailbox.write({ from: "user", to: "slot-a", body: "开始干活" });
    expect(mail).toMatchObject({ id: "cm-1", runId: "cr-test", kind: "message", read: false });
    expect(store).toHaveLength(1);
  });

  it("drain 取走该成员位的全部未读并标记已读，二次 drain 为空", () => {
    const { mailbox } = harness();
    mailbox.write({ from: "user", to: "slot-a", body: "一" });
    mailbox.write({ from: "slot-b", to: "slot-a", body: "二" });
    mailbox.write({ from: "user", to: "slot-b", body: "别人的信" });

    const taken = mailbox.drain("slot-a");
    expect(taken.map((mail) => mail.body)).toEqual(["一", "二"]);
    expect(taken.every((mail) => mail.read)).toBe(true);
    expect(mailbox.drain("slot-a")).toEqual([]);
    // 别人的信不受影响
    expect(mailbox.unread("slot-b")).toBe(1);
  });

  it("unread 支持分槽与全局计数", () => {
    const { mailbox } = harness();
    mailbox.write({ from: "user", to: "slot-a", body: "一" });
    mailbox.write({ from: "user", to: "slot-b", body: "二" });
    expect(mailbox.unread("slot-a")).toBe(1);
    expect(mailbox.unread()).toBe(2);
    mailbox.drain("slot-a");
    expect(mailbox.unread()).toBe(1);
  });

  it("historyOf 覆盖收发两侧且最新在前", () => {
    const { mailbox } = harness();
    mailbox.write({ from: "slot-a", to: "slot-b", body: "发出" });
    mailbox.write({ from: "slot-b", to: "slot-a", body: "收到" });
    mailbox.write({ from: "user", to: "slot-c", body: "无关" });

    const history = mailbox.historyOf("slot-a");
    expect(history.map((mail) => mail.body)).toEqual(["收到", "发出"]);
    expect(mailbox.historyOf("slot-a", 1).map((mail) => mail.body)).toEqual(["收到"]);
  });
});
