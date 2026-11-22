import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { SessionInfo, SessionCreateInput, SessionPromptInput, SessionSyntheticInput, OpenCodeEvent, JsonValue } from "@opencode/client";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Agent } from "@opencode/schema/agent";
import { Tool } from "@opencode/schema/tool";
import { Location } from "@opencode/schema/location";
import { InstructionEntry } from "@opencode/schema/instruction-entry";
import { Schema } from "effect";
import { leader } from "./helpers.js";

export function sessionInfo(directory: string, id = leader.sessionID): SessionInfo {
  return {
    id, projectID: leader.projectID, agent: "build", title: "Synthetic session",
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, location: { directory: resolve(directory) },
    permissions: [{ action: "edit", resource: "**/protected/**", effect: "deny" }],
  };
}

export function toolContext(sessionID = leader.sessionID): ToolContext {
  return {
    sessionID: Session.ID.make(sessionID), agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_synthetic"), id: Tool.CallID.make("call_synthetic"),
    signal: new AbortController().signal, progress: async () => {},
  };
}

export function syntheticHost(directory: string) {
  const tools = new Map<string, Info>();
  const commands = new Map<string, CommandDefinition>();
  const namespaces: string[] = [];
  const sessions = new Map<string, SessionInfo>([[leader.sessionID, sessionInfo(directory)]]);
  const instructions = new Map<string, Map<string, JsonValue>>();
  const admissions = new Map<string, SessionPromptInput | SessionSyntheticInput>();
  const creates: SessionCreateInput[] = [];
  const permissions: Parameters<Plugin.Context["permission"]["assert"]>[0][] = [];
  const interrupted: string[] = [];
  const waited: string[] = [];
  const hooks = new Map<string, (...args: any[]) => any>();
  const events: { event: OpenCodeEvent; done: () => void }[] = [];
  let wake: (() => void) | undefined;
  let deny: string | undefined;
  let loseAdmissionReply = false;
  let loseCreateReply = false;
  let beforeAdmission: (() => Promise<void>) | undefined;
  let beforePermission: (() => Promise<void>) | undefined;
  let beforeWait: (() => Promise<void>) | undefined;
  let disposed = 0;
  const registration = { dispose: async () => { disposed++; } };
  const missing = (sessionID: string) => ({ _tag: "SessionNotFoundError", sessionID, message: "Synthetic session not found" });
  const get = async ({ sessionID }: { sessionID: string }): Promise<SessionInfo> => {
    const info = sessions.get(sessionID);
    if (!info) throw missing(sessionID);
    return structuredClone(info);
  };
  const admit = async <T extends SessionPromptInput | SessionSyntheticInput>(input: T) => {
    assert.ok(input.id, "native admission must have a durable message ID");
    await get(input);
    if (beforeAdmission) await beforeAdmission();
    if (!admissions.has(input.id)) admissions.set(input.id, structuredClone(input));
    if (loseAdmissionReply) { loseAdmissionReply = false; throw new Error("Synthetic lost admission acknowledgement"); }
    return { id: input.id, sessionID: input.sessionID, time: { created: 2 }, delivery: input.delivery ?? "steer" };
  };
  const native = {
    get,
    create: async (input: SessionCreateInput = {}) => {
      assert.ok(input.id && input.parentID, "only named native children may be created");
      assert.ok(!("permissions" in input), "native permission inheritance must not be overridden");
      assert.ok(!("model" in input), "provider/model selection must be inherited");
      creates.push(structuredClone(input));
      if (sessions.has(input.id)) throw new Error("Synthetic duplicate session ID");
      const parent = await get({ sessionID: input.parentID });
      const child: SessionInfo = {
        ...sessionInfo(input.location?.directory ?? parent.location.directory, input.id),
        parentID: input.parentID, projectID: parent.projectID,
        agent: input.agent ?? parent.agent ?? "build", metadata: input.metadata ?? {},
        permissions: structuredClone(parent.permissions ?? []),
      };
      sessions.set(input.id, child);
      if (loseCreateReply) { loseCreateReply = false; throw new Error("Synthetic lost create acknowledgement"); }
      return structuredClone(child);
    },
    prompt: async (input: SessionPromptInput) => {
      assert.ok(!input.files?.length && !input.agents?.length && !input.skills?.length, "the synthetic host supports text-only admissions; attachment resolution belongs to OpenCode");
      return {
        ...await admit(input), type: "user" as const,
        payload: { text: input.text, ...(input.metadata ? { metadata: input.metadata } : {}) },
      };
    },
    synthetic: async (input: SessionSyntheticInput) => ({
      ...await admit(input), type: "synthetic" as const,
      payload: { text: input.text, ...(input.description ? { description: input.description } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) },
    }),
    interrupt: async ({ sessionID }: { sessionID: string }) => {
      const info = await get({ sessionID });
      interrupted.push(sessionID);
      sessions.set(sessionID, { ...info, outcome: "interrupted", time: { ...info.time, idle: Date.now() } });
      return { interrupted: true };
    },
    wait: async ({ sessionID }: { sessionID: string }) => { await get({ sessionID }); waited.push(sessionID); await beforeWait?.(); },
    instructions: { entry: {
      put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
        const entry = Schema.decodeUnknownSync(InstructionEntry.Info)({ key, value });
        const actualBytes = Buffer.byteLength(JSON.stringify(entry.value));
        if (actualBytes > InstructionEntry.MaxValueBytes) throw new InstructionEntry.ValueTooLargeError({
          actualBytes, maxBytes: InstructionEntry.MaxValueBytes, message: "Instruction entry exceeds the published byte limit",
        });
        await get({ sessionID });
        if (!instructions.has(sessionID)) instructions.set(sessionID, new Map());
        instructions.get(sessionID)!.set(entry.key, JSON.parse(JSON.stringify(entry.value)) as JsonValue);
      },
      list: async ({ sessionID }: { sessionID: string }) => {
        await get({ sessionID });
        return [...instructions.get(sessionID) ?? []].map(([key, value]) => ({ key, value: structuredClone(value) }));
      },
      remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
        const parsed = Schema.decodeUnknownSync(InstructionEntry.Key)(key);
        await get({ sessionID });
        instructions.get(sessionID)?.delete(parsed);
      },
    } },
  } satisfies Pick<Plugin.Context["session"], "get" | "create" | "prompt" | "synthetic" | "interrupt" | "wait" | "instructions">;
  const parts = {
    options: { database: resolve(directory, "plugin.sqlite") },
    location: Location.Info.make({ directory: resolve(directory), project: { id: leader.projectID, directory: resolve(directory), canonical: resolve(directory) } } as unknown as Location.Info),
    session: new Proxy({ ...native, hook: async (name: string, callback: (...args: any[]) => any) => { hooks.set(`session.${name}`, callback); return registration; } }, {
      get(target, key) { if (!(key in target)) throw new Error(`Unexpected session API: ${String(key)}`); return Reflect.get(target, key); },
    }),
    permission: { assert: async (input: Parameters<Plugin.Context["permission"]["assert"]>[0]) => {
      permissions.push(structuredClone(input));
      if (input.action === deny) throw new Error("Synthetic permission denial");
      await beforePermission?.();
    } },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ namespace: ({ name }: { name: string }) => namespaces.push(name), add: (tool: Info) => tools.set(tool.name, tool) });
        return registration;
      },
      hook: async (name: string, callback: (...args: any[]) => any) => { hooks.set(`tool.${name}`, callback); return registration; },
    },
    command: { transform: async (callback: (editor: any) => void) => {
      callback({ add: (definition: CommandDefinition) => commands.set(definition.name, definition) });
      return registration;
    } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        const abort = () => wake?.();
        signal.addEventListener("abort", abort, { once: true });
        try {
          while (!signal.aborted) {
            const next = events.shift();
            if (next) { yield next.event; next.done(); }
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally { signal.removeEventListener("abort", abort); }
      },
    }) },
  };
  const context = new Proxy(parts, {
    get(target, key) { if (!(key in target)) throw new Error(`Unexpected plugin API: ${String(key)}`); return Reflect.get(target, key); },
  }) as unknown as Plugin.Context;
  return {
    context, tools, commands, namespaces, sessions, instructions, admissions, creates, permissions, interrupted, waited, hooks,
    get disposed() { return disposed; },
    deny(action: string | undefined) { deny = action; },
    loseAdmissionReply() { loseAdmissionReply = true; },
    loseCreateReply() { loseCreateReply = true; },
    beforeAdmission(callback: (() => Promise<void>) | undefined) { beforeAdmission = callback; },
    beforePermission(callback: (() => Promise<void>) | undefined) { beforePermission = callback; },
    beforeWait(callback: (() => Promise<void>) | undefined) { beforeWait = callback; },
    event(event: OpenCodeEvent) { return new Promise<void>((done) => { events.push({ event, done }); wake?.(); }); },
    async call(name: string, input: unknown, sessionID = leader.sessionID) {
      const tool = tools.get(name);
      assert.ok(tool, `plugin must register ${name}`);
      const result = await tool.execute(input, toolContext(sessionID));
      assert.equal(typeof result.content, "string");
      return JSON.parse(result.content as string) as any;
    },
  };
}
