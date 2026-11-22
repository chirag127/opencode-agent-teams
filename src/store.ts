import { randomUUID } from "node:crypto";
import { ensure, name, text } from "./domain.js";
import type { Actor, Team, Member, Task, Receipt, Operation } from "./domain.js";
import { schema } from "./schema.js";
import { Sqlite } from "./sqlite.js";

export type { Actor } from "./domain.js";
type TaskRow = Omit<Task, "dependencies" | "blockedBy">;
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export class TeamsStore {
  private constructor(private readonly db: Sqlite, readonly projectID: string) {}

  static async open(filename: string, projectID: string): Promise<TeamsStore> {
    text(projectID, "Project ID", 256);
    const db = await Sqlite.open(filename);
    try {
      db.transaction(() => {
        db.exec(schema);
        const binding = db.get<{ project: string; version: number }>("SELECT project, version FROM binding WHERE id = 1");
        if (binding) {
          ensure(binding.project === projectID, "PROJECT", "Database belongs to another project");
          ensure(binding.version === 1, "VERSION", "Unsupported teams database version");
        } else db.run("INSERT INTO binding VALUES (1, ?, 1)", projectID);
      });
      return new TeamsStore(db, projectID);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private actor(actor: Actor): void {
    ensure(actor.projectID === this.projectID, "PROJECT", "Caller belongs to another project");
    text(actor.sessionID, "Session ID", 256);
  }

  private team(actor: Actor, teamName: string, leader = false): Team {
    this.actor(actor);
    const team = this.db.get<Team>("SELECT * FROM teams WHERE name = ?", name(teamName));
    ensure(team, "NOT_FOUND", "Team not found");
    const member = this.db.get<Member>("SELECT * FROM members WHERE teamID = ? AND sessionID = ? AND state <> 'creating'", team.id, actor.sessionID);
    ensure(member, "FORBIDDEN", "Caller is not a team member");
    ensure(!leader || team.leaderSessionID === actor.sessionID, "FORBIDDEN", "Only the team leader may perform this action");
    return team;
  }

  getTeam(actor: Actor, teamName: string, leader = false): Team {
    return this.team(actor, teamName, leader);
  }

  createTeam(actor: Actor, teamName: string): Team {
    this.actor(actor);
    name(teamName);
    return this.db.transaction(() => {
      const existing = this.db.get<Team>("SELECT * FROM teams WHERE name = ?", teamName);
      if (existing) {
        ensure(existing.leaderSessionID === actor.sessionID, "CONFLICT", "Team name is already in use");
        return existing;
      }
      ensure(this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM teams")!.count < 64, "LIMIT", "Project team limit reached");
      const team: Team = { id: id("team"), name: teamName, leaderSessionID: actor.sessionID, createdAt: Date.now() };
      this.db.run("INSERT INTO teams VALUES (?, ?, ?, ?)", team.id, team.name, team.leaderSessionID, team.createdAt);
      this.db.run("INSERT INTO members (id, teamID, name, sessionID, role, state, createdAt) VALUES (?, ?, 'leader', ?, 'leader', 'ready', ?)", id("member"), team.id, actor.sessionID, team.createdAt);
      this.receipt(team.id, actor, null, "team.created", null, teamName);
      return team;
    });
  }

  listTeams(actor: Actor): Team[] {
    this.actor(actor);
    return this.db.all<Team>("SELECT t.* FROM teams t JOIN members m ON m.teamID = t.id WHERE m.sessionID = ? AND m.state <> 'creating' ORDER BY t.createdAt, t.id", actor.sessionID);
  }

  members(actor: Actor, teamName: string): Member[] {
    const team = this.team(actor, teamName);
    return this.db.all<Member>("SELECT * FROM members WHERE teamID = ? ORDER BY createdAt, id", team.id);
  }

  member(actor: Actor, teamName: string, memberName: string): Member {
    const team = this.team(actor, teamName);
    const member = this.db.get<Member>("SELECT * FROM members WHERE teamID = ? AND name = ?", team.id, name(memberName));
    ensure(member, "NOT_FOUND", "Team member not found");
    return member;
  }

  workerBySession(sessionID: string): Member | undefined {
    return this.db.get<Member>("SELECT * FROM members WHERE sessionID = ? AND role = 'worker'", sessionID);
  }

  assignment(sessionID: string): { member: Member; team: Team; task: Task | null } | undefined {
    const member = this.workerBySession(sessionID);
    if (!member) return;
    const team = this.db.get<Team>("SELECT * FROM teams WHERE id = ?", member.teamID)!;
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE ownerSessionID = ? ORDER BY updatedAt DESC, id LIMIT 1", sessionID);
    return { member, team, task: row ? this.view(row) : null };
  }

  reserveMember(actor: Actor, teamName: string, memberName: string, agent: string): Member {
    name(memberName);
    text(agent, "Agent", 256);
    ensure(memberName !== "leader", "INVALID", "The leader address is reserved");
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      const existing = this.db.get<Member>("SELECT * FROM members WHERE teamID = ? AND name = ?", team.id, memberName);
      if (existing) {
        ensure(existing.agent === agent, "CONFLICT", "Member name is already reserved for a different agent");
        return existing;
      }
      ensure(this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM members WHERE teamID = ?", team.id)!.count < 65, "LIMIT", "Team member limit reached (64 workers)");
      const member: Member = {
        id: id("member"), teamID: team.id, name: memberName, sessionID: id("ses"), parentSessionID: actor.sessionID,
        role: "worker", state: "creating", runtime: "unknown", runtimeAt: 0, agent, createdAt: Date.now(),
      };
      this.db.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", member.id, member.teamID, member.name, member.sessionID, member.parentSessionID, member.role, member.state, member.runtime, member.runtimeAt, member.agent, member.createdAt);
      this.receipt(team.id, actor, null, "member.reserved", null, member.name);
      return member;
    });
  }

  activateMember(actor: Actor, teamName: string, memberName: string): Member {
    return this.db.transaction(() => {
      this.team(actor, teamName, true);
      const member = this.member(actor, teamName, memberName);
      if (member.state === "creating") {
        this.db.run("UPDATE members SET state = 'ready' WHERE id = ?", member.id);
        this.receipt(member.teamID, actor, null, "member.ready", null, member.name);
      }
      return this.member(actor, teamName, memberName);
    });
  }

  observe(sessionID: string, runtime: string, at: number): void {
    this.db.run("UPDATE members SET runtime = ?, runtimeAt = ? WHERE sessionID = ? AND role = 'worker' AND runtimeAt <= ?", runtime, at, sessionID, at);
  }

  createTask(actor: Actor, teamName: string, input: { title: string; description: string; dependencies?: string[] }): Task {
    text(input.title, "Title", 256);
    text(input.description, "Description");
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      ensure(this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE teamID = ?", team.id)!.count < 1_000, "LIMIT", "Team task limit reached (1000)");
      const taskID = id("task");
      const now = Date.now();
      this.db.run("INSERT INTO tasks (id, teamID, title, description, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'pending', ?, ?)", taskID, team.id, input.title, input.description, now, now);
      this.dependencies(team.id, taskID, input.dependencies ?? []);
      this.receipt(team.id, actor, taskID, "task.created", null, input.title);
      return this.task(actor, teamName, taskID);
    });
  }

  private row(teamID: string, taskID: string): TaskRow {
    text(taskID, "Task ID", 128);
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE teamID = ? AND id = ?", teamID, taskID);
    ensure(row, "NOT_FOUND", "Task not found in this team");
    return row;
  }

  private view(row: TaskRow): Task {
    const deps = this.db.all<{ id: string; state: Task["state"] }>("SELECT t.id, t.state FROM dependencies d JOIN tasks t ON t.id = d.dependencyID WHERE d.taskID = ? ORDER BY t.id", row.id);
    return { ...row, dependencies: deps.map((dep) => dep.id), blockedBy: deps.filter((dep) => dep.state !== "completed").map((dep) => dep.id) };
  }

  task(actor: Actor, teamName: string, taskID: string): Task {
    const team = this.team(actor, teamName);
    return this.view(this.row(team.id, taskID));
  }

  tasks(actor: Actor, teamName: string, after = ""): { tasks: Task[]; next: string | null; counts: Record<string, number> } {
    const team = this.team(actor, teamName);
    const rows = this.db.all<TaskRow>("SELECT * FROM tasks WHERE teamID = ? AND id > ? ORDER BY id LIMIT 101", team.id, after);
    const counts = Object.fromEntries(this.db.all<{ state: string; count: number }>("SELECT state, COUNT(*) AS count FROM tasks WHERE teamID = ? GROUP BY state", team.id).map((row) => [row.state, row.count]));
    return { tasks: rows.slice(0, 100).map((row) => this.view(row)), next: rows.length > 100 ? rows[99]!.id : null, counts };
  }

  private dependencies(teamID: string, taskID: string, dependencies: string[]): void {
    ensure(Array.isArray(dependencies) && dependencies.length <= 100 && new Set(dependencies).size === dependencies.length, "INVALID", "At most 100 distinct dependencies are allowed");
    for (const dependencyID of dependencies) {
      ensure(dependencyID !== taskID, "CYCLE", "A task cannot depend on itself");
      this.row(teamID, dependencyID);
      const cycle = this.db.get("WITH RECURSIVE reachable(id) AS (SELECT ? UNION SELECT d.dependencyID FROM dependencies d JOIN reachable r ON d.taskID = r.id WHERE d.teamID = ?) SELECT 1 FROM reachable WHERE id = ? LIMIT 1", dependencyID, teamID, taskID);
      ensure(!cycle, "CYCLE", "Task dependencies must be acyclic");
    }
    this.db.run("DELETE FROM dependencies WHERE taskID = ?", taskID);
    for (const dependencyID of dependencies) this.db.run("INSERT INTO dependencies VALUES (?, ?, ?)", teamID, taskID, dependencyID);
  }

  updateTask(actor: Actor, teamName: string, taskID: string, input: { version: number; title?: string; description?: string; dependencies?: string[] }): Task {
    if (input.title !== undefined) text(input.title, "Title", 256);
    if (input.description !== undefined) text(input.description, "Description");
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      const task = this.row(team.id, taskID);
      ensure(task.version === input.version, "CONFLICT", "Task changed; read its current version before editing");
      ensure(task.state === "pending", "STATE", "Only pending tasks can be edited");
      if (input.dependencies !== undefined) this.dependencies(team.id, taskID, input.dependencies);
      this.db.run("UPDATE tasks SET title = ?, description = ?, version = version + 1, updatedAt = ? WHERE id = ?", input.title ?? task.title, input.description ?? task.description, Date.now(), taskID);
      this.receipt(team.id, actor, taskID, "task.updated", null, "Task definition updated");
      return this.task(actor, teamName, taskID);
    });
  }

  private claimFor(actor: Actor, team: Team, taskID: string, owner: Member): Task {
    const task = this.view(this.row(team.id, taskID));
    if ((task.state === "claimed" || task.state === "running") && task.ownerSessionID === owner.sessionID) return task;
    ensure(task.state === "pending", "CONFLICT", "Task is already claimed or terminal");
    ensure(owner.state === "ready", "STATE", "Worker is not ready; use a new member for another attempt");
    ensure(task.blockedBy.length === 0, "BLOCKED", "Task has incomplete dependencies");
    ensure(!this.db.get("SELECT 1 FROM tasks WHERE ownerSessionID = ? AND state IN ('claimed','running','stopping')", owner.sessionID), "CONFLICT", "Member already owns an active task");
    const claimID = id("claim");
    this.db.run("UPDATE tasks SET state = 'claimed', ownerSessionID = ?, claimID = ?, version = version + 1, updatedAt = ? WHERE id = ?", owner.sessionID, claimID, Date.now(), taskID);
    if (owner.role === "worker") this.db.run("UPDATE members SET state = 'assigned' WHERE id = ?", owner.id);
    this.receipt(team.id, actor, taskID, "task.claimed", claimID, owner.name);
    return this.view(this.row(team.id, taskID));
  }

  claim(actor: Actor, teamName: string, taskID: string): Task {
    return this.db.transaction(() => {
      const team = this.team(actor, teamName);
      const member = this.db.get<Member>("SELECT * FROM members WHERE teamID = ? AND sessionID = ?", team.id, actor.sessionID)!;
      return this.claimFor(actor, team, taskID, member);
    });
  }

  private owned(actor: Actor, teamName: string, taskID: string, claimID: string): Task {
    const task = this.task(actor, teamName, taskID);
    ensure(task.ownerSessionID === actor.sessionID, "FORBIDDEN", "Only the claim owner may report task work");
    ensure(task.claimID === claimID, "STALE_CLAIM", "Claim token is stale");
    return task;
  }

  start(actor: Actor, teamName: string, taskID: string, claimID: string): Task {
    return this.db.transaction(() => {
      const task = this.owned(actor, teamName, taskID, claimID);
      if (task.state === "running") return task;
      ensure(task.state === "claimed", "STATE", "Task cannot start in this state");
      this.db.run("UPDATE tasks SET state = 'running', version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), taskID);
      this.receipt(task.teamID, actor, taskID, "task.started", claimID, "Work started");
      return this.task(actor, teamName, taskID);
    });
  }

  progress(actor: Actor, teamName: string, taskID: string, claimID: string, progress: string): Task {
    text(progress, "Progress", 4_000);
    return this.db.transaction(() => {
      const task = this.owned(actor, teamName, taskID, claimID);
      ensure(task.state === "claimed" || task.state === "running", "STATE", "Task is not active");
      if (task.progress === progress) return task;
      this.db.run("UPDATE tasks SET progress = ?, version = version + 1, updatedAt = ? WHERE id = ?", progress, Date.now(), taskID);
      this.receipt(task.teamID, actor, taskID, "task.progress", claimID, progress);
      return this.task(actor, teamName, taskID);
    });
  }

  private retire(task: Task): void {
    if (task.ownerSessionID) this.db.run("UPDATE members SET state = 'retired' WHERE sessionID = ? AND role = 'worker'", task.ownerSessionID);
  }

  finish(actor: Actor, teamName: string, taskID: string, claimID: string, outcome: "completed" | "failed", detail: string): Task {
    text(detail, "Result or failure");
    ensure(outcome === "completed" || outcome === "failed", "INVALID", "Invalid task outcome");
    return this.db.transaction(() => {
      const task = this.owned(actor, teamName, taskID, claimID);
      if (task.state === outcome) {
        ensure((outcome === "completed" ? task.result : task.error) === detail, "CONFLICT", "Terminal receipt differs from this retry");
        return task;
      }
      ensure(task.state === "claimed" || task.state === "running", "STATE", "Task is not active");
      this.db.run("UPDATE tasks SET state = ?, result = ?, error = ?, version = version + 1, updatedAt = ? WHERE id = ?", outcome, outcome === "completed" ? detail : null, outcome === "failed" ? detail : null, Date.now(), taskID);
      this.retire(task);
      this.receipt(task.teamID, actor, taskID, `task.${outcome}`, claimID, detail);
      return this.task(actor, teamName, taskID);
    });
  }

  private notDispatched(task: Task): void {
    ensure(!this.db.get("SELECT 1 FROM operations WHERE taskID = ? AND claimID = ? AND kind = 'dispatch'", task.id, task.claimID), "NEEDS_STOP", "Native dispatch must be stopped through the coordinator before releasing its claim");
  }

  release(actor: Actor, teamName: string, taskID: string, claimID: string): Task {
    return this.db.transaction(() => this.releaseLocal(actor, teamName, taskID, claimID));
  }

  private releaseLocal(actor: Actor, teamName: string, taskID: string, claimID: string): Task {
    const task = this.owned(actor, teamName, taskID, claimID);
    ensure(task.state === "claimed" || task.state === "running", "STATE", "Task is not active");
    this.notDispatched(task);
    this.retire(task);
    this.db.run("UPDATE tasks SET state = 'pending', ownerSessionID = NULL, claimID = NULL, progress = NULL, version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), taskID);
    this.receipt(task.teamID, actor, taskID, "task.released", claimID, "Claim released");
    return this.task(actor, teamName, taskID);
  }

  cancel(actor: Actor, teamName: string, taskID: string): Task {
    return this.db.transaction(() => this.cancelLocal(actor, teamName, taskID));
  }

  private cancelLocal(actor: Actor, teamName: string, taskID: string): Task {
    const team = this.team(actor, teamName, true);
    const task = this.view(this.row(team.id, taskID));
    if (task.state === "cancelled") return task;
    ensure(["pending", "claimed", "running"].includes(task.state), "STATE", "Only pending or active tasks can be cancelled");
    this.notDispatched(task);
    this.retire(task);
    this.db.run("UPDATE tasks SET state = 'cancelled', version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), taskID);
    this.receipt(task.teamID, actor, taskID, "task.cancelled", task.claimID, "Cancelled by leader");
    return this.task(actor, teamName, taskID);
  }

  retry(actor: Actor, teamName: string, taskID: string): Task {
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      const task = this.view(this.row(team.id, taskID));
      ensure(task.state === "failed" || task.state === "cancelled", "STATE", "Only failed or cancelled tasks can be retried");
      ensure(!this.db.get("SELECT 1 FROM operations WHERE taskID = ? AND state = 'pending'", taskID), "CONFLICT", "Reconcile pending native operations before retrying");
      this.db.run("UPDATE tasks SET state = 'pending', ownerSessionID = NULL, claimID = NULL, progress = NULL, result = NULL, error = NULL, version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), taskID);
      this.receipt(task.teamID, actor, taskID, "task.retried", task.claimID, "New attempt requested");
      return this.task(actor, teamName, taskID);
    });
  }

  private request(teamID: string, actor: Actor, requestID: string): Operation | undefined {
    text(requestID, "Request ID", 128);
    ensure(!this.db.get("SELECT 1 FROM local_stops WHERE teamID = ? AND actorSessionID = ? AND requestID = ?", teamID, actor.sessionID, requestID),
      "CONFLICT", "Request ID was used for a different operation");
    return this.db.get<Operation>("SELECT * FROM operations WHERE teamID = ? AND actorSessionID = ? AND requestID = ?", teamID, actor.sessionID, requestID)
      ?? this.db.get<Operation>("SELECT o.* FROM request_aliases a JOIN operations o ON o.id = a.operationID AND o.teamID = a.teamID WHERE a.teamID = ? AND a.actorSessionID = ? AND a.requestID = ?", teamID, actor.sessionID, requestID);
  }

  private bindRequest(actor: Actor, operation: Operation, requestID: string): Operation {
    // Coalescing must spend the additional ID too, so it cannot target a later task attempt.
    this.db.run("INSERT INTO request_aliases VALUES (?, ?, ?, ?)", operation.teamID, actor.sessionID, requestID, operation.id);
    return operation;
  }

  stop(actor: Actor, teamName: string, taskID: string, kind: "release" | "cancel", requestID: string, claimID?: string): { task: Task; operation: Operation | null } {
    ensure(kind === "release" || kind === "cancel", "INVALID", "Invalid stop operation");
    text(requestID, "Request ID", 128);
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, kind === "cancel");
      const local = this.db.get<{ taskID: string; kind: string; claimID: string | null }>(
        "SELECT taskID, kind, claimID FROM local_stops WHERE teamID = ? AND actorSessionID = ? AND requestID = ?", team.id, actor.sessionID, requestID);
      if (local) {
        ensure(local.taskID === taskID && local.kind === kind && local.claimID === (claimID ?? null), "CONFLICT", "Request ID was used for a different operation");
        return { task: this.task(actor, teamName, taskID), operation: null };
      }
      const previous = this.request(team.id, actor, requestID);
      if (previous) {
        ensure(previous.kind === kind && previous.taskID === taskID && (claimID === undefined || previous.claimID === claimID), "CONFLICT", "Request ID was used for a different operation");
        return { task: this.task(actor, teamName, taskID), operation: previous };
      }
      const task = this.task(actor, teamName, taskID);
      const member = this.workerBySession(task.ownerSessionID ?? "");
      if (member && ["claimed", "running", "stopping"].includes(task.state)) {
        const operation = this.stopOperation(actor, teamName, taskID, kind, requestID, claimID);
        return { task: this.task(actor, teamName, taskID), operation };
      }
      const result = kind === "cancel" ? this.cancelLocal(actor, teamName, taskID) : this.releaseLocal(actor, teamName, taskID, claimID ?? "");
      // Local stops have no native operation, but their request must stay spent across task retries.
      this.db.run("INSERT INTO local_stops VALUES (?, ?, ?, ?, ?, ?)", team.id, actor.sessionID, requestID, taskID, kind, claimID ?? null);
      return { task: result, operation: null };
    });
  }

  private enqueue(actor: Actor, task: Task, member: Member, kind: Operation["kind"], requestID: string, payload: string): Operation {
    ensure(task.claimID, "STATE", "A native operation requires a claim");
    const operation: Operation = {
      id: id("op"), teamID: task.teamID, taskID: task.id, actorSessionID: actor.sessionID,
      memberID: member.id, claimID: task.claimID, requestID, kind, state: "pending", messageID: id("msg"),
      payload, lastError: null, createdAt: Date.now(), completedAt: null,
    };
    this.db.run("INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      operation.id, operation.teamID, operation.taskID, operation.actorSessionID, operation.memberID,
      operation.claimID, operation.requestID, operation.kind, operation.state, operation.messageID,
      operation.payload, operation.lastError, operation.createdAt, operation.completedAt);
    this.receipt(task.teamID, actor, task.id, `operation.${kind}.prepared`, task.claimID, operation.id);
    return operation;
  }

  dispatch(actor: Actor, teamName: string, taskID: string, memberName: string, requestID: string): Operation {
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      const member = this.member(actor, teamName, memberName);
      ensure(member.role === "worker", "FORBIDDEN", "Dispatch targets must be plugin-created worker sessions");
      const previous = this.request(team.id, actor, requestID);
      if (previous) {
        ensure(previous.kind === "dispatch" && previous.taskID === taskID && previous.memberID === member.id, "CONFLICT", "Request ID was used for a different operation");
        return previous;
      }
      const task = this.claimFor(actor, team, taskID, member);
      const existing = this.db.get<Operation>("SELECT * FROM operations WHERE taskID = ? AND claimID = ? AND kind = 'dispatch'", taskID, task.claimID);
      if (existing) return this.bindRequest(actor, existing, requestID);
      return this.enqueue(actor, task, member, "dispatch", requestID, JSON.stringify({
        team: teamName, taskID, claimID: task.claimID, title: task.title, description: task.description,
      }));
    });
  }

  followup(actor: Actor, teamName: string, taskID: string, requestID: string, message: string): Operation {
    text(message, "Follow-up", 8_000);
    return this.db.transaction(() => {
      const team = this.team(actor, teamName, true);
      const previous = this.request(team.id, actor, requestID);
      if (previous) {
        ensure(previous.kind === "followup" && previous.taskID === taskID && previous.payload === message, "CONFLICT", "Request ID was used for a different operation");
        return previous;
      }
      const task = this.task(actor, teamName, taskID);
      ensure(task.state === "running" || task.state === "claimed", "STATE", "Only active assignments accept follow-ups");
      const member = this.workerBySession(task.ownerSessionID ?? "");
      ensure(member && member.teamID === team.id && member.state === "assigned", "FORBIDDEN", "Follow-ups target this team's assigned worker only");
      return this.enqueue(actor, task, member, "followup", requestID, message);
    });
  }

  operation(actor: Actor, teamName: string, operationID: string): Operation {
    const team = this.team(actor, teamName);
    const operation = this.db.get<Operation>("SELECT * FROM operations WHERE id = ? AND teamID = ?", operationID, team.id);
    ensure(operation, "NOT_FOUND", "Operation not found in this team");
    return operation;
  }

  pending(actor: Actor, teamName: string): Operation[] {
    const team = this.team(actor, teamName);
    return this.db.all<Operation>("SELECT * FROM operations WHERE teamID = ? AND state = 'pending' ORDER BY createdAt, id LIMIT 100", team.id);
  }

  private operationAuthority(actor: Actor, teamName: string, operationID: string): Operation {
    const team = this.team(actor, teamName);
    const operation = this.operation(actor, teamName, operationID);
    ensure(actor.sessionID === team.leaderSessionID || actor.sessionID === operation.actorSessionID, "FORBIDDEN", "Only the leader or operation originator may reconcile this operation");
    return operation;
  }

  operationError(actor: Actor, teamName: string, operationID: string, message: string): void {
    this.db.transaction(() => {
      const operation = this.operationAuthority(actor, teamName, operationID);
      if (operation.state === "pending") this.db.run("UPDATE operations SET lastError = ? WHERE id = ?", text(message, "Operation error", 1_000), operationID);
    });
  }

  delivered(actor: Actor, teamName: string, operationID: string): Operation {
    return this.db.transaction(() => {
      const operation = this.operationAuthority(actor, teamName, operationID);
      ensure(operation.kind === "dispatch" || operation.kind === "followup", "STATE", "Stop operations need a stop receipt");
      if (operation.state === "done") return operation;
      const task = this.task(actor, teamName, operation.taskID);
      ensure(task.claimID === operation.claimID, "STALE_CLAIM", "Operation belongs to a previous task attempt");
      ensure(task.state !== "stopping" && task.state !== "cancelled" && task.state !== "pending", "STATE", "Task admission was superseded");
      this.db.run("UPDATE operations SET state = 'done', lastError = NULL, completedAt = ? WHERE id = ?", Date.now(), operationID);
      if (task.state === "claimed") this.db.run("UPDATE tasks SET state = 'running', version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), task.id);
      this.receipt(task.teamID, actor, task.id, "operation.delivered", operation.claimID, operation.id);
      return this.operation(actor, teamName, operationID);
    });
  }

  supersede(actor: Actor, teamName: string, operationID: string): Operation {
    return this.db.transaction(() => {
      const operation = this.operationAuthority(actor, teamName, operationID);
      ensure(operation.kind === "dispatch" || operation.kind === "followup", "STATE", "A pending stop cannot be discarded");
      const task = this.task(actor, teamName, operation.taskID);
      ensure(task.claimID !== operation.claimID || ["completed", "failed", "cancelled", "stopping"].includes(task.state), "STATE", "Active deliveries cannot be discarded");
      if (operation.state === "pending") {
        this.db.run("UPDATE operations SET state = 'done', lastError = 'Superseded by task state', completedAt = ? WHERE id = ?", Date.now(), operationID);
        this.receipt(task.teamID, actor, task.id, "operation.superseded", operation.claimID, operation.id);
      }
      return this.operation(actor, teamName, operationID);
    });
  }

  beginStop(actor: Actor, teamName: string, taskID: string, kind: "release" | "cancel", requestID: string, claimID?: string): Operation {
    ensure(kind === "release" || kind === "cancel", "INVALID", "Invalid stop operation");
    return this.db.transaction(() => this.stopOperation(actor, teamName, taskID, kind, requestID, claimID));
  }

  private stopOperation(actor: Actor, teamName: string, taskID: string, kind: "release" | "cancel", requestID: string, claimID?: string): Operation {
      const team = this.team(actor, teamName, kind === "cancel");
      const previous = this.request(team.id, actor, requestID);
      if (previous) {
        ensure(previous.kind === kind && previous.taskID === taskID && (claimID === undefined || previous.claimID === claimID), "CONFLICT", "Request ID was used for a different operation");
        return previous;
      }
      const task = this.task(actor, teamName, taskID);
      ensure(actor.sessionID === team.leaderSessionID || actor.sessionID === task.ownerSessionID, "FORBIDDEN", "Only the leader or claim owner may stop an assignment");
      if (kind === "release" || claimID !== undefined) ensure(task.claimID === claimID, "STALE_CLAIM", "Claim token is stale");
      if (task.state === "stopping") {
        const existing = this.db.get<Operation>("SELECT * FROM operations WHERE taskID = ? AND claimID = ? AND kind IN ('release','cancel') AND state = 'pending'", taskID, task.claimID);
        ensure(existing && existing.kind === kind, "CONFLICT", "A different stop is already in progress");
        return this.bindRequest(actor, existing, requestID);
      }
      ensure(task.state === "claimed" || task.state === "running", "STATE", "Task is not active");
      const member = this.workerBySession(task.ownerSessionID ?? "");
      ensure(member && member.teamID === team.id, "STATE", "Only a plugin-created worker has a native session to stop");
      const operation = this.enqueue(actor, task, member, kind, requestID, "");
      this.db.run("UPDATE tasks SET state = 'stopping', version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), taskID);
      return operation;
  }

  stopped(actor: Actor, teamName: string, operationID: string): Task {
    return this.db.transaction(() => {
      const operation = this.operationAuthority(actor, teamName, operationID);
      ensure(operation.kind === "release" || operation.kind === "cancel", "STATE", "Not a stop operation");
      const task = this.task(actor, teamName, operation.taskID);
      if (operation.state === "done") return task;
      ensure(task.claimID === operation.claimID && task.state === "stopping", "STALE_CLAIM", "Stop belongs to a different task attempt");
      this.retire(task);
      this.db.run("UPDATE operations SET state = 'done', lastError = 'Superseded by native stop', completedAt = ? WHERE taskID = ? AND claimID = ? AND kind IN ('dispatch','followup') AND state = 'pending'", Date.now(), task.id, task.claimID);
      this.db.run("UPDATE operations SET state = 'done', lastError = NULL, completedAt = ? WHERE id = ?", Date.now(), operationID);
      if (operation.kind === "release") {
        this.db.run("UPDATE tasks SET state = 'pending', ownerSessionID = NULL, claimID = NULL, progress = NULL, version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), task.id);
      } else this.db.run("UPDATE tasks SET state = 'cancelled', version = version + 1, updatedAt = ? WHERE id = ?", Date.now(), task.id);
      this.receipt(task.teamID, actor, task.id, `task.${operation.kind === "release" ? "released" : "cancelled"}`, operation.claimID, "Native worker stopped; task receipt retained");
      return this.task(actor, teamName, task.id);
    });
  }

  private receipt(teamID: string, actor: Actor, taskID: string | null, kind: string, claimID: string | null, detail: string): void {
    this.db.run("INSERT INTO receipts (teamID, taskID, actorSessionID, kind, claimID, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)", teamID, taskID, actor.sessionID, kind, claimID, detail, Date.now());
  }

  receipts(actor: Actor, teamName: string, after = 0): Receipt[] {
    const team = this.team(actor, teamName);
    ensure(Number.isSafeInteger(after) && after >= 0, "INVALID", "Receipt cursor must be a nonnegative integer");
    return this.db.all<Receipt>("SELECT * FROM receipts WHERE teamID = ? AND sequence > ? ORDER BY sequence LIMIT 100", team.id, after);
  }
}
