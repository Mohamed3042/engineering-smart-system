/**
 * URL contract between feature folders. Link with these helpers instead of writing paths by hand.
 */
import type { NextAction } from "@/api/types";

export type ProjectTab = "overview" | "enquiries" | "inputs" | "analysis" | "review" | "documents";

export const projectHref = (id: string, tab: ProjectTab = "overview") =>
  tab === "overview" ? `/projects/${id}` : `/projects/${id}/${tab}`;
/** Review one detected change (deadline amendment, addendum, technical revision). */
export const projectChangeHref = (id: string, index: number) => `/projects/${id}/changes/${index}`;
export const fileHref = (id: string, page?: number | null) => `/files/${encodeURIComponent(id)}${page ? `?page=${page}` : ""}`;
export const emailHref = (id: string) => `/inbox/${encodeURIComponent(id)}`;
export const quotationHref = (id: string) => `/quotations/${id}`;
export const quotationPreviewHref = (id: string) => `/quotations/${id}/preview`;
export const customerHref = (id: string, tab?: "projects" | "research" | "updates" | "opportunities") =>
  tab ? `/customers/${id}/${tab}` : `/customers/${id}`;
export const automationHref = (id: string) => `/automations/${id}`;
export const runHref = (id: string) => `/automations/runs/${id}`;

/** Where a project's next action is done. Kinds come from backend/ess/pipeline/state.py. */
export function nextActionHref(projectId: string, action: NextAction | null | undefined): string {
  switch (action?.kind) {
    case "review_change":
      return typeof action.change_index === "number" ? projectChangeHref(projectId, action.change_index) : projectHref(projectId);
    case "resolve_link":
      return `${projectHref(projectId, "inputs")}${action.link_id ? `?link=${action.link_id}` : ""}`;
    case "collect_files":
      return projectHref(projectId, "inputs");
    case "analyze":
    case "wait":
      return projectHref(projectId, "analysis");
    case "engineer_review":
      return projectHref(projectId, "review");
    case "prepare_quotation":
    case "send":
      return projectHref(projectId, "documents");
    case "follow_up":
      return projectHref(projectId, "enquiries");
    default:
      return projectHref(projectId);
  }
}
