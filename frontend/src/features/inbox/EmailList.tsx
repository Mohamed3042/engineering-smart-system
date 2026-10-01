import { ChevronRight } from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { emailHref, projectHref } from "@/lib/routes";
import { Checkbox, Chip, RowChevron, Table, TBody, TD, TH, THead, TR } from "@/ui";
import type { EmailListItem } from "./api";
import { iconFor } from "./categoryIcon";
import { emailStateInfo, type MailGroup } from "./labels";
import { CategoryCell, IntentLabel, LowConfidenceChip, MailDate, SenderCell, SubjectCell, UnsubscribeButton, dirOf, senderName } from "./parts";
import { LOW_CONFIDENCE } from "./labels";

const stop = (e: MouseEvent) => e.stopPropagation();

export interface ListProps {
  items: EmailListItem[];
  group: MailGroup;
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onUnsubscribe: (email: EmailListItem) => void;
  /** category key → icon name */
  iconOf: (key: string) => string | undefined;
}

function columns(group: MailGroup, items: EmailListItem[]) {
  const mailish = group === "work" || group === "other";
  return {
    category: mailish,
    intent: mailish,
    project: group !== "promotions",
    unsubscribe: (group === "promotions" || group === "bills") && items.some((e) => e.list_unsubscribe || e.unsubscribed_at),
  };
}

/** Link state lets the email page return to the same filtered list. */
function useOpen() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = { from: location.search };
  return { state, open: (id: string) => navigate(emailHref(id), { state }) };
}

/* ------------------------------------------------------------------ desktop */

