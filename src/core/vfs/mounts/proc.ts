/**
 * Proc mount — live daemon state as a synthetic read-only tree, in the
 * /proc tradition:
 *
 *   proc/
 *     tasks/<id>   one task table record, pretty JSON
 *     events       the event bus ring, JSON Lines (newest last)
 *     <view>       any extra text views the index wires (log, errors,
 *                  alerts — see ./diagnostics.ts)
 *
 * Providers are injected so the mount is a pure projection — the index
 * wires the real task table and bus, tests wire fixtures. Sizes and
 * timestamps are computed from the rendered content on demand; this is a
 * view of live state, nothing is cached.
 */

import type { PublishedEvent } from "../../bus/index.js";
import type { TaskRecord } from "../../tasks/index.js";
import type { VfsMount, VfsResult, VfsStat } from "../types.js";
import { vfsError, vfsOk } from "../types.js";

export interface ProcMountDeps {
  tasks: () => readonly TaskRecord[];
  events: () => readonly PublishedEvent[];
  /** Extra read-only text files at the proc root, name → renderer. */
  views?: Readonly<Record<string, () => string>>;
}

const DIR = (path: string, name: string): VfsStat => ({
  path,
  name,
  kind: "dir",
  writable: false,
});

function fileStat(path: string, content: string, modifiedAt?: number): VfsStat {
  return {
    path,
    name: path.split("/").at(-1)!,
    kind: "file",
    size: Buffer.byteLength(content, "utf-8"),
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    writable: false,
  };
}

function renderTask(task: TaskRecord): string {
  return `${JSON.stringify(task, null, 2)}\n`;
}

function taskModifiedAt(task: TaskRecord): number {
  return task.endedAt ?? task.startedAt ?? task.queuedAt;
}

function renderEvents(events: readonly PublishedEvent[]): string {
  if (events.length === 0) return "";
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function createProcMount(deps: ProcMountDeps): VfsMount {
  const views: Readonly<Record<string, () => string>> = Object.assign(
    Object.create(null) as Record<string, () => string>,
    deps.views,
  );
  const viewStats = (): VfsStat[] =>
    Object.keys(views).map((name) => fileStat(name, views[name]()));

  function taskById(id: string): TaskRecord | undefined {
    if (!/^\d+$/.test(id)) return undefined;
    return deps.tasks().find((task) => task.id === Number(id));
  }

  function resolveNode(rel: string): VfsResult<VfsStat> {
    if (rel === "") return vfsOk(DIR("", ""));
    if (rel === "tasks") return vfsOk(DIR("tasks", "tasks"));
    if (rel === "events") {
      const events = deps.events();
      return vfsOk(fileStat("events", renderEvents(events), events.at(-1)?.at));
    }
    if (views[rel]) return vfsOk(fileStat(rel, views[rel]()));
    const taskId = rel.startsWith("tasks/") ? rel.slice("tasks/".length) : null;
    if (taskId !== null && !taskId.includes("/")) {
      const task = taskById(taskId);
      if (!task) return vfsError("not-found");
      return vfsOk(
        fileStat(`tasks/${task.id}`, renderTask(task), taskModifiedAt(task)),
      );
    }
    return vfsError("not-found");
  }

  return {
    description: deps.views
      ? "Live daemon state: task table, event bus ring, daemon log views"
      : "Live daemon state: task table and event bus ring",
    writable: false,

    stat: resolveNode,

    list(rel) {
      if (rel === "") {
        const events = deps.events();
        return vfsOk([
          DIR("tasks", "tasks"),
          fileStat("events", renderEvents(events), events.at(-1)?.at),
          ...viewStats(),
        ]);
      }
      if (rel === "tasks") {
        return vfsOk(
          deps
            .tasks()
            .map((task) =>
              fileStat(
                `tasks/${task.id}`,
                renderTask(task),
                taskModifiedAt(task),
              ),
            )
            .sort((a, b) => Number(a.name) - Number(b.name)),
        );
      }
      const node = resolveNode(rel);
      if (!node.ok) return node;
      return vfsError("not-a-directory");
    },

    read(rel) {
      if (rel === "events") return vfsOk(renderEvents(deps.events()));
      if (views[rel]) return vfsOk(views[rel]());
      if (rel.startsWith("tasks/")) {
        const task = taskById(rel.slice("tasks/".length));
        if (!task) return vfsError("not-found");
        return vfsOk(renderTask(task));
      }
      const node = resolveNode(rel);
      if (!node.ok) return node;
      return vfsError("is-a-directory");
    },
  };
}
