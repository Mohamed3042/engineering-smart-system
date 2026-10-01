/**
 * Company assets for the PDF: installed papers (full letterhead or pre-printed body only), the
 * default paper's header / footer / stamp / watermark images, and the private product catalogue.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, CircleAlert, FileText, History, Minus, Star, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { sessionKey } from "@/api/session";
import { humanize, isRtl } from "@/lib/format";
import {
  Banner,
  Button,
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
  toastError,
} from "@/ui";
import { useCatalog, useInvalidate, useLetterhead, usePapers, type LetterheadAsset, type LetterheadStatus, type Paper } from "../api";
import { Disclosure, ExplainedError, FileButton, PaperSchematic, Reason } from "../components";
import { useDebounced } from "../editor/LineTools";
import { useNarrow } from "../editor/sections";
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

/** What is missing on a paper, in one short sentence (empty when it is complete). */
function missingText(p: Paper): string {
  if (p.complete) return "";
  const gone = [p.files.header ? null : "header", p.files.footer ? null : "footer"].filter(Boolean).join(" and ");
  return `No ${gone}: PDFs on this paper print on the neutral specimen letterhead.`;
}

export function PapersTab() {
  const papers = usePapers();
  const invalidate = useInvalidate();
  const narrow = useNarrow();
  const denied = useRoleGate()("admin", "Changing the default paper");
  const makeDefault = useMutation({
    mutationFn: (p: Paper) => api.patch("/workspace", { settings: { quotations: { default_paper_id: p.id } } }),
    onSuccess: async (_data, p) => {
      toast.success(`Default paper: ${p.name}`, { description: "New quotations print on it. A quotation that chose its own paper keeps it." });
      await invalidate(["papers"], sessionKey);
    },
    onError: (e) => toastError(e, "The default paper was not changed"),
  });

  return (
    <Panel>
      <PanelHeader
        title="Papers"
        description={
          <>
            The default paper is what new quotations print on.
            <span className="max-sm:hidden"> A template rule or a quotation can choose another.</span>
          </>
        }
      />
      {denied ? <Reason className="px-5 pt-3">{denied}</Reason> : null}
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
        {(d) => {
          // The default comes first, so it is the first thing on a phone.
          const items = [...d.items].sort((a, b) => Number(b.id === d.default) - Number(a.id === d.default));
          const lost = d.default && !d.items.some((p) => p.id === d.default);
          return (
            <>
              {lost ? (
                <div className="px-5 pt-4">
                  <Banner tone="review" title="The default paper is not installed">
                    "{d.default}" is the default but its folder is gone. Make one of these papers the default.
                  </Banner>
                </div>
              ) : null}
              <ul className="divide-y divide-line">
                {items.map((p) => {
                  const isDefault = p.id === d.default;
                  const pre = p.mode === "preprinted";
                  const only = d.items.length === 1;
                  const loading = makeDefault.isPending && makeDefault.variables?.id === p.id;
                  const action = isDefault ? null : (
                    <Button
                      variant="secondary"
                      size={narrow ? "md" : "sm"}
                      icon={<Star />}
                      onClick={() => makeDefault.mutate(p)}
                      loading={loading}
                      disabled={Boolean(denied) || makeDefault.isPending}
                      aria-label={`Make default: ${p.name}`}
                      className="max-sm:w-full"
                    >
                      Make default
                    </Button>
                  );
                  const details = (
                    <>
                      <p className="text-sm text-ink-2">
                        {paperModeLabel(p.mode)}:{" "}
                        {pre ? "prints the body only, on white, for the company's own printed paper." : "prints the header and footer with the text."}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {!pre ? <FileChip label="Header" present={Boolean(p.files.header)} /> : null}
                        {!pre ? <FileChip label="Footer" present={Boolean(p.files.footer)} /> : null}
                        <FileChip label="Stamp" present={Boolean(p.files.stamp)} />
                        <FileChip label="Watermark" present={Boolean(p.files.watermark)} />
                      </div>
                      <p className="text-sm text-ink-3">
                        <span className="font-mono text-xs">{p.id}</span>
                        {p.company_name ? ` · ${p.company_name}` : ""}
                      </p>
                    </>
                  );
                  return (
                    <li key={p.id} className={isDefault ? "bg-brand-soft/30 px-4 py-4 sm:px-5" : "px-4 py-4 sm:px-5"}>
                      <div className="flex items-start gap-4">
                        <div className="w-14 shrink-0 sm:w-24">
                          <PaperSchematic mode={p.mode} files={p.files} label={`${p.name}: ${paperModeLabel(p.mode)}`} />
                        </div>
                        <div className="min-w-0 flex-1 space-y-2">
                          <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                            {p.name}
                            {isDefault ? (
                              <Chip size="sm" tone="brand" icon={<Star aria-hidden />}>
                                Default
                              </Chip>
                            ) : null}
                            {!p.complete ? (
                              <Chip size="sm" tone="review" icon={<CircleAlert aria-hidden />}>
                                Incomplete
                              </Chip>
                            ) : null}
                          </p>
                          <p className="text-sm text-ink-3">
                            {/* On desktop the mode is spelled out in the details below. */}
                            {narrow ? `${paperModeLabel(p.mode)} · ` : ""}
                            {p.languages.length ? p.languages.map(languageLabel).join(", ") : "All languages"}
                          </p>
                          {!p.complete ? <p className="text-sm text-review">{missingText(p)}</p> : null}
                          {p.warnings.map((w) => (
                            <p key={w} className="text-sm text-review">
                              {w}
                            </p>
                          ))}
                          {isDefault && only ? <p className="text-sm text-ink-3">The only paper installed, so it is the default.</p> : null}
                          {narrow ? null : details}
                        </div>
                        {narrow ? null : <div className="shrink-0">{action}</div>}
                      </div>
                      {narrow ? (
                        <div className="mt-3 space-y-2">
                          {action}
                          <Disclosure title="Files and details">{details}</Disclosure>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          );
        }}
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
  const narrow = useNarrow();
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
          {(lh) => {
            const state = (a: (typeof ASSETS)[number]) => {
              const file = lh.assets[a.key];
              return file ? (
                <Chip size="sm" tone="brand" icon={<Check aria-hidden />}>
                  Installed
                </Chip>
              ) : (
                <Chip size="sm" tone={a.key === "header" || a.key === "footer" ? "review" : "muted"} icon={<Minus aria-hidden />}>
                  Not installed
                </Chip>
              );
            };
            const button = (a: (typeof ASSETS)[number], size: "sm" | "md") => {
              const file = lh.assets[a.key];
              return (
                <FileButton
                  accept="image/png,image/jpeg"
                  icon={<Upload />}
                  size={size}
                  disabled={Boolean(denied) || upload.isPending}
                  loading={upload.isPending && upload.variables?.asset === a.key}
                  onFile={(f) => (file ? setReplacing({ asset: a.key, file: f }) : upload.mutate({ asset: a.key, file: f }))}
                  className="max-sm:shrink-0"
                >
                  {file ? "Replace" : "Upload"}
                </FileButton>
              );
            };
            const errorNote = upload.error && !replacing ? <ExplainedError error={upload.error} /> : null;

            if (narrow)
              // Phones: what is installed (the page preview and one line) first, the four upload rows next,
              // explanations and the folder path folded away.
              return (
                <div className="space-y-4 px-4 py-4">
                  <div className="flex items-start gap-4">
                    <div className="w-24 shrink-0">
                      <PaperSchematic
                        files={{ header: Boolean(lh.assets.header), footer: Boolean(lh.assets.footer) }}
                        label="Which parts of the letterhead are installed"
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className={lh.complete ? "flex items-start gap-1.5 font-semibold text-brand-ink" : "flex items-start gap-1.5 font-semibold text-review"}>
                        {lh.complete ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
                        {lh.complete ? "Full letterhead installed" : "No full letterhead installed"}
                      </p>
                      <p className="text-sm text-ink-2">
                        {lh.complete ? "Header and footer are on file." : "Without a header and a footer, PDFs print on a neutral specimen letterhead."}
                      </p>
                      <p className="text-sm text-ink-3">Filled bands are installed, dashed bands are not. The stamp is placed on each quotation.</p>
                    </div>
                  </div>
                  <Reason>{denied}</Reason>
                  <ul className="divide-y divide-line border-y border-line">
                    {ASSETS.map((a) => (
                      <li key={a.key} className="flex items-center gap-3 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-ink">{a.label}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            {state(a)}
                            {lh.assets[a.key] ? <span className="font-mono text-xs text-ink-3">{lh.assets[a.key]}</span> : null}
                          </p>
                        </div>
                        {button(a, "md")}
                      </li>
                    ))}
                  </ul>
                  {errorNote}
                  <div>
                    <Disclosure title="What each image is for">
                      {ASSETS.map((a) => (
                        <p key={a.key} className="text-sm text-ink-2">
                          <span className="font-medium text-ink">{a.label}.</span> {a.text}
                        </p>
                      ))}
                    </Disclosure>
                    <Disclosure title="Where the files are kept">
                      <p className="break-all font-mono text-xs text-ink-3">{lh.private_dir}</p>
                    </Disclosure>
                  </div>
                </div>
              );

            return (
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
                              {state(a)}
                            </p>
                            <p className="text-sm text-ink-3">{a.text}</p>
                            {file ? <p className="font-mono text-xs text-ink-3">{file}</p> : null}
                          </div>
                          {button(a, "sm")}
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
                {errorNote}
                <p className="text-sm text-ink-3">
                  Private folder: <span className="break-all font-mono text-xs">{lh.private_dir}</span>
                </p>
              </div>
            );
          }}
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
