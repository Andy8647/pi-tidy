/**
 * A `/skill:<name>` invocation, drawn as the prompt it is.
 *
 * pi stores `/skill:grill-me fix the parser` as one user message — the skill's
 * file wrapped in `<skill>` tags, then what was typed after the command — and
 * draws it as two components: a `[skill] grill-me` box in the colours of an
 * extension's notice, and, when something was typed after it, a user message
 * underneath. The first is what the reader typed, and it read as neither their
 * prompt nor part of the turn it started.
 *
 * Here the two become one user message, drawn however user messages are drawn
 * (frame or rail, alignment, the time): `/skill:grill-me ▸` and what was typed
 * after it. A click, or ctrl+o, opens the skill's text inside it. The skill
 * component draws through a `UserMessageComponent` of its own, so every user
 * message style applies without a second implementation of any of them.
 *
 * The chat is regrouped once, as pi adds the message: the user message pi drew
 * for the typed text, and the blank row in front of it, leave the chat and are
 * kept on the skill component. Nothing else holds them, and with tidy disabled
 * the skill component draws pi's two components again, in pi's order.
 */

import { InteractiveMode, SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { tidyEnabled } from "../live.ts";
import { USER_MESSAGE_TIME } from "./user-message.ts";

const ADOPT_PATCH = Symbol.for("pi-tidy:skill-prompt-adopt");
const RENDER_PATCH = Symbol.for("pi-tidy:skill-prompt-render");
/** The user message pi drew for the text typed after the command, taken out of the chat. */
const TYPED = Symbol.for("pi-tidy:skill-prompt-typed");
/** The user message this skill draws through, and the text it was built for. */
const PROMPT = Symbol.for("pi-tidy:skill-prompt-view");

interface SkillInternals {
  skillBlock: { name: string; content: string; userMessage?: string };
  expanded: boolean;
  markdownTheme?: unknown;
  markdownTransformers?: readonly unknown[];
  messageId?: string;
  timestamp?: string;
  setExpanded(expanded: boolean): void;
  render(width: number): readonly string[];
  handleMouse?(event: unknown): unknown;
  [TYPED]?: UserMessageComponent;
  [PROMPT]?: { text: string; view: UserMessageComponent };
  [USER_MESSAGE_TIME]?: number;
}

/** What the prompt says: the command, what was typed after it, and the skill's text when opened. */
function promptText(skill: SkillInternals): string {
  const { name, content, userMessage } = skill.skillBlock;
  const typed = userMessage ? `\n\n${userMessage}` : "";
  return skill.expanded ? `/skill:${name} ▾${typed}\n\n---\n\n${content}` : `/skill:${name} ▸${typed}`;
}

function promptView(skill: SkillInternals): UserMessageComponent {
  const text = promptText(skill);
  const cached = skill[PROMPT];
  if (cached?.text === text) return cached.view;
  const view = new UserMessageComponent(
    text,
    skill.markdownTheme as any,
    1,
    (skill.markdownTransformers ?? []) as any,
    skill.messageId,
    skill.timestamp,
  );
  if (typeof skill[USER_MESSAGE_TIME] === "number") (view as any)[USER_MESSAGE_TIME] = skill[USER_MESSAGE_TIME];
  skill[PROMPT] = { text, view };
  return view;
}

/**
 * Take the typed text's user message, and the blank row pi put in front of it,
 * out of the chat as pi adds a skill invocation. Runs on every message pi adds
 * — a live prompt, a resumed session, a switch to another branch.
 */
export function adopt(chat: { children: unknown[] }, from: number, timestamp: unknown): void {
  const children = chat.children;
  for (let i = from; i < children.length; i++) {
    const skill = children[i];
    if (!(skill instanceof SkillInvocationMessageComponent)) continue;
    const internals = skill as unknown as SkillInternals;
    if (typeof timestamp === "number") internals[USER_MESSAGE_TIME] = timestamp;
    const spacer = children[i + 1];
    const typed = children[i + 2];
    if (spacer instanceof Spacer && typed instanceof UserMessageComponent && internals.skillBlock?.userMessage) {
      children.splice(i + 1, 2);
      internals[TYPED] = typed;
    }
  }
}

/** Install once per process; `tidyEnabled` decides each frame whether it draws. */
export function installSkillPrompts(): void {
  const interactive = (InteractiveMode as any)?.prototype;
  const add = interactive?.addMessageToChat;
  if (typeof add === "function" && !add[ADOPT_PATCH]) {
    const wrapped = function (this: any, message: any, options?: any) {
      const chat = this?.chatContainer;
      const before = Array.isArray(chat?.children) ? chat.children.length : -1;
      const result = add.call(this, message, options);
      if (message?.role === "user" && before >= 0) adopt(chat, before, message.timestamp);
      return result;
    };
    (wrapped as any)[ADOPT_PATCH] = true;
    interactive.addMessageToChat = wrapped;
  }

  const proto = SkillInvocationMessageComponent.prototype as unknown as SkillInternals & { [RENDER_PATCH]?: boolean };
  if (proto[RENDER_PATCH]) return;
  proto[RENDER_PATCH] = true;
  const originalRender = proto.render;
  const originalMouse = proto.handleMouse;

  proto.render = function (this: SkillInternals, width: number): readonly string[] {
    if (!tidyEnabled.get()) {
      // pi's two components, in pi's order: the typed text was only ever moved.
      const rows = originalRender.call(this, width);
      const typed = this[TYPED];
      return typed ? [...rows, "", ...typed.render(width)] : rows;
    }
    try {
      return promptView(this).render(width);
    } catch {
      return originalRender.call(this, width);
    }
  };

  // The whole prompt is the switch, the way pi's own skill box is: a click opens
  // the skill's text in it, and the next one shuts it.
  proto.handleMouse = function (this: SkillInternals, event: any) {
    if (!tidyEnabled.get()) return originalMouse?.call(this, event);
    if (event?.type !== "click" || (event.button !== "left" && event.button !== 0)) return undefined;
    this.setExpanded(!this.expanded);
    return { handled: true, render: true };
  };
}
