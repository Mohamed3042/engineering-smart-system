import {
  Archive,
  BookOpen,
  Bot,
  CircleCheck,
  FileText,
  Folder,
  GraduationCap,
  House,
  Mail,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

/** Desktop sidebar: the seven standard destinations. */
export const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/inbox", label: "Inbox", icon: Mail },
  { to: "/projects", label: "Projects", icon: Folder },
  { to: "/quotations", label: "Quotations", icon: FileText },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Phone bottom bar: Home, Inbox, Projects, More. */
export const PHONE_TABS: NavItem[] = PRIMARY_NAV.slice(0, 3);

/** Phone "More" menu (workspace menu). */
export const MORE_NAV: NavItem[] = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/inbox", label: "Inbox", icon: Mail },
  { to: "/projects", label: "Projects", icon: Folder },
  { to: "/quotations", label: "Quotations", icon: FileText },
  { to: "/quotations/approvals", label: "Approvals", icon: CircleCheck },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/settings/knowledge", label: "Business knowledge", icon: BookOpen },
  { to: "/settings/connections", label: "Connections", icon: Plug },
  { to: "/settings/team", label: "Team", icon: UsersRound },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/projects/archive", label: "Archive", icon: Archive },
];

export interface SettingsNavGroup {
  title: string;
  items: NavItem[];
}

/** Settings sub-navigation. Each route is owned by one feature folder. */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    title: "Connections",
    items: [
      { to: "/settings/connections", label: "Mailbox & services", icon: Plug },
      { to: "/settings/ai", label: "AI engine", icon: Bot },
      { to: "/settings/ai-rules", label: "AI quality rules", icon: ShieldCheck },
    ],
  },
  {
    title: "Business",
    items: [
      { to: "/settings/knowledge", label: "Business knowledge", icon: BookOpen },
      { to: "/settings/learning", label: "Learned corrections", icon: GraduationCap },
      { to: "/quotations/setup", label: "Quotation setup", icon: FileText },
    ],
  },
  {
    title: "Workspace",
    items: [
      { to: "/settings/workspace", label: "Workspace", icon: Settings },
      { to: "/settings/team", label: "Team & permissions", icon: UsersRound },
      { to: "/settings/account", label: "Your account", icon: Users },
    ],
  },
];
