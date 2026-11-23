import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { folded, TurnStore, TURN_ENTRY, turnOptions, turnStore, type TurnMessage } from "./turn-state.ts";

export function restoreBranchTurns(ctx: Pick<ExtensionContext, "sessionManager">): void {
  const store = new TurnStore();
  store.restore(ctx.sessionManager.getBranch());
  turnStore.set(store);
}

export function toggleTurn(target: string | undefined, ctx: Pick<ExtensionContext, "ui">): void {
  const resolved = target || "last";
  const turns = [...new Set(turnStore.get().byMessage.values())];
  const index = resolved === "last" ? turns.length - 1 : Number(resolved) - 1;
  const turn = turns[index];
  if (!Number.isInteger(index) || !turn || turnOptions.get().collapseTurns === "off") {
    ctx.ui.notify("Usage: /tidy turn [number|last] (requires tidy.collapseTurns)", "warning");
    return;
  }
  turn.open = folded(turn);
}

export function connectTurns(pi: ExtensionAPI): void {
  // A segment the run leaves behind is written down as it closes, not when the
  // run settles: one run can hold several of them, and only the last is current
  // by then.
  const note = (message: TurnMessage, ended = false) => {
    const closed = turnStore.get().note(message, ended);
    if (closed?.keys.length) pi.appendEntry(TURN_ENTRY, closed);
  };
  pi.on("session_start", (_event, ctx) => restoreBranchTurns(ctx));
  pi.on("session_tree", (_event, ctx) => restoreBranchTurns(ctx));
  pi.on("before_agent_start", () => { turnStore.get().begin(); });
  pi.on("agent_start", () => { turnStore.get().begin(); });
  pi.on("before_provider_request", () => { turnStore.get().requestStart(); });
  pi.on("message_start", ({ message }) => { note(message); });
  pi.on("message_update", ({ message }) => { note(message); });
  pi.on("message_end", ({ message }) => { note(message, true); });
  pi.on("tool_execution_start", (event) => {
    turnStore.get().toolStart(event.toolCallId, event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    turnStore.get().toolEnd(event.toolCallId, event.parentToolCallId);
  });
  pi.on("agent_before_settle", (event) => { turnStore.get().settlementOutcome = event.outcome; });
  pi.on("agent_settled", (event) => {
    const saved = turnStore.get().settle(event.aborted);
    if (saved?.keys.length) pi.appendEntry(TURN_ENTRY, saved);
  });
}
