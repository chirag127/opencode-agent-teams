export interface Actor {
  readonly projectID: string;
  readonly sessionID: string;
}

export class TeamsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TeamsError";
  }
}

export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new TeamsError(code, message);
}

export function text(value: string, label: string, maximum = 16_000): string {
  ensure(typeof value === "string" && value.trim().length > 0 && value.length <= maximum, "INVALID", `${label} must contain 1–${maximum} characters`);
  return value;
}

export function name(value: string): string {
  ensure(typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value), "INVALID", "Names must use 1–64 lowercase letters, digits or hyphens, starting with a letter");
  return value;
}

export interface Team {
  id: string;
  name: string;
  leaderSessionID: string;
  createdAt: number;
}

export type MemberState = "creating" | "ready" | "assigned" | "retired";
export interface Member {
  id: string;
  teamID: string;
  name: string;
  sessionID: string;
  parentSessionID: string | null;
  role: "leader" | "worker";
  state: MemberState;
  runtime: string;
  runtimeAt: number;
  agent: string | null;
  createdAt: number;
}

export type TaskState = "pending" | "claimed" | "running" | "stopping" | "completed" | "failed" | "cancelled";
export interface Task {
  id: string;
  teamID: string;
  title: string;
  description: string;
  state: TaskState;
  ownerSessionID: string | null;
  claimID: string | null;
  version: number;
  progress: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  dependencies: string[];
  blockedBy: string[];
}

export interface Receipt {
  sequence: number;
  teamID: string;
  taskID: string | null;
  actorSessionID: string;
  kind: string;
  claimID: string | null;
  detail: string;
  createdAt: number;
}

export interface Operation {
  id: string;
  teamID: string;
  taskID: string;
  actorSessionID: string;
  memberID: string;
  claimID: string;
  requestID: string;
  kind: "dispatch" | "followup" | "release" | "cancel";
  state: "pending" | "done";
  messageID: string;
  payload: string;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
}
