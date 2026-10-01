import { Check, FlaskConical, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "@/api/client";
import { useCurrentUser, useSession, useWorkspace } from "@/api/session";
import { roleLabel } from "@/lib/labels";
import { Avatar, Button, Chip, ErrorState, Field, KeyValue, Panel, PanelBody, PanelHeader, Select, Skeleton, toast, toastError } from "@/ui";
import { useActAs, useActivateWorkspace, useTeam } from "./api";
import { RolePermissions } from "./RolesPanel";
import { SettingsPage } from "./SettingsPage";
import { version as interfaceVersion } from "../../../package.json";

function AboutApp() {
  const health = useQuery({
    queryKey: ["app-health"],
    queryFn: () => api.get<{ version?: string; build_commit?: string }>("/health"),
    staleTime: 30_000,
    retry: 1,
  });
  const commit = health.data?.build_commit;
  return (
    <Panel>
      <PanelHeader title="About" />
      <PanelBody className="space-y-3">
        <KeyValue
          labelWidth="sm"
          items={[
            { label: "Interface", value: interfaceVersion },
            { label: "Engine", value: health.isLoading ? "Checking…" : health.data?.version ?? "Unavailable" },
            { label: "Build", value: health.isLoading ? "Checking…" : commit && commit !== "unknown" ? <span title={commit}>{commit.slice(0, 12)}</span> : "Unknown" },
          ]}
        />
        {health.isError ? <ErrorState error={health.error} onRetry={() => health.refetch()} compact /> : null}
      </PanelBody>
    </Panel>
  );
}

function UseAppAs() {
  const me = useCurrentUser();
  const team = useTeam();
  const actAs = useActAs();
  const [picked, setPicked] = useState<string | null>(null);
  const members = (team.data ?? []).filter((m) => m.active);
  const value = picked ?? me?.id ?? "";
  const target = members.find((m) => m.id === value);

  return (
    <Panel>
      <PanelHeader
        title="Use the app as someone else"
        description="For local testing: see what another team member's role can see and do. Nothing is signed in or out; this only changes who the app treats you as."
      />
      <PanelBody className="space-y-4">
        {team.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : team.isError ? (
          <ErrorState error={team.error} onRetry={() => team.refetch()} compact />
        ) : (
          <Field label="Team member" htmlFor="act-as" hint={target ? `${roleLabel(target.role)}: you get exactly that role's permissions until you switch back.` : undefined}>
            <Select
              id="act-as"
              value={value}
              options={members.map((m) => ({ value: m.id, label: `${m.name} · ${roleLabel(m.role)}${m.id === me?.id ? " (you)" : ""}` }))}
              onChange={(e) => setPicked(e.target.value)}
            />
          </Field>
        )}
        <Button
          variant="secondary"
          icon={<FlaskConical />}
          loading={actAs.isPending}
          disabled={!target || target.id === me?.id}
          className="w-full sm:w-auto"
          onClick={() =>
            target &&
            actAs.mutate(target.id, {
              onSuccess: () => {
                setPicked(null);
                toast.success(`Now using the app as ${target.name}`, { description: `Role: ${roleLabel(target.role)}.` });
              },
              onError: (err) => toastError(err, "Could not switch"),
            })
          }
        >
          {target && target.id !== me?.id ? `Use the app as ${target.name.split(" ")[0]}` : "Use the app as…"}
        </Button>
      </PanelBody>
    </Panel>
  );
}

/** Settings › Your account: who the app treats you as, your role, and the workspaces on this computer. */
export function AccountPage() {
  const session = useSession();
  const workspace = useWorkspace();
  const me = useCurrentUser();
  const activate = useActivateWorkspace();
  const navigate = useNavigate();
  const others = (session.data?.workspaces ?? []).filter((w) => w.id !== workspace.id);

  return (
    <SettingsPage title="Your account" meta="Who you are in this workspace." width="narrow">
      <Panel>
        <PanelHeader title="You" />
        <PanelBody className="space-y-5">
          {me ? (
            <>
              <div className="flex items-center gap-4">
                <Avatar name={me.name} initials={me.initials} size="lg" />
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-ink">{me.name}</p>
                  <p className="truncate text-base text-ink-3">{me.email || "No email on file"}</p>
                </div>
                <Chip className="ml-auto" tone="brand">
                  {roleLabel(me.role)}
                </Chip>
              </div>
              <RolePermissions role={me.role} />
              <p className="text-sm text-ink-3">
                To change your name, email or role, ask an owner or admin in <Link to="/settings/team" className="font-medium text-brand-ink hover:underline">Team &amp; permissions</Link>.
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-3">No team member is selected. Add one in Team &amp; permissions.</p>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Workspace"
          description="Each company has its own mailbox, vocabulary and rules."
          actions={
            <Button asChild variant="secondary">
              <Link to="/setup/workspace?new=1">
                <Plus aria-hidden />
                Create workspace
              </Link>
            </Button>
          }
        />
        <PanelBody className="space-y-5">
          <KeyValue
            labelWidth="sm"
            items={[
              { label: "Company", value: workspace.company_name || workspace.name },
              { label: "Mailbox", value: workspace.primary_email || null },
              { label: "Region", value: [workspace.region, workspace.country].filter(Boolean).join(" · ") || null },
            ]}
          />
          <Button asChild variant="link">
            <Link to="/settings/workspace">Open workspace settings</Link>
          </Button>
          {others.length ? (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-ink">Other workspaces on this computer</h3>
              <ul className="divide-y divide-line">
                {others.map((w) => (
                  <li key={w.id} className="flex items-center gap-3 py-2.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-sunken text-sm font-semibold text-ink-2" aria-hidden>
                      {(w.company_name || w.name).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{w.company_name || w.name}</span>
                      <span className="block truncate text-sm text-ink-3">{w.primary_email}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Check />}
                      loading={activate.isPending && activate.variables === w.id}
                      disabled={activate.isPending}
                      onClick={() =>
                        activate.mutate(w.id, {
                          onSuccess: () => navigate("/"),
                          onError: (err) => toastError(err, "Could not switch workspace"),
                        })
                      }
                    >
                      Switch
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      <UseAppAs />
      <AboutApp />
    </SettingsPage>
  );
}
