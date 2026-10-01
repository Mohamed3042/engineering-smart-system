/**
 * Show / hide mail (mockup 14). Group switches use PUT /api/visibility; category switches use
 * PATCH /api/categories/{key}. Changes save right away. Hidden mail stays in the mailbox.
 */
import { Eye } from "lucide-react";
import { useState } from "react";
import { pluralize } from "@/lib/format";
import { Button, Drawer, ErrorState, LoadingRows, Switch, toastError } from "@/ui";
import { useSetCategoryVisibility, useSetGroupVisibility, useVisibility, type InboxSummary } from "./api";
import { GROUP_HINT, GROUP_LABEL, MAIL_GROUPS } from "./labels";

export function VisibilityDrawer({ summary }: { summary: InboxSummary | undefined }) {
  const [open, setOpen] = useState(false);
  const vis = useVisibility(open);
  const setGroup = useSetGroupVisibility();
  const setCategory = useSetCategoryVisibility();

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="Show and hide mail"
      description="Hidden mail stays in your mailbox and in search. Changes save right away."
      trigger={
        <Button variant="secondary" icon={<Eye />}>
          Show and hide
        </Button>
      }
      footer={
        <Button variant="secondary" className="w-full" onClick={() => setOpen(false)}>
          Done
        </Button>
      }
    >
      {vis.isLoading ? (
        <LoadingRows rows={6} />
      ) : vis.isError ? (
        <ErrorState error={vis.error} onRetry={() => vis.refetch()} compact />
      ) : vis.data ? (
        <div className="divide-y divide-line">
          {MAIL_GROUPS.map((g) => {
            const group = summary?.groups[g];
            const groupOn = vis.data.groups[g] !== false;
            const cats = group?.categories ?? [];
            return (
              <section key={g} className="py-5 first:pt-0 last:pb-0" aria-label={GROUP_LABEL[g]}>
                <Switch
                  label={<span className="font-semibold">{GROUP_LABEL[g]}</span>}
                  description={`${GROUP_HINT[g]}${group ? ` · ${pluralize(group.total, "message")}` : ""}`}
                  checked={groupOn}
                  disabled={setGroup.isPending && setGroup.variables?.group === g}
                  onChange={(visible) =>
                    setGroup.mutate({ group: g, visible }, { onError: (e) => toastError(e, "Could not save that change") })
                  }
                />
                {cats.length > 1 ? (
                  <ul className="mt-3 space-y-2.5 border-l border-line pl-4" aria-label={`${GROUP_LABEL[g]} categories`}>
                    {cats.map((c) => (
                      <li key={c.key}>
                        <Switch
                          label={<span className="text-[0.9375rem]">{c.label}</span>}
                          description={pluralize(c.count, "message")}
                          checked={groupOn && vis.data.categories[c.key] !== false}
                          disabled={!groupOn || (setCategory.isPending && setCategory.variables?.key === c.key)}
                          onChange={(visible) =>
                            setCategory.mutate(
                              { key: c.key, visible },
                              { onError: (e) => toastError(e, "Could not save that change") },
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!groupOn && cats.length > 1 ? (
                  <p className="mt-2 text-sm text-ink-3">Show {GROUP_LABEL[g].toLowerCase()} to choose its categories.</p>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </Drawer>
  );
}