export function EmailTable({ items, group, selected, onToggle, onToggleAll, onUnsubscribe, iconOf }: ListProps) {
  const cols = columns(group, items);
  const { state, open } = useOpen();
  const all = items.length > 0 && items.every((e) => selected.has(e.id));
  const some = items.some((e) => selected.has(e.id));
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-12 pr-0">
            <Checkbox checked={all ? true : some ? "indeterminate" : false} onChange={(v) => onToggleAll(v)} />
          </TH>
          <TH className="w-[15rem]">Sender</TH>
          <TH>Subject</TH>
          {cols.category ? <TH className="w-[12rem]">{group === "work" ? "Service family" : "Category"}</TH> : null}
          {cols.intent ? <TH className="w-[10rem]">Mail intent</TH> : null}
          <TH className="w-[7.5rem]">Received</TH>
          {cols.project ? <TH className="w-[13rem]">Project</TH> : null}
          {cols.unsubscribe ? (
            <TH className="w-[11rem]">
              <span className="sr-only">Unsubscribe</span>
            </TH>
          ) : null}
          <TH className="w-10">
            <span className="sr-only">Open</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {items.map((e) => {
          const isSel = selected.has(e.id);
          return (
            <TR key={e.id} selected={isSel} onClick={() => open(e.id)}>
              <TD className="w-12 pr-0" onClick={stop}>
                <Checkbox checked={isSel} onChange={(v) => onToggle(e.id, v)} />
              </TD>
              <TD className="max-w-[15rem]">
                <SenderCell email={e} />
              </TD>
              <TD className="min-w-[16rem]">
                <Link
                  to={emailHref(e.id)}
                  state={state}
                  onClick={stop}
                  className="block rounded hover:[&_span.font-medium]:underline"
                  aria-label={`${e.subject || "(no subject)"}, from ${senderName(e)}`}
                >
                  <SubjectCell email={e} />
                </Link>
              </TD>
              {cols.category ? (
                <TD>
                  <CategoryCell email={e} iconName={iconOf(e.category)} />
                </TD>
              ) : null}
              {cols.intent ? (
                <TD>
                  <IntentLabel intent={e.intent} />
                </TD>
              ) : null}
              <TD className="text-sm text-ink-2">
                <MailDate date={e.date} />
                <StateNote state={e.state} />
              </TD>
              {cols.project ? (
                <TD className="max-w-[13rem]">
                  <ProjectCell email={e} />
                </TD>
              ) : null}
              {cols.unsubscribe ? (
                <TD onClick={stop}>
                  <UnsubscribeButton email={e} onUnsubscribe={() => onUnsubscribe(e)} />
                </TD>
              ) : null}
              <TD className="w-10 align-middle">
                <RowChevron />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

/** Only states that change what a person does next get a mark. */
function StateNote({ state }: { state: string }) {
  if (state === "new" || state === "linked") return null;
  const info = emailStateInfo(state);
  return <p className={cn("mt-1 text-xs", info.tone === "review" ? "font-medium text-review" : "text-ink-3")}>{info.label}</p>;
}

function ProjectCell({ email }: { email: EmailListItem }) {
  if (!email.project) {
    return email.customer ? <p className="line-clamp-2 text-sm text-ink-3">{email.customer.name}</p> : <span className="text-sm text-ink-3">—</span>;
  }
  return (
    <div className="min-w-0">
      <Link
        to={projectHref(email.project.id)}
        onClick={stop}
        title={email.project.name}
        className="line-clamp-2 break-words rounded text-sm font-medium text-brand-ink hover:underline"
        dir={dirOf(email.project.name)}
      >
        {email.project.name}
      </Link>
      {email.customer ? <p className="line-clamp-1 text-xs text-ink-3">{email.customer.name}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ phone and narrow screens */

export function EmailCards({ items, group, selected, onToggle, onUnsubscribe, iconOf }: Omit<ListProps, "onToggleAll">) {
  const { state } = useOpen();
  const showUnsub = group === "promotions" || group === "bills";
  return (
    <ul className="space-y-3">
      {items.map((e) => {
        const isSel = selected.has(e.id);
        const Icon = iconFor(iconOf(e.category));
        const uncertain = e.category_source !== "user" && e.category_confidence < LOW_CONFIDENCE;
        const st = emailStateInfo(e.state);
        return (
          <li
            key={e.id}
            className={cn(
              "rounded-xl border bg-surface shadow-panel transition-colors",
              isSel ? "border-brand-line bg-brand-soft/40" : "border-line",
            )}
          >
            <div className="flex gap-3 p-4">
              <div className="pt-0.5">
                <Checkbox checked={isSel} onChange={(v) => onToggle(e.id, v)} />
              </div>
              <Link
                to={emailHref(e.id)}
                state={state}
                className="-m-1 min-w-0 flex-1 rounded-lg p-1"
                aria-label={`${e.subject || "(no subject)"}, from ${senderName(e)}`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-ink-2" dir={dirOf(senderName(e))}>
                    {senderName(e)}
                  </p>
                  <MailDate date={e.date} className="shrink-0 text-xs text-ink-3" />
                </div>
                <div className="mt-1">
                  <SubjectCell email={e} clamp={2} />
                </div>
                {group !== "promotions" ? (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {group === "work" || group === "other" ? (
                      <Chip size="sm" icon={<Icon aria-hidden />}>
                        {e.category_label || e.category}
                      </Chip>
                    ) : null}
                    {uncertain ? <LowConfidenceChip /> : null}
                    {e.intent && e.intent !== "other" ? <IntentLabel intent={e.intent} /> : null}
                    {e.state !== "new" && e.state !== "linked" ? (
                      <Chip size="sm" tone={st.tone}>
                        {st.label}
                      </Chip>
                    ) : null}
                  </div>
                ) : null}
                {e.project ? (
                  <p className="mt-2 line-clamp-2 text-sm text-ink-2">
                    <span className="text-ink-3">Project: </span>
                    <span className="font-medium text-ink" dir={dirOf(e.project.name)}>
                      {e.project.name}
                    </span>
                  </p>
                ) : null}
              </Link>
              <ChevronRight className="mt-0.5 size-5 shrink-0 text-ink-3" aria-hidden />
            </div>
            {showUnsub && (e.list_unsubscribe || e.unsubscribed_at) ? (
              <div className="flex justify-end border-t border-line px-4 py-3">
                <UnsubscribeButton email={e} onUnsubscribe={() => onUnsubscribe(e)} className="w-full sm:w-auto" />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
