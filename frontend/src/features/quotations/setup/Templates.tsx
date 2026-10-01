/**
 * Templates (mockup 25): the official templates, which languages are offered, and per-language
 * wording overrides (introduction, terms, exclusions, price unit, closing) next to a live preview.
 */
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, FileText } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "@/api/client";
import { useCategoryLabel, useWorkspace } from "@/api/session";
import { cn } from "@/lib/cn";
import { isRtl } from "@/lib/format";
import { requestKindLabel, workTypeLabel } from "@/lib/labels";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  ListRow,
  LoadingRows,
  Panel,
  PanelBody,
  PanelHeader,
  QueryState,
  Segmented,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Textarea,
  TR,
  toast,
} from "@/ui";
import { useInvalidate, useTemplates, type TemplateInfo, type TemplateOverrides, type Term } from "../api";
import { ExplainedError, Reason, TemplatePreview } from "../components";
import { languageLabel, PRICE_TERMS, templateDefaults, useRoleGate } from "../lib";

const SETUP = "/quotations/setup/templates";

function overrideCount(o: TemplateOverrides | undefined | null): number {
  if (!o) return 0;
  return (["intro", "terms", "exclusions", "price_unit", "closing"] as const).filter((k) => {
    const v = o[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  }).length;
}

function usedFor(t: TemplateInfo, familyLabel: (k: string) => string): string {
  const a = t.applies_to ?? {};
  const kinds = [...(a.work_types ?? []).map(workTypeLabel), ...(a.request_kinds ?? []).map(requestKindLabel)];
  const fam = a.service_families ?? [];
  const famText = fam.length > 3 ? `${fam.slice(0, 3).map(familyLabel).join(", ")} +${fam.length - 3}` : fam.map(familyLabel).join(", ");
  return [kinds.join(", "), famText].filter(Boolean).join(" · ") || "Any project";
}

function LanguageStates({ t }: { t: TemplateInfo }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {t.languages.map((lang) => {
        const row = t.settings?.[lang];
        const on = row?.enabled !== false;
        const n = overrideCount(row?.overrides);
        return (
          <Chip key={lang} tone={on ? "neutral" : "muted"} size="sm">
            {languageLabel(lang)}
            {on ? "" : " · off"}
            {n ? ` · ${n} ${n === 1 ? "override" : "overrides"}` : ""}
          </Chip>
        );
      })}
    </div>
  );
}

