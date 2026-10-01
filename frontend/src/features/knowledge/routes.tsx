import { Navigate, type RouteObject } from "react-router";
import { DocumentsStep } from "@/features/setup/DocumentsStep";
import { IdentityStep } from "@/features/setup/IdentityStep";
import { LearningStep } from "@/features/setup/LearningStep";
import { ScopeStep } from "@/features/setup/ScopeStep";
import { KnowledgeLayout } from "./pages/KnowledgeLayout";
import { KnowledgeTab } from "./pages/KnowledgeTab";
import { LessonsPage } from "./pages/LessonsPage";

/** Children of /settings. `knowledge` is the tabbed Business knowledge area; `learning` is Learned corrections. */
export const knowledgeSettingsRoutes: RouteObject[] = [
  {
    path: "knowledge",
    element: <KnowledgeLayout />,
    children: [
      { index: true, element: <Navigate to="service-families" replace /> },
      { path: "service-families", element: <KnowledgeTab key="service_family" kind="service_family" /> },
      { path: "work-types", element: <KnowledgeTab key="work_type" kind="work_type" /> },
      { path: "terms", element: <KnowledgeTab key="term" kind="term" /> },
      { path: "standards", element: <KnowledgeTab key="standard" kind="standard" /> },
      { path: "conventions", element: <KnowledgeTab key="convention" kind="convention" /> },
    ],
  },
  { path: "learning", element: <LessonsPage /> },
];

/** Children of /setup */
export const knowledgeSetupRoutes: RouteObject[] = [
  { path: "documents", element: <DocumentsStep /> },
  { path: "scope", element: <ScopeStep /> },
  { path: "learning", element: <LearningStep /> },
  { path: "identity", element: <IdentityStep /> },
];
