/**
 * What your messages need besides their edges, which message-frame.ts draws in either
 * style: the time each one was sent, and the gap in front of it that starts a run.
 */

import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { GAP_RUN } from "../draw/rhythm.ts";
import { tidyEnabled } from "../live.ts";

/** `tidy.userMessageStyle`, resolved: a style, or pi's own look. */
export type UserMessageStyle = "frame" | "rail" | "off";

/**
 * A frame's side. clean-copy.ts recognises a framed row by it and strips it from the
 * clipboard, and older pi-starline versions do the same.
 */
export const USER_RAIL_GLYPH = "│";

/** Where the user message's clock is kept: pi's component only holds the text. */
export const USER_MESSAGE_TIME = Symbol.for("pi-tidy:user-message-time");
const USER_TIME_PATCH = Symbol.for("pi-tidy:user-time-patch");

export function installUserMessageTimes(): void {
  const proto = (InteractiveMode as any)?.prototype;
  const original = proto?.addMessageToChat;
  if (typeof original !== "function" || original[USER_TIME_PATCH]) return;
  const wrapped = function (this: any, message: any, options?: any) {
    const chat = this?.chatContainer;
    const before = Array.isArray(chat?.children) ? chat.children.length : -1;
    const result = original.call(this, message, options);
    if (message?.role === "user" && typeof message.timestamp === "number" && before >= 0) {
      for (let i = before; i < chat.children.length; i++) {
        const child = chat.children[i];
        if (child instanceof UserMessageComponent) (child as any)[USER_MESSAGE_TIME] = message.timestamp;
      }
    }
    return result;
  };
  (wrapped as any)[USER_TIME_PATCH] = true;
  proto.addMessageToChat = wrapped;
}

/**
 * The blank row pi puts in front of your message, widened to the gap between two runs
 * (turn-view.ts holds the scale). A Spacer still, so code that looks for pi's blank in
 * front of a message finds it.
 */
class RunGap extends Spacer {
  override render(width: number): string[] {
    return tidyEnabled.get() ? Array.from({ length: GAP_RUN }, () => "") : super.render(width);
  }
}

const RUN_GAP_PATCH = Symbol.for("pi-tidy:run-gap-patch");

/**
 * Your message starts a run, so the blank in front of it is the gap between the run
 * before and this one. pi adds it as the first child of the message it appends.
 */
export function installRunGaps(): void {
  const proto = (InteractiveMode as any)?.prototype;
  const original = proto?.addMessageToChat;
  if (typeof original !== "function" || original[RUN_GAP_PATCH]) return;
  const wrapped = function (this: any, message: any, options?: any) {
    const chat = this?.chatContainer;
    const before = Array.isArray(chat?.children) ? chat.children.length : -1;
    const result = original.call(this, message, options);
    const first = before >= 0 ? chat.children[before] : undefined;
    if (message?.role === "user" && first instanceof Spacer && !(first instanceof RunGap)) chat.children[before] = new RunGap(1);
    return result;
  };
  (wrapped as any)[RUN_GAP_PATCH] = true;
  proto.addMessageToChat = wrapped;
}