export function TemplatesTab() {
  const templates = useTemplates();
  const familyLabel = useCategoryLabel();
  return (
    <QueryState
      query={templates}
      loading={
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      }
      isEmpty={(d) => d.length === 0}
      empty={
        <Panel>
          <EmptyState icon={<FileText />} title="No templates installed">
            The official templates ship with the application. Restart the local server if this list stays empty.
          </EmptyState>
        </Panel>
      }
    >
      {(list) => (
        <>
          <Panel className="hidden lg:block">
            <PanelHeader
              title="Official templates"
              description="Each template prints the company's own wording. Turn a language off to stop offering it, or adjust its wording."
            />
            <Table>
              <THead>
                <tr>
                  <TH>Template</TH>
                  <TH>Used for</TH>
                  <TH>Languages</TH>
                  <TH>Layout</TH>
                  <TH>
                    <span className="sr-only">Action</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {list.map((t) => (
                  <TR key={t.key}>
                    <TD>
                      <p className="font-medium text-ink">{t.label.en}</p>
                      {t.label.ar ? (
                        <p dir="rtl" className="text-left text-sm text-ink-3">
                          {t.label.ar}
                        </p>
                      ) : null}
                    </TD>
                    <TD className="max-w-80 text-sm text-ink-2">{usedFor(t, familyLabel)}</TD>
                    <TD>
                      <LanguageStates t={t} />
                    </TD>
                    <TD className="whitespace-nowrap text-sm text-ink-2">
                      {t.layout === "letter" ? "Cover letter" : "Quotation pages"}
                      <p className="text-ink-3">{t.show_total ? "Prints a total" : "No total row"}</p>
                    </TD>
                    <TD className="text-right">
                      <Button variant="secondary" size="sm" asChild>
                        <Link to={`${SETUP}/${t.key}`}>Edit wording</Link>
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="space-y-3 lg:hidden">
            {list.map((t) => (
              <li key={t.key}>
                <ListRow to={`${SETUP}/${t.key}`} title={t.label.en} subtitle={usedFor(t, familyLabel)}>
                  <LanguageStates t={t} />
                </ListRow>
              </li>
            ))}
          </ul>
        </>
      )}
    </QueryState>
  );
}

export function TemplateEditor() {
  const { key = "" } = useParams();
  const templates = useTemplates();
  const [lang, setLang] = useState("en");
  const back = (
    <Link to={SETUP} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-3 hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden />
      All templates
    </Link>
  );
  if (templates.isLoading)
    return (
      <Panel>
        <LoadingRows rows={5} />
      </Panel>
    );
  if (templates.isError)
    return (
      <Panel>
        <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
      </Panel>
    );
  const t = templates.data?.find((x) => x.key === key);
  if (!t)
    return (
      <div className="space-y-4">
        {back}
        <Panel>
          <EmptyState title="Template not found">This template is not installed. Choose one from the list.</EmptyState>
        </Panel>
      </div>
    );
  const language = t.languages.includes(lang) ? lang : "en";
  return (
    <div className="space-y-5">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-ink">{t.label.en}</h2>
          <p className="text-sm text-ink-3">
            {t.layout === "letter" ? "Cover letter" : "Quotation pages"} · {t.show_total ? "prints a total" : "no total row"}
          </p>
        </div>
        {t.languages.length > 1 ? (
          <Segmented
            label="Template language"
            value={language}
            onChange={setLang}
            options={t.languages.map((l) => ({ value: l, label: languageLabel(l) }))}
          />
        ) : null}
      </div>
      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
        <TemplateSettings key={`${t.key}:${language}`} t={t} lang={language} />
        <Panel>
          <PanelHeader title="Preview" description="A sample project and customer, with the template's built-in wording." />
          <PanelBody>
            <TemplatePreview templateKey={t.key} language={language} />
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

function asText(v: unknown, sep = "\n\n"): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(sep);
  return "";
}

function TemplateSettings({ t, lang }: { t: TemplateInfo; lang: string }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const denied = useRoleGate()("admin", "Editing templates");
  const copy = t.copy[lang] ?? t.copy.en;
  const def = templateDefaults(t, lang, ws.currency);
  const row = t.settings?.[lang] ?? null;
  const ov: TemplateOverrides = row?.overrides ?? {};
  const rtl = lang === "ar";
  const dir = rtl ? "rtl" : undefined;

  const initial = {
    enabled: row?.enabled !== false,
    intro: asText(ov.intro),
    terms: Object.fromEntries((Array.isArray(ov.terms) ? ov.terms : []).map((x: Term) => [x.key, x.text ?? ""])) as Record<string, string>,
    exclusions: asText(ov.exclusions, "\n"),
    priceUnit: typeof ov.price_unit === "string" ? ov.price_unit : "",
    closing: asText(ov.closing),
  };
  const [f, setF] = useState(initial);
  const norm = (x: typeof initial) =>
    JSON.stringify({ ...x, terms: Object.entries(x.terms).filter(([, v]) => v.trim()).sort(([a], [b]) => a.localeCompare(b)) });
  const dirty = norm(f) !== norm(initial);

  const save = useMutation({
    mutationFn: () => {
      const terms = def.terms
        .filter((x) => !PRICE_TERMS.has(x.key) && (f.terms[x.key] ?? "").trim())
        .map((x) => ({ key: x.key, label: x.label, text: f.terms[x.key].trim() }));
      const exclusions = f.exclusions
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return api.put(`/templates/${t.key}/${lang}`, {
        enabled: f.enabled,
        overrides: {
          intro: f.intro.trim() || null,
          terms: terms.length ? terms : null,
          exclusions: exclusions.length ? exclusions : null,
          price_unit: f.priceUnit || null,
          closing: f.closing.trim() || null,
        },
      });
    },
    onSuccess: async () => {
      toast.success(`${t.label.en} (${languageLabel(lang)}) saved`);
      await invalidate(["templates"]);
    },
  });

  const area = (label: string, value: string, set: (v: string) => void, placeholder: string, id: string, rows = 3, hint?: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        disabled={Boolean(denied)}
        dir={dir ?? (isRtl(value || placeholder) ? "rtl" : "auto")}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Field>
  );

  return (
    <Panel>
      <PanelHeader
        title={`${languageLabel(lang)} wording`}
        description="Leave a field empty to keep the template's own wording, shown greyed in the field."
      />
      <PanelBody className="space-y-5">
        <Switch
          checked={f.enabled}
          disabled={Boolean(denied)}
          onChange={(v) => setF({ ...f, enabled: v })}
          label={`Offer this template in ${languageLabel(lang)}`}
          description="Off: new quotations cannot use it in this language, and drafting picks another template and says why. Existing quotations keep it."
        />
        {area("Introduction", f.intro, (v) => setF({ ...f, intro: v }), def.intro.join("\n\n"), "tpl-intro", 4, "Separate paragraphs with an empty line.")}

        <fieldset className="space-y-4">
          <legend className="text-sm font-medium text-ink">Terms</legend>
          {def.terms.length === 0 ? <p className="text-sm text-ink-3">This template has no default terms.</p> : null}
          {def.terms.map((term) =>
            PRICE_TERMS.has(term.key) ? (
              <div key={term.key}>
                <p className="text-sm font-medium text-ink">{term.label}</p>
                <p className="text-sm text-ink-3">Filled in by a person on each quotation. A template never carries a price.</p>
              </div>
            ) : (
              <div key={term.key}>
                {area(
                  term.label,
                  f.terms[term.key] ?? "",
                  (v) => setF({ ...f, terms: { ...f.terms, [term.key]: v } }),
                  term.text ?? "Filled in by a person",
                  `tpl-term-${term.key}`,
                  2,
                )}
              </div>
            ),
          )}
        </fieldset>

        {area(
          "Exclusions",
          f.exclusions,
          (v) => setF({ ...f, exclusions: v }),
          def.exclusions.join("\n") || "No default exclusions",
          "tpl-exclusions",
          4,
          "One exclusion per line.",
        )}

        <Field label="Default price unit" htmlFor="tpl-price-unit">
          <Select
            id="tpl-price-unit"
            value={f.priceUnit}
            disabled={Boolean(denied)}
            placeholder={`Template default (${copy?.default_price_unit ?? "—"})`}
            options={(copy?.price_units ?? []).map((u) => ({ value: u, label: u }))}
            onChange={(e) => setF({ ...f, priceUnit: e.target.value })}
          />
        </Field>

        {area("Closing", f.closing, (v) => setF({ ...f, closing: v }), def.closing.join("\n\n"), "tpl-closing", 2)}

        <div className={cn("flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between")}>
          <Reason>{denied ?? (dirty ? null : "No changes to save.")}</Reason>
          <div className="flex gap-2">
            {dirty ? (
              <Button variant="ghost" onClick={() => setF(initial)} disabled={save.isPending}>
                Undo changes
              </Button>
            ) : null}
            <Button onClick={() => save.mutate()} disabled={!dirty || Boolean(denied)} loading={save.isPending} className="max-sm:flex-1">
              Save {languageLabel(lang)} wording
            </Button>
          </div>
        </div>
        <ExplainedError error={save.error} />
      </PanelBody>
    </Panel>
  );
}
