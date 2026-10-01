import { Check, Ellipsis, Pencil, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import { useCategoryLabel } from "@/api/session";
import type { KnowledgeItem } from "@/api/types";
import { formatDate } from "@/lib/format";
import { knowledgeStatusInfo } from "@/lib/labels";
import { Button, Chip, Confidence, IconButton, Menu, StatusChip, Switch, toast, toastError } from "@/ui";
import { useUpdateKnowledge, type KnowledgePatch } from "../api";
import { claimInfo, formatValue, languageLabel, mappedCategory, originalOf, regionLabel, SORTING_KINDS, synonymsOf } from "../model";
import { EvidenceDetails, EvidenceSummary } from "./SourceEvidence";

/**
 * One business finding with everything needed to decide on it: its wording (and the original wording after an
 * edit), what it rests on, the exact source sentence under it, and the owner's choices. Confirming a finding and
 * using it to sort mail are two separate switches.
 */
export function FindingCard({
  item,
  canEdit,
  onEdit,
  onDelete,
  showSorting = true,
}: {
  item: KnowledgeItem;
  canEdit: boolean;
  onEdit?: (item: KnowledgeItem) => void;
  onDelete?: (item: KnowledgeItem) => void;
  /** The wizard leaves sorting for later; Settings offers it. */
  showSorting?: boolean;
}) {
  const update = useUpdateKnowledge();
  const categoryLabel = useCategoryLabel();
  const [allSources, setAllSources] = useState(false);

  const claim = claimInfo(item.claim_basis);
  const original = originalOf(item);
  const confirmed = item.status === "owner_confirmed";
  const rejected = item.status === "rejected";
  const suggested = item.status === "suggested";
  const sorts = showSorting && SORTING_KINDS.has(item.kind);
  const aliases = synonymsOf(item);
  const detail = item.kind === "standard" || item.kind === "convention" ? formatValue(item.value) : null;
  const sources = item.evidence?.length ?? 0;
  const renamed = original && (original.label !== item.label || (original.label_ar ?? "") !== (item.label_ar ?? ""));
  const pendingStatus = update.isPending ? (update.variables?.patch.status ?? null) : null;

  const decide = (patch: KnowledgePatch, done: string) =>
    update.mutate(
      { id: item.id, patch },
      { onSuccess: () => toast.success(done), onError: (err) => toastError(err, "That could not be saved") },
    );

  const menu = [
    ...(onEdit ? [{ label: "Edit wording", icon: <Pencil />, disabled: !canEdit, onSelect: () => onEdit(item) }] : []),
    ...(!suggested ? [{ label: "Move back to review", icon: <Undo2 />, disabled: !canEdit, onSelect: () => decide({ status: "suggested" }, `Back in review: ${item.label}`) }] : []),
    ...(onDelete ? [{ label: "Delete finding", icon: <Trash2 />, danger: true, disabled: !canEdit, separatorBefore: true, onSelect: () => onDelete(item) }] : []),
  ];

  return (
    <li className="px-5 py-4">
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_15rem]">
        {/* the finding and its proof */}
        <div className="min-w-0 space-y-2.5">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className={rejected ? "break-words text-base font-semibold text-ink-2" : "break-words text-base font-semibold text-ink"} dir="auto">
                {item.label}
              </h3>
              {item.label_ar ? (
                <span dir="rtl" lang="ar" className="text-base text-ink-2">
                  {item.label_ar}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {item.region ? (
                <Chip size="sm" tone="neutral">
                  {regionLabel(item.region)}
                </Chip>
              ) : null}
              {item.language ? (
                <Chip size="sm" tone="neutral">
                  {languageLabel(item.language)}
                </Chip>
              ) : null}
            </div>
            {item.description ? <p className="mt-1.5 text-sm text-ink-2">{item.description}</p> : null}
            {detail ? <p className="mt-1 text-sm text-ink-2">{detail}</p> : null}
            {aliases.length ? (
              <p className="mt-1 text-sm text-ink-3">
                Also called{" "}
                {aliases.map((a, i) => (
                  <span key={a}>
                    {i > 0 ? " · " : ""}
                    <span dir="auto" className="text-ink-2">
                      {a}
                    </span>
                  </span>
                ))}
              </p>
            ) : null}
            {renamed && original ? (
              <p className="mt-1 text-sm text-ink-3">
                Found as <span dir="auto" className="font-medium text-ink-2">“{original.label}”</span>
                {original.edited_by ? ` · renamed by ${original.edited_by}` : ""}
                {original.edited_at ? ` on ${formatDate(original.edited_at)}` : ""}
              </p>
            ) : null}
          </div>

          <EvidenceDetails evidence={item.evidence} limit={allSources ? undefined : 1} />
          {sources > 1 ? (
            <Button variant="link" size="sm" onClick={() => setAllSources((v) => !v)} aria-expanded={allSources}>
              {allSources ? "Show fewer sources" : `Show all ${sources} sources`}
            </Button>
          ) : null}
        </div>

        {/* the decision */}
        <div className="space-y-3 border-t border-line pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusChip info={knowledgeStatusInfo(item.status)} />
            <Confidence value={item.confidence} />
          </div>
          <div className="space-y-1.5 text-sm">
            <p className="text-ink-3">
              Basis{" "}
              {claim ? (
                <Chip size="sm" tone={claim.tone} className="ml-1" title={claim.hint || undefined}>
                  {claim.label}
                </Chip>
              ) : (
                <span className="ml-1 text-ink-3">not stated</span>
              )}
            </p>
            {claim?.hint ? <p className="text-ink-3">{claim.hint}</p> : null}
            <EvidenceSummary evidence={item.evidence} />
          </div>

          {sorts ? (
            <Switch
              label="Use for mail sorting"
              description={
                rejected
                  ? "Rejected findings are not used. Restore it for review first."
                  : !confirmed
                    ? "Confirm first. Confirming alone does not change how mail is sorted."
                    : item.apply_to_classification
                      ? `Mail that uses this wording is sorted into ${categoryLabel(mappedCategory(item) ?? item.key)}.`
                      : "Off: mail is not sorted by this wording."
              }
              checked={item.apply_to_classification}
              disabled={!canEdit || !confirmed || update.isPending}
              onChange={(on) =>
                decide({ apply_to_classification: on }, on ? `Mail is now sorted by “${item.label}”` : `“${item.label}” no longer sorts mail`)
              }
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {suggested ? (
              <>
                <Button
                  size="sm"
                  icon={<Check />}
                  loading={pendingStatus === "owner_confirmed"}
                  disabled={!canEdit || update.isPending}
                  onClick={() => decide({ status: "owner_confirmed" }, `Confirmed: ${item.label}`)}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<X />}
                  loading={pendingStatus === "rejected"}
                  disabled={!canEdit || update.isPending}
                  onClick={() => decide({ status: "rejected" }, `Rejected: ${item.label}`)}
                >
                  Reject
                </Button>
              </>
            ) : rejected ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw />}
                disabled={!canEdit || update.isPending}
                onClick={() => decide({ status: "suggested" }, `Back in review: ${item.label}`)}
              >
                Restore for review
              </Button>
            ) : null}
            {menu.length ? (
              <Menu
                trigger={
                  <IconButton label={`More actions for ${item.label}`} variant="secondary" size="sm">
                    <Ellipsis />
                  </IconButton>
                }
                items={menu}
              />
            ) : null}
          </div>
          {!canEdit ? <p className="text-sm text-ink-3">Only an owner or admin can decide on findings.</p> : null}
        </div>
      </div>
    </li>
  );
}
