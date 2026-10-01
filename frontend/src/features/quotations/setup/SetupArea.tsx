/**
 * /quotations/setup/* — official templates and their per-language overrides, the template rules
 * that choose them, company papers, signatories (with signature import), stamp and letterhead
 * images, and the product catalogue.
 */
import { Navigate, Route, Routes } from "react-router";
import { LinkTabs, Page, PageHeader } from "@/ui";
import { CatalogTab, LetterheadTab, PapersTab } from "./Assets";
import { RulesTab } from "./Rules";
import { SignatoriesTab } from "./Signatories";
import { TemplateEditor, TemplatesTab } from "./Templates";

const BASE = "/quotations/setup";

export function SetupArea() {
  return (
    <Page>
      <PageHeader
        back={{ to: "/quotations", label: "Quotations" }}
        title="Quotation setup"
        meta="Templates and the rules that choose them, company paper, signatories, stamp and catalogue."
      />
      <LinkTabs
        label="Quotation setup"
        className="mb-6"
        tabs={[
          { to: `${BASE}/templates`, label: "Templates" },
          { to: `${BASE}/rules`, label: "Template rules" },
          { to: `${BASE}/papers`, label: "Papers" },
          { to: `${BASE}/signatories`, label: "Signatories" },
          { to: `${BASE}/letterhead`, label: "Stamp & letterhead" },
          { to: `${BASE}/catalog`, label: "Catalogue" },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to={`${BASE}/templates`} replace />} />
        <Route path="templates" element={<TemplatesTab />} />
        <Route path="templates/:key" element={<TemplateEditor />} />
        <Route path="rules" element={<RulesTab />} />
        <Route path="papers" element={<PapersTab />} />
        <Route path="signatories" element={<SignatoriesTab />} />
        <Route path="letterhead" element={<LetterheadTab />} />
        <Route path="catalog" element={<CatalogTab />} />
        <Route path="*" element={<Navigate to={`${BASE}/templates`} replace />} />
      </Routes>
    </Page>
  );
}
