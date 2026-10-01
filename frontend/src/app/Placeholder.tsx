import { Construction } from "lucide-react";
import { EmptyState, Page } from "@/ui";

/** Temporary route target while a screen is being built. */
export function Placeholder({ title }: { title: string }) {
  return (
    <Page>
      <EmptyState icon={<Construction />} title={title}>
        This screen is being built.
      </EmptyState>
    </Page>
  );
}
