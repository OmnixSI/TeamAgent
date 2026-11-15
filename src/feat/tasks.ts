// Placeholder until this feature is written. The exported signatures are the contract other features code against.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";

export type TaskStatus = "open" | "doing" | "done" | "dropped";
export type Task = {
  id: number; conv: string; title: string; detail: string; status: TaskStatus;
  owner: string;        // who is meant to do it (a group member's name, "bot", or "")
  due: string;          // "2026-11-20" or ""
  source: string;       // where it came from: a short quote from the chat, or "看板" / "本地 AI"
  by: string;           // who created it
  claimed_by: string;   // who (person or local AI) picked it up, or ""
  result: string;       // what was delivered when done: text, links, file references
  created: number; updated: number;
};
export type TaskNote = { ts: number; who: string; text: string };

export function listTasks(hub: Hub, conv: string, f: { status?: TaskStatus[]; owner?: string; limit?: number } = {}): Task[] { return []; }
export function getTask(hub: Hub, conv: string, id: number): Task | null { return null; }
export function addTask(hub: Hub, conv: string, t: { title: string; detail?: string; owner?: string; due?: string; source?: string; by?: string }): Task | null { return null; }
/** Changes fields of a task; `who` is recorded in the task's notes. Returns the task, or null when it does not exist. */
export function updateTask(hub: Hub, conv: string, id: number, patch: Partial<Pick<Task, "title" | "detail" | "status" | "owner" | "due" | "result">>, who = ""): Task | null { return null; }
/** Marks a task as picked up by `who` and in progress; null when it does not exist, is finished, or is already claimed by someone else. */
export function claimTask(hub: Hub, conv: string, id: number, who: string): Task | null { return null; }
export function addTaskNote(hub: Hub, conv: string, id: number, who: string, text: string): boolean { return false; }
export function taskNotes(hub: Hub, conv: string, id: number): TaskNote[] { return []; }

const feature: Feature = { name: "tasks" };
export default feature;
