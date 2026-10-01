/** Shapes used by the settings screens (backend/ess/api/workspace.py, quotations.py /papers). */

/** GET /api/papers: one installed letterhead. */
export interface Paper {
  id: string;
  name: string;
  mode: string;
  company_name: string | null;
  languages: string[];
  source: string;
  files: Record<string, boolean>;
  complete: boolean;
  warnings: string[];
}

export interface PapersResponse {
  items: Paper[];
  default: string | null;
}

/** workspace.settings.quotations (the backend merges this group one level deep). */
export interface QuotationDefaults {
  default_language?: string;
  default_paper_id?: string | null;
  default_currency?: string;
  /** Drafts never carry the real signature and stamp unless this is on. */
  sign_drafts?: boolean;
  require_engineer_review?: boolean;
}

/** POST /api/workspace/import */
export interface ImportResult {
  counts: Record<string, number>;
  evidence: { checked: number; verified: number };
}

/** POST /api/workspaces */
export interface NewWorkspaceBody {
  name: string;
  company_name: string;
  primary_email: string;
  region: string;
  country: string;
  languages: string[];
  currency: string;
  timezone: string;
  owner_name: string;
}
