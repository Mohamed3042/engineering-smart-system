import { Cloud, Link2 } from "lucide-react";
import { useWorkspace } from "@/api/session";
import { useSaveWorkspace } from "@/features/knowledge/api";
import { TagInput } from "@/features/knowledge/components/TagInput";
import { Panel, PanelHeader, Switch, toast, toastError } from "@/ui";
import { MANAGE_HINT, useCanManage } from "../api";
import { IconTile } from "./bits";

interface HostGroup {
  key: string;
  name: string;
  hosts: string[];
  note: string;
}

/** Link hosts customers use to send drawings. Matching follows the backend: the host or any subdomain of it. */
const SERVICES: HostGroup[] = [
  { key: "google", name: "Google Drive", hosts: ["drive.google.com", "docs.google.com"], note: "Shared folders and files." },
  { key: "wetransfer", name: "WeTransfer", hosts: ["wetransfer.com", "we.tl"], note: "Download links." },
  { key: "dropbox", name: "Dropbox", hosts: ["dropbox.com", "www.dropbox.com"], note: "Shared links." },
  { key: "onedrive", name: "OneDrive", hosts: ["onedrive.live.com", "1drv.ms"], note: "Shared links." },
];

const known = new Set(SERVICES.flatMap((s) => s.hosts));

function readHosts(settings: Record<string, any> | undefined): string[] {
  const list = settings?.downloads?.auto_approve_hosts;
  return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : [];
}

/**
 * Which file-sharing links download without asking. Files are fetched over plain links, so there is no
 * sign-in here: a link from a host on this list downloads automatically, any other link waits for a person.
 */
export function SharedLinksSection() {
  const workspace = useWorkspace();
  const canManage = useCanManage();
  const save = useSaveWorkspace();
  const hosts = readHosts(workspace.settings);
  const others = hosts.filter((h) => !known.has(h));

  const write = (next: string[], done: string) =>
    save.mutate(
      { settings: { downloads: { auto_approve_hosts: [...new Set(next)] } } },
      { onSuccess: () => toast.success(done), onError: (err) => toastError(err, "The link settings could not be saved") },
    );

  const isOn = (s: HostGroup) => s.hosts.some((h) => hosts.includes(h));
  const toggle = (s: HostGroup, on: boolean) =>
    write(on ? [...hosts, ...s.hosts] : hosts.filter((h) => !s.hosts.includes(h)), on ? `${s.name} links download automatically` : `${s.name} links wait for approval`);

  return (
    <Panel>
      <PanelHeader
        title="Shared-file links"
        description="Customers send drawings and specifications as links. Links from the services you allow download on their own; every other link waits for a person to approve it."
      />
      <ul className="divide-y divide-line">
        {SERVICES.map((s) => (
          <li key={s.key} className="flex items-center gap-4 px-5 py-4">
            <IconTile>
              <Cloud />
            </IconTile>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">{s.name}</p>
              <p className="text-sm text-ink-3">{isOn(s) ? "Downloads start automatically." : "Each link waits for approval."} {s.note}</p>
            </div>
            <Switch
              checked={isOn(s)}
              disabled={!canManage || save.isPending}
              onChange={(on) => toggle(s, on)}
              label={<span className="sr-only">{`Download ${s.name} links automatically`}</span>}
            />
          </li>
        ))}
        <li className="px-5 py-4">
          <div className="flex items-center gap-4">
            <IconTile>
              <Link2 />
            </IconTile>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">Other hosts</p>
              <p className="text-sm text-ink-3">Company servers or other file services you trust, for example files.example.com. Subdomains are included.</p>
            </div>
          </div>
          <div className="mt-3 sm:pl-14">
            <TagInput
              label="Other hosts that download automatically"
              value={others}
              disabled={!canManage || save.isPending}
              placeholder="files.example.com"
              normalize={(s) =>
                s
                  .trim()
                  .toLowerCase()
                  .replace(/^[a-z]+:\/\//, "")
                  .replace(/[/?#].*$/, "")
              }
              validate={(s) => (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(s) ? null : `“${s}” is not a host name. Use a name like files.example.com.`)}
              onChange={(next) => write([...hosts.filter((h) => known.has(h)), ...next], "Link hosts saved")}
            />
            {!canManage ? <p className="mt-2 text-sm text-ink-3">{MANAGE_HINT}</p> : null}
          </div>
        </li>
      </ul>
    </Panel>
  );
}
