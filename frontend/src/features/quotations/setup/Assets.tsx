/**
 * Company assets for the PDF: installed papers (full letterhead or pre-printed body only), the
 * default paper's header / footer / stamp / watermark images, and the private product catalogue.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, CircleAlert, FileText, History, Minus, Star, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { humanize, isRtl } from "@/lib/format";
import {
  Banner,
  Chip,
  ConfirmDialog,
  EmptyState,
  ListRow,
  LoadingRows,
  Panel,
  PanelHeader,
  QueryState,
  SearchInput,
  Segmented,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from "@/ui";
import { useCatalog, useInvalidate, useLetterhead, usePapers, type LetterheadAsset, type LetterheadStatus } from "../api";
import { ExplainedError, FileButton, PaperSchematic, Reason } from "../components";
import { useDebounced } from "../editor/LineTools";
import { languageLabel, paperModeLabel, useRoleGate } from "../lib";

function FileChip({ label, present }: { label: string; present: boolean }) {
  return present ? (
    <Chip size="sm" tone="brand" icon={<Check aria-hidden />}>
      {label}
    </Chip>
  ) : (
    <Chip size="sm" tone="muted" icon={<Minus aria-hidden />}>
      No {label.toLowerCase()}
    </Chip>
  );
}

/* ------------------------------------------------------------------ papers */

