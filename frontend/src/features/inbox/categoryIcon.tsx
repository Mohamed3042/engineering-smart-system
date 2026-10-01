import {
  AppWindow,
  ArrowUpFromLine,
  Bell,
  Briefcase,
  Building2,
  Construction,
  Forklift,
  Grid3x3,
  Inbox,
  Mail,
  Megaphone,
  Network,
  Receipt,
  Rows3,
  Store,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useCategories } from "@/api/session";

/** Category.icon holds a lucide icon name; only the ones the workspace uses are bundled. */
const ICONS: Record<string, LucideIcon> = {
  "building-2": Building2,
  "app-window": AppWindow,
  "rows-3": Rows3,
  "arrow-up-from-line": ArrowUpFromLine,
  construction: Construction,
  forklift: Forklift,
  "grid-3x3": Grid3x3,
  network: Network,
  briefcase: Briefcase,
  store: Store,
  receipt: Receipt,
  megaphone: Megaphone,
  users: Users,
  bell: Bell,
  inbox: Inbox,
  mail: Mail,
  tag: Tag,
};

export function iconFor(name?: string | null): LucideIcon {
  return (name && ICONS[name]) || Tag;
}

/** key → icon component for a category / service family. */
export function useCategoryIcon(): (key: string | null | undefined) => LucideIcon {
  const { data } = useCategories();
  return useMemo(() => {
    const map = new Map((data ?? []).map((c) => [c.key, c.icon]));
    return (key) => iconFor(key ? map.get(key) : null);
  }, [data]);
}
