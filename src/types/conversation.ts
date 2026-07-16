export type TurnSignal =
  | "substantive"
  | "acknowledgment"
  | "clarification"
  | "correction";
export type TurnState = "kept" | "collapsed" | "pinned";

export interface ConversationTurn {
  _id: string;
  user_id: string;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  provider: string | null;
  created_at: Date;
}
