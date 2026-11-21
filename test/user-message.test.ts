/**
 * What your messages need besides their edges (message-frame.ts draws those, in
 * either style): the time each one was sent, and the gap in front of it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

const { patchContainerBoxes } = await import("../src/messages/message-frame.ts");
const { USER_MESSAGE_TIME } = await import("../src/messages/user-message.ts");
const { tidyEnabled } = await import("../src/live.ts");
const { InteractiveMode, UserMessageComponent } = await import("@earendil-works/pi-coding-agent");

const W = 40;

// First in the file: the patch stays once installed.
test("drawing your messages as a rail records when each was sent", () => {
  const proto: any = InteractiveMode.prototype;
  const original = proto.addMessageToChat;
  proto.addMessageToChat = function (this: any) {
    this.chatContainer.children.push(new UserMessageComponent("hi" as never));
  };
  try {
    patchContainerBoxes({ user: "border", custom: "warning" }, { includeUser: true, userOpen: true, icons: true });
    const chat = { children: [] as any[] };
    proto.addMessageToChat.call({ chatContainer: chat }, { role: "user", timestamp: 1234 });
    assert.equal(chat.children[0][USER_MESSAGE_TIME], 1234);
  } finally {
    proto.addMessageToChat = original;
  }
});

test("the blank pi puts in front of your message becomes the two-row gap between runs", async () => {
  const { installRunGaps } = await import("../src/messages/user-message.ts");
  const { Container, Spacer } = await import("@earendil-works/pi-tui");
  const proto = (InteractiveMode as any).prototype;
  const original = proto.addMessageToChat;
  // pi's own shape: a blank, then the message. A tool result adds no blank to widen.
  proto.addMessageToChat = function (this: any, message: any) {
    if (message.role === "user") this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new UserMessageComponent(String(message.content) as never));
  };
  try {
    installRunGaps();
    const mode: any = { chatContainer: new Container() };
    proto.addMessageToChat.call(mode, { role: "toolResult", content: "x" });
    proto.addMessageToChat.call(mode, { role: "user", content: "next" });
    const [, gap] = mode.chatContainer.children;
    assert.ok(gap instanceof Spacer, "still a Spacer to whatever looks for pi's blank");
    tidyEnabled.set(true);
    assert.deepEqual(gap.render(W), ["", ""]);
    tidyEnabled.set(false);
    assert.equal(gap.render(W).length, 1, "off, pi's one row");
    tidyEnabled.set(true);
    installRunGaps();
    proto.addMessageToChat.call(mode, { role: "user", content: "again" });
    assert.equal(mode.chatContainer.children[3].render(W).length, 2, "a second install does not wrap twice");
  } finally {
    proto.addMessageToChat = original;
  }
});
