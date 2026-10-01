/**
 * The editor's working copy of a quotation. Holds the editable part of `quotation.data` plus the
 * builder choices (template, language, signatory), knows what changed against the saved copy and
 * builds the PUT body with only the changed keys (so a photo added meanwhile is never overwritten).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Addressee, Line, Quote, StampSettings, Term } from "../api";
import { lineTotal } from "../lib";

/** Keys the backend accepts in PUT /api/quotations/{id} (EDITABLE in quotations.py), minus photos. */
export const EDITABLE_KEYS = [
  "to",
  "project_name",
  "subject",
  "tender_no",
  "enquiry_ref",
  "intro",
  "items",
  "currency",
  "price_unit",
  "terms",
  "exclusions",
  "notes",
  "show_total",
  "stamp",
  "clarifications",
  "date",
  "paper_id",
] as const;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

export interface DraftLine extends Line {
  /** Client-only key for React lists; stripped before saving. */
  _k: string;
}

export interface DraftData {
  to?: Addressee;
  project_name?: string | null;
  subject?: string | null;
  tender_no?: string | null;
  enquiry_ref?: string | null;
  intro?: string | string[] | null;
  items: DraftLine[];
  currency?: string;
  price_unit?: string | null;
  terms?: Term[];
  exclusions?: string[];
  notes?: string | null;
  show_total?: boolean;
  stamp?: StampSettings;
  clarifications?: unknown[];
  date?: string | null;
  paper_id?: string | null;
}

export interface Draft {
  data: DraftData;
  template_key: string;
  language: string;
  signatory_id: string | null;
}

let seq = 0;
export const lineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function fromQuote(q: Quote): Draft {
  const src = q.data ?? {};
  const data: DraftData = { items: [] };
  for (const k of EDITABLE_KEYS) {
    if (k === "items") continue;
    if (k in src) (data as unknown as Record<string, unknown>)[k] = clone(src[k]);
  }
  data.items = (src.items ?? []).map((l) => ({ ...clone(l), _k: lineKey() }));
  return { data, template_key: q.template_key, language: q.language, signatory_id: q.signatory_id };
}

/** Sorted-key JSON so key order never counts as a change. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** Lines as saved: no client keys, sequential numbers, totals that match the prices. */
export function cleanLines(items: DraftLine[]): Line[] {
  return items.map(({ _k, ...line }, i) => {
    void _k;
    const numbered = line.no === undefined || line.no === null || line.no === "" || /^\d+$/.test(String(line.no));
    return { ...line, no: numbered ? i + 1 : line.no, total: lineTotal(line) };
  });
}

function valueOf(d: Draft, k: EditableKey): unknown {
  return k === "items" ? cleanLines(d.data.items) : (d.data as unknown as Record<string, unknown>)[k];
}

export function useDraft(q: Quote | undefined) {
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirtyRef = useRef(false);

  const changedKeys = useMemo(() => {
    if (!base || !draft) return [] as EditableKey[];
    return EDITABLE_KEYS.filter((k) => stable(valueOf(draft, k)) !== stable(valueOf(base, k)));
  }, [base, draft]);
  const choiceChanged = Boolean(
    base &&
      draft &&
      (base.template_key !== draft.template_key || base.language !== draft.language || base.signatory_id !== draft.signatory_id),
  );
  const dirty = changedKeys.length > 0 || choiceChanged;
  dirtyRef.current = dirty;

  // Take the server copy when it changes and nothing is being edited.
  const stamp = q ? `${q.id}:${q.updated_at}:${q.status}` : "";
  const latest = useRef(q);
  latest.current = q;
  useEffect(() => {
    const current = latest.current;
    if (!current || dirtyRef.current) return;
    const next = fromQuote(current);
    setBase(next);
    setDraft(next);
  }, [stamp]);

  const update = useCallback((fn: (d: DraftData) => DraftData) => {
    setDraft((d) => (d ? { ...d, data: fn(d.data) } : d));
  }, []);
  const setField = useCallback(<K extends keyof DraftData>(key: K, value: DraftData[K]) => {
    setDraft((d) => (d ? { ...d, data: { ...d.data, [key]: value } } : d));
  }, []);
  const setChoice = useCallback((patch: Partial<Pick<Draft, "template_key" | "language" | "signatory_id">>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);
  const discard = useCallback(() => setDraft(base), [base]);

  /** Replace both copies with what the server returned after a save. */
  const accept = useCallback((saved: Quote) => {
    const next = fromQuote(saved);
    dirtyRef.current = false;
    setBase(next);
    setDraft(next);
  }, []);

  const body = useCallback(() => {
    if (!draft || !base) return null;
    const data: Record<string, unknown> = {};
    for (const k of changedKeys) data[k] = valueOf(draft, k) ?? null;
    const out: Record<string, unknown> = { data };
    if (draft.template_key !== base.template_key) out.template_key = draft.template_key;
    if (draft.language !== base.language) out.language = draft.language;
    if (draft.signatory_id !== base.signatory_id && draft.signatory_id) out.signatory_id = draft.signatory_id;
    return out;
  }, [draft, base, changedKeys]);

  return { base, draft, dirty, changedKeys, choiceChanged, update, setField, setChoice, discard, accept, body };
}

export type DraftApi = ReturnType<typeof useDraft>;
