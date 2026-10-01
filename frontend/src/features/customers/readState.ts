/**
 * Read marks for customer updates. The backend stores `is_read` but has no endpoint to change it,
 * so marks made here are kept on this device (localStorage) and merged with the server value.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { CustomerUpdate } from "@/api/types";

const KEY = "ess.customer-updates.read";
const listeners = new Set<() => void>();
let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function save(next: Set<string>) {
  cache = next;
  try {
    // keep the newest 2000 marks
    window.localStorage.setItem(KEY, JSON.stringify([...next].slice(-2000)));
  } catch {
    /* storage full or blocked: marks last for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useReadMarks() {
  const marks = useSyncExternalStore(subscribe, load, load);
  const isRead = useCallback((u: Pick<CustomerUpdate, "id" | "is_read">) => u.is_read || marks.has(u.id), [marks]);
  const markRead = useCallback((ids: string[]) => {
    const next = new Set(load());
    ids.forEach((id) => next.add(id));
    save(next);
  }, []);
  const markUnread = useCallback((id: string) => {
    const next = new Set(load());
    next.delete(id);
    save(next);
  }, []);
  return { isRead, markRead, markUnread };
}
