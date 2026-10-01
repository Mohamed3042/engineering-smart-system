import { Check, Minus } from "lucide-react";
import { roleLabel } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { Panel, PanelBody, PanelHeader } from "@/ui";
import { canRole, PERMISSIONS, ROLE_BLURB, ROLE_ORDER, type RoleKey } from "./options";

function Mark({ yes, who }: { yes: boolean; who: string }) {
  return yes ? (
    <span className="inline-flex items-center justify-center text-brand-ink">
      <Check className="size-4" aria-hidden />
      <span className="sr-only">{who} can</span>
    </span>
  ) : (
    <span className="inline-flex items-center justify-center text-ink-3">
      <Minus className="size-4" aria-hidden />
      <span className="sr-only">{who} cannot</span>
    </span>
  );
}

/** Who may do what. The rows follow the role checks in the backend, so the table is the rule, not a guess. */
export function RolesPanel({ highlight }: { highlight?: string | null }) {
  return (
    <Panel>
      <PanelHeader
        title="What each role can do"
        description="Approving and sending always name a person and a revision, whatever the role."
      />
      <PanelBody className="space-y-6">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {ROLE_ORDER.map((r) => (
            <div key={r}>
              <dt className="text-sm font-semibold text-ink">{roleLabel(r)}</dt>
              <dd className="text-sm text-ink-3">{ROLE_BLURB[r]}</dd>
            </div>
          ))}
        </dl>

        <div>
          <div className="hidden grid-cols-[minmax(0,1fr)_repeat(5,4.5rem)] items-end gap-x-2 border-b border-line pb-2 text-xs font-medium text-ink-3 sm:grid">
            <span>Action</span>
            {ROLE_ORDER.map((r) => (
              <span key={r} className={cn("text-center", highlight === r && "font-semibold text-brand-ink")}>
                {roleLabel(r)}
              </span>
            ))}
          </div>
          <ul className="divide-y divide-line">
            {PERMISSIONS.map((p) => (
              <li key={p.label} className="grid gap-x-2 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_repeat(5,4.5rem)] sm:items-center">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{p.label}</p>
                  <p className="text-sm text-ink-3">{p.detail}</p>
                </div>
                {/* wide screens: one mark per role */}
                {ROLE_ORDER.map((r) => (
                  <span key={r} className={cn("hidden text-center sm:block", highlight === r && "rounded-md bg-brand-soft py-1")}>
                    <Mark yes={canRole(r, p.min)} who={roleLabel(r)} />
                  </span>
                ))}
                {/* phones: one line */}
                <p className="text-sm text-ink-2 sm:hidden">
                  {p.min === "viewer" ? "Everyone" : p.min === "owner" ? "Owner only" : `${roleLabel(p.min)} and above`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </PanelBody>
    </Panel>
  );
}

/** "You can / You need a higher role for" lists for one role (Your account). */
export function RolePermissions({ role }: { role: RoleKey | string }) {
  const can = PERMISSIONS.filter((p) => canRole(role, p.min));
  const cannot = PERMISSIONS.filter((p) => !canRole(role, p.min));
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-ink">You can</h3>
        <ul className="space-y-1.5">
          {can.map((p) => (
            <li key={p.label} className="flex items-start gap-2 text-sm text-ink-2">
              <Check className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
              {p.label}
            </li>
          ))}
        </ul>
      </div>
      {cannot.length ? (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-ink">You need a higher role to</h3>
          <ul className="space-y-1.5">
            {cannot.map((p) => (
              <li key={p.label} className="flex items-start gap-2 text-sm text-ink-3">
                <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {p.label} <span className="text-ink-3">· {roleLabel(p.min)} or above</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