export function PapersTab() {
  const papers = usePapers();
  return (
    <Panel>
      <PanelHeader
        title="Papers"
        description="Letterhead sets the PDFs print on. Each quotation can choose one; otherwise the workspace default applies."
      />
      <QueryState
        query={papers}
        loading={<LoadingRows rows={2} />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<FileText />}
            title="No company paper installed"
            action={
              <Link to="/quotations/setup/letterhead" className="font-medium text-brand-ink underline-offset-4 hover:underline">
                Upload the header and footer
              </Link>
            }
          >
            PDFs use a neutral specimen letterhead until a paper is installed. Upload the header and footer under Stamp &amp;
            letterhead, or add paper folders under papers/ in the private folder.
          </EmptyState>
        }
      >
        {(d) => (
          <ul className="divide-y divide-line">
            {d.items.map((p) => {
              const pre = p.mode === "preprinted";
              return (
                <li key={p.id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start">
                  <div className="w-24 shrink-0">
                    <PaperSchematic mode={p.mode} files={p.files} label={`${p.name}: ${paperModeLabel(p.mode)}`} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                      {p.name}
                      {p.id === d.default ? (
                        <Chip size="sm" tone="neutral" icon={<Star aria-hidden />}>
                          Workspace default
                        </Chip>
                      ) : null}
                      {!p.complete ? (
                        <Chip size="sm" tone="review" icon={<CircleAlert aria-hidden />}>
                          Incomplete
                        </Chip>
                      ) : null}
                    </p>
                    <p className="text-sm text-ink-2">
                      {paperModeLabel(p.mode)}:{" "}
                      {pre ? "prints the body only, on white, for the company's own printed paper." : "prints the header and footer with the text."}
                    </p>
                    <p className="text-sm text-ink-3">
                      {p.languages.length ? p.languages.map(languageLabel).join(", ") : "All languages"}
                      {p.company_name ? ` · ${p.company_name}` : ""} · <span className="font-mono text-xs">{p.id}</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {!pre ? <FileChip label="Header" present={Boolean(p.files.header)} /> : null}
                      {!pre ? <FileChip label="Footer" present={Boolean(p.files.footer)} /> : null}
                      <FileChip label="Stamp" present={Boolean(p.files.stamp)} />
                      <FileChip label="Watermark" present={Boolean(p.files.watermark)} />
                    </div>
                    {p.warnings.map((w) => (
                      <p key={w} className="text-sm text-review">
                        {w}
                      </p>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Panel>
  );
}

/* ------------------------------------------------------------------ letterhead */

const ASSETS: { key: LetterheadAsset; label: string; text: string }[] = [
  { key: "header", label: "Header", text: "Top band of the full letterhead, full page width. JPEG or PNG." },
  { key: "footer", label: "Footer", text: "Bottom band of the full letterhead, full page width. JPEG or PNG." },
  { key: "stamp", label: "Company stamp", text: "Transparent PNG. Printed on approved PDFs only, never on drafts." },
  { key: "watermark", label: "Watermark", text: "Faint logo behind the text. Transparent PNG." },
];

export function LetterheadTab() {
  const letterhead = useLetterhead();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const denied = useRoleGate()("admin", "Changing the letterhead");
  const [replacing, setReplacing] = useState<{ asset: LetterheadAsset; file: File } | null>(null);
  const label = (k: LetterheadAsset) => ASSETS.find((a) => a.key === k)?.label ?? k;
  const upload = useMutation({
    mutationFn: ({ asset, file }: { asset: LetterheadAsset; file: File }) => api.upload<LetterheadStatus>(`/letterhead/${asset}`, file),
    onSuccess: async (status, { asset }) => {
      qc.setQueryData(["letterhead"], status);
      toast.success(`${label(asset)} saved`, { description: "PDFs rendered from now on use it." });
      setReplacing(null);
      await invalidate(["letterhead"], ["papers"]);
    },
  });

  return (
    <>
      <Panel>
        <PanelHeader
          title="Stamp and letterhead"
          description="The company's own images for the default paper. They stay in the private folder on this computer."
        />
        <QueryState query={letterhead} loading={<LoadingRows rows={4} />}>
          {(lh) => (
            <div className="space-y-4 px-5 py-4">
              {!lh.complete ? (
                <Banner tone="review" title="No full letterhead installed">
                  Without a header and a footer, PDFs print on a neutral specimen letterhead.
                </Banner>
              ) : null}
              <Reason>{denied}</Reason>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_9rem]">
                <ul className="divide-y divide-line">
                  {ASSETS.map((a) => {
                    const file = lh.assets[a.key];
                    return (
                      <li key={a.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                            {a.label}
                            {file ? (
                              <Chip size="sm" tone="brand" icon={<Check aria-hidden />}>
                                Installed
                              </Chip>
                            ) : (
                              <Chip size="sm" tone={a.key === "header" || a.key === "footer" ? "review" : "muted"} icon={<Minus aria-hidden />}>
                                Not installed
                              </Chip>
                            )}
                          </p>
                          <p className="text-sm text-ink-3">{a.text}</p>
                          {file ? <p className="font-mono text-xs text-ink-3">{file}</p> : null}
                        </div>
                        <FileButton
                          accept="image/png,image/jpeg"
                          icon={<Upload />}
                          size="sm"
                          disabled={Boolean(denied) || upload.isPending}
                          loading={upload.isPending && upload.variables?.asset === a.key}
                          onFile={(f) => (file ? setReplacing({ asset: a.key, file: f }) : upload.mutate({ asset: a.key, file: f }))}
                          className="max-sm:w-full"
                        >
                          {file ? "Replace" : "Upload"}
                        </FileButton>
                      </li>
                    );
                  })}
                </ul>
                <div className="mx-auto w-32 lg:w-full">
                  <PaperSchematic
                    files={{ header: Boolean(lh.assets.header), footer: Boolean(lh.assets.footer) }}
                    label="Which parts of the letterhead are installed"
                  />
                  <p className="mt-2 text-xs text-ink-3">Filled bands are installed; dashed bands are not.</p>
                </div>
              </div>
              {upload.error && !replacing ? <ExplainedError error={upload.error} /> : null}
              <p className="text-sm text-ink-3">
                Private folder: <span className="break-all font-mono text-xs">{lh.private_dir}</span>
              </p>
            </div>
          )}
        </QueryState>
      </Panel>
      <ConfirmDialog
        open={Boolean(replacing)}
        onOpenChange={(o) => {
          if (!o && !upload.isPending) {
            setReplacing(null);
            upload.reset();
          }
        }}
        title={replacing ? `Replace the ${label(replacing.asset).toLowerCase()}?` : "Replace"}
        description={replacing ? `With ${replacing.file.name}.` : undefined}
        confirmLabel={replacing ? `Replace ${label(replacing.asset).toLowerCase()}` : "Replace"}
        variant="danger"
        loading={upload.isPending}
        onConfirm={() => replacing && upload.mutate(replacing)}
      >
        <p className="text-sm text-ink-2">
          The current file{replacing && letterhead.data?.assets[replacing.asset] ? ` (${letterhead.data.assets[replacing.asset]})` : ""} is
          deleted. Every PDF rendered from now on uses the new image; PDFs already sent are not changed.
        </p>
        <ExplainedError error={upload.error} className="mt-3" />
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ catalogue */

export function CatalogTab() {
  const [q, setQ] = useState("");
  const [lang, setLang] = useState("en");
  const term = useDebounced(q.trim(), 250);
  const catalog = useCatalog(term, { language: lang, limit: 100 });
  return (
    <Panel>
      <PanelHeader
        title="Product catalogue"
        description="In the editor, a product fills the description, specification and unit. Its price stays empty; the last known price is dated guidance only."
        actions={
          <Segmented
            label="Catalogue language"
            value={lang}
            onChange={setLang}
            options={[
              { value: "en", label: "English" },
              { value: "ar", label: "Arabic" },
            ]}
          />
        }
      />
      <div className="px-5 pt-4">
        <SearchInput value={q} onChange={setQ} placeholder="Search products in English or Arabic" label="Search the catalogue" />
      </div>
      <div className="pt-4">
        <QueryState
          query={catalog}
          loading={<LoadingRows rows={4} />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            term ? (
              <EmptyState compact title="Nothing matches">
                Try another product name or alias.
              </EmptyState>
            ) : (
              <EmptyState icon={<BookOpen />} title="No catalogue installed">
                The catalogue is private company data. Put its JSON file in the private folder, under catalog/, and the products
                appear here and in the editor.
              </EmptyState>
            )
          }
        >
          {(d) => (
            <>
              <div className="hidden border-t border-line lg:block">
                <Table>
                  <THead>
                    <tr>
                      <TH>Product</TH>
                      <TH>Unit</TH>
                      <TH>Priced per</TH>
                      <TH>Offered as</TH>
                      <TH>Last known price</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {d.items.map((it) => (
                      <TR key={it.product_id}>
                        <TD className="max-w-md">
                          <p dir={isRtl(it.description) ? "rtl" : "auto"} className="font-medium text-ink">
                            {it.description}
                          </p>
                          {it.spec ? (
                            <p dir={isRtl(it.spec) ? "rtl" : "auto"} className="line-clamp-2 text-sm text-ink-3">
                              {it.spec}
                            </p>
                          ) : null}
                        </TD>
                        <TD className="whitespace-nowrap text-ink-2">{it.unit}</TD>
                        <TD className="whitespace-nowrap text-ink-2">{it.price_unit ?? "—"}</TD>
                        <TD className="text-sm text-ink-2">{it.transactions.map(humanize).join(", ") || "—"}</TD>
                        <TD className="max-w-72 text-sm text-ink-3">
                          {it.price_hint ? (
                            <span className="flex items-start gap-1">
                              <History className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              <span dir={isRtl(it.price_hint.text) ? "rtl" : "auto"}>{it.price_hint.text}</span>
                            </span>
                          ) : (
                            "None on record"
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <ul className="space-y-3 px-4 pb-4 lg:hidden">
                {d.items.map((it) => (
                  <li key={it.product_id}>
                    <ListRow title={<span dir={isRtl(it.description) ? "rtl" : "auto"}>{it.description}</span>} subtitle={it.spec ?? undefined}>
                      <p>
                        Unit {it.unit}
                        {it.price_unit ? ` · priced per ${it.price_unit}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-ink-3">{it.price_hint ? it.price_hint.text : "No earlier price on record."}</p>
                    </ListRow>
                  </li>
                ))}
              </ul>
            </>
          )}
        </QueryState>
      </div>
    </Panel>
  );
}
