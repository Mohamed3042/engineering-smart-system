/**
 * Small React hooks shared by the project screens.
 */
import { useEffect, useState } from "react";

/** True while the viewport matches the media query (false where matchMedia does not exist). */
export function useMediaQuery(query: string): boolean {
  const read = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** True below the width where the two-column project layouts collapse into one column. */
export function useStacked(): boolean {
  return !useMediaQuery("(min-width: 1024px)");
}

/** Milliseconds since `since`, read again every second. Null when nothing is being waited for. */
export function useElapsed(since: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - since) : null;
}

/** "20 s", "2 min", "1 h 5 min". Seconds are rounded down to 5 so the text does not flicker. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(5, Math.floor(s / 5) * 5)} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** The value, but only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
