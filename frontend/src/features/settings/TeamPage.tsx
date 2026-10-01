import { Ellipsis, FlaskConical, UserCheck, UserPlus, UserX, Users } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useCurrentUser } from "@/api/session";
import type { TeamMember } from "@/api/types";
import { useCanManage } from "@/features/connections/api";
import { roleLabel } from "@/lib/labels";
import {
  Avatar,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineError,
  Input,
  Menu,
  Panel,
  PanelHeader,
  QueryState,
  Select,
  toast,
  toastError,
} from "@/ui";
import { useActAs, useAddMember, useTeam, useUpdateMember } from "./api";
import { ASSIGNABLE_ROLES, EMAIL_RE, ROLE_BLURB, type RoleKey } from "./options";
import { RolesPanel } from "./RolesPanel";
import { SettingsPage } from "./SettingsPage";

const roleOptions = ASSIGNABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) }));

/* ------------------------------------------------------------------ add member */

function AddMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const add = useAddMember();
  const formId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleKey>("engineer");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  const reset = () => {
    setName("");
    setEmail("");
    setRole("engineer");
    setErrors({});
    add.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Enter the person's name.";
    if (email.trim() && !EMAIL_RE.test(email.trim())) next.email = "Enter a full address such as name@company.com.";
    setErrors(next);
    if (next.name || next.email) return;
    add.mutate(
      { name: name.trim(), email: email.trim(), role },
      {
        onSuccess: (m) => {
          toast.success(`${m.name} added`, { description: `Role: ${roleLabel(m.role)}.` });
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Add team member"
      description="They appear in the team list and can be given work. There is no sign-in: this app runs on this computer."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={add.isPending}>
            Add member
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-5">
        <Field label="Name" htmlFor={`${formId}-name`} required error={errors.name}>
          <Input id={`${formId}-name`} value={name} invalid={!!errors.name} autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor={`${formId}-email`} optional error={errors.email}>
          <Input
            id={`${formId}-email`}
            type="email"
            inputMode="email"
            value={email}
            invalid={!!errors.email}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role" htmlFor={`${formId}-role`} hint={ROLE_BLURB[role]}>
          <Select id={`${formId}-role`} value={role} options={roleOptions} onChange={(e) => setRole(e.target.value as RoleKey)} />
        </Field>
        <InlineError error={add.error} />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ one member */

function MemberRow({
  member,
  isYou,
  canManage,
  onDeactivate,
}: {
  member: TeamMember;
  isYou: boolean;
  canManage: boolean;
  onDeactivate: (m: TeamMember) => void;
}) {
  const update = useUpdateMember();
  const actAs = useActAs();
  const isOwner = member.role === "owner";

  const changeRole = (role: string) =>
    update.mutate(
      { id: member.id, patch: { role } },
      {
        onSuccess: () => toast.success(`${member.name} is now ${roleLabel(role)}`),
        onError: (err) => toastError(err, "The role could not be changed"),
      },
    );

  const reactivate = () =>
    update.mutate(
      { id: member.id, patch: { active: true } },
      {
        onSuccess: () => toast.success(`${member.name} is active again`),
        onError: (err) => toastError(err, "The member could not be reactivated"),
      },
    );

  const actAsMember = () =>
    actAs.mutate(member.id, {
      onSuccess: () => toast.success(`Now using the app as ${member.name}`, { description: `Role: ${roleLabel(member.role)}. Switch back in Your account.` }),
      onError: (err) => toastError(err, "Could not switch"),
    });

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={member.name} initials={member.initials} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-ink">
            <span className="break-words">{member.name}</span>
            {isYou ? (
              <Chip size="sm" tone="brand">
                You
              </Chip>
            ) : null}
            {!member.active ? (
              <Chip size="sm" tone="muted">
                Inactive
              </Chip>
            ) : null}
          </p>
          <p className="truncate text-sm text-ink-3">{member.email || "No email"}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        {isOwner ? (
          <Chip tone="brand">Owner</Chip>
        ) : canManage ? (
          <Select
            aria-label={`Role of ${member.name}`}
            className="min-w-0 flex-1 sm:w-40 sm:flex-none"
            value={member.role}
            disabled={update.isPending}
            options={roleOptions}
            onChange={(e) => changeRole(e.target.value)}
          />
        ) : (
          <Chip>{roleLabel(member.role)}</Chip>
        )}
        <Menu
          trigger={
            <IconButton label={`More actions for ${member.name}`} variant="secondary">
              <Ellipsis />
            </IconButton>
          }
          items={[
            { label: isYou ? "You are using the app as this person" : `Use the app as ${member.name.split(" ")[0]} (testing)`, icon: <FlaskConical />, disabled: isYou || !member.active, onSelect: actAsMember },
            ...(member.active
              ? [
                  {
                    label: isOwner ? "The owner cannot be deactivated" : isYou ? "You cannot deactivate yourself" : "Deactivate",
                    icon: <UserX />,
                    danger: true,
                    disabled: !canManage || isOwner || isYou,
                    separatorBefore: true,
                    onSelect: () => onDeactivate(member),
                  },
                ]
              : [{ label: "Reactivate", icon: <UserCheck />, disabled: !canManage, separatorBefore: true, onSelect: reactivate }]),
          ]}
        />
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ page */

/** Settings › Team & permissions. */
export function TeamPage() {
  const team = useTeam();
  const me = useCurrentUser();
  const canManage = useCanManage();
  const update = useUpdateMember();
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState<TeamMember | null>(null);

  const deactivate = () => {
    if (!leaving) return;
    update.mutate(
      { id: leaving.id, patch: { active: false } },
      {
        onSuccess: () => {
          toast.success(`${leaving.name} deactivated`);
          setLeaving(null);
        },
        onError: (err) => {
          setLeaving(null);
          toastError(err, "The member could not be deactivated");
        },
      },
    );
  };

  return (
    <SettingsPage
      title="Team & permissions"
      meta="Who works in this workspace and what each role may do."
      actions={
        <Button icon={<UserPlus />} disabled={!canManage} onClick={() => setAdding(true)} title={canManage ? undefined : "Only an owner or admin can add members."}>
          Add member
        </Button>
      }
    >
      <Panel>
        <PanelHeader
          title="Members"
          description={team.data ? `${team.data.filter((m) => m.active).length} active of ${team.data.length}` : undefined}
        />
        <QueryState
          query={team}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              icon={<Users />}
              title="No team members yet"
              action={
                canManage ? (
                  <Button icon={<UserPlus />} onClick={() => setAdding(true)}>
                    Add member
                  </Button>
                ) : null
              }
            >
              The workspace owner appears here once the workspace exists. Add engineers and sales people so approvals name the right person.
            </EmptyState>
          }
        >
          {(members) => (
            <ul className="divide-y divide-line">
              {members.map((m) => (
                <MemberRow key={m.id} member={m} isYou={m.id === me?.id} canManage={canManage} onDeactivate={setLeaving} />
              ))}
            </ul>
          )}
        </QueryState>
        {!canManage ? <p className="border-t border-line px-5 py-3 text-sm text-ink-3">Only an owner or admin can change the team.</p> : null}
      </Panel>

      <RolesPanel highlight={me?.role} />

      <AddMemberDialog open={adding} onOpenChange={setAdding} />

      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={`Deactivate ${leaving?.name ?? ""}?`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={update.isPending}
        onConfirm={deactivate}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>{leaving?.name} is marked inactive. Everything they approved, sent or changed keeps their name.</p>
          <p>You can reactivate them at any time from the same menu.</p>
        </div>
      </ConfirmDialog>
    </SettingsPage>
  );
}
