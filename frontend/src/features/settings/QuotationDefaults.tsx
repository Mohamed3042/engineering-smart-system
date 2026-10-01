import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/types";
import { useSaveWorkspace } from "@/features/knowledge/api";
import { Banner, Button, ConfirmDialog, Field, InlineError, Panel, PanelBody, PanelHeader, Select, Skeleton, Switch, toast } from "@/ui";
import { usePapers } from "./api";
import type { QuotationDefaults } from "./types";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
];

/**
 * Defaults for new quotation drafts: language, paper and whether drafts carry the real signature.
 * Saved into workspace.settings.quotations (the backend merges that group, so other keys stay).
 */
export function QuotationDefaultsPanel({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const saved = (workspace.settings?.quotations ?? {}) as QuotationDefaults;
  const papers = usePapers();
  const save = useSaveWorkspace();
  const savedLanguage = saved.default_language ?? "en";
  const savedPaper = saved.default_paper_id ?? papers.data?.default ?? "";
  const savedSign = Boolean(saved.sign_drafts);

  const [language, setLanguage] = useState(savedLanguage);
  const [paper, setPaper] = useState<string | null>(null);
  const [sign, setSign] = useState(savedSign);
  const [confirmSign, setConfirmSign] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const paperValue = paper ?? savedPaper;
  const hasPapers = (papers.data?.items.length ?? 0) > 0;
  const dirty = language !== savedLanguage || (hasPapers && paperValue !== savedPaper) || sign !== savedSign;
  const turningOnSigning = sign && !savedSign;

  const write = () => {
    setError(null);
    const quotations: QuotationDefaults = { default_language: language, sign_drafts: sign };
    if (hasPapers && paperValue) quotations.default_paper_id = paperValue;
    save.mutate(
      { settings: { quotations } },
      {
        onSuccess: () => {
          setConfirmSign(false);
          setPaper(null);
          toast.success("Quotation defaults saved");
        },
        onError: (err) => {
          setConfirmSign(false);
          setError(err);
        },
      },
    );
  };

  return (
    <Panel>
      <PanelHeader title="Quotation defaults" description="Where new quotation drafts start. Anyone can still change them on a draft." />
      <PanelBody className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Default language" htmlFor="q-language">
            <Select id="q-language" value={language} disabled={!canEdit} options={LANGUAGES} onChange={(e) => setLanguage(e.target.value)} />
          </Field>
          {papers.isLoading ? (
            <div className="space-y-1.5" aria-label="Loading papers">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : hasPapers ? (
            <Field label="Default paper" htmlFor="q-paper" hint="The letterhead the quotation is printed on.">
              <Select
                id="q-paper"
                value={paperValue}
                disabled={!canEdit}
                options={(papers.data?.items ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.name}${p.complete ? "" : " (incomplete)"}`,
                  disabled: !p.complete,
                }))}
                onChange={(e) => setPaper(e.target.value)}
              />
            </Field>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-ink">Default paper</p>
              <p className="text-sm text-ink-3">
                {papers.isError
                  ? "The list of papers could not load. Reload the page to try again."
                  : "No letterhead papers are installed yet. Add one in Quotation setup; quotations use the plain layout until then."}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-line pt-5">
          <Switch
            label="Put the real signature and stamp on drafts"
            description="Off by default. A draft then carries no signature or stamp, so a forwarded draft cannot pass for an issued offer."
            checked={sign}
            disabled={!canEdit}
            onChange={setSign}
          />
          {sign ? (
            <Banner tone="review" icon={<TriangleAlert aria-hidden />} title="Drafts will look like issued quotations">
              Anyone who receives a draft PDF sees the signatory&apos;s signature and the company stamp, before an engineer approved it. Leave this
              off unless you need it.
            </Banner>
          ) : null}
        </div>

        <InlineError error={error} />
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
          {!canEdit ? <p className="text-sm text-ink-3">Only an owner or admin can change this.</p> : null}
          <Button
            loading={save.isPending && !confirmSign}
            disabled={!canEdit || !dirty}
            onClick={() => (turningOnSigning ? setConfirmSign(true) : write())}
            className="w-full sm:w-auto"
          >
            Save defaults
          </Button>
        </div>
      </PanelBody>

      <ConfirmDialog
        open={confirmSign}
        onOpenChange={setConfirmSign}
        title="Put the real signature and stamp on drafts?"
        confirmLabel="Sign drafts"
        variant="danger"
        loading={save.isPending}
        onConfirm={write}
      >
        <div className="space-y-2 text-base text-ink-2">
          <p>From now on every quotation draft is rendered with the signatory&apos;s signature and the company stamp.</p>
          <p>A draft that is forwarded or printed could pass for an issued offer. Approved quotations always carry them, whatever this setting says.</p>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}
