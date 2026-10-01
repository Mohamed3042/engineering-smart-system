import { Network, Plug } from "lucide-react";
import type { ReactNode } from "react";
import { Banner, ChoiceCards, Chip } from "@/ui";

export type EngineMethod = "api" | "mcp";

/** "Connect using API" or "Connect using MCP" (state 02). */
export function EngineMethodChooser({
  value,
  onChange,
  current,
  rulesNote = true,
}: {
  value: EngineMethod;
  onChange: (m: EngineMethod) => void;
  /** The method in use now, marked "In use". */
  current?: EngineMethod | null;
  rulesNote?: boolean;
}) {
  const inUse = (m: EngineMethod): ReactNode =>
    current === m ? (
      <Chip size="sm" tone="brand">
        In use
      </Chip>
    ) : null;
  return (
    <div className="space-y-4">
      <ChoiceCards
        label="How the AI engine connects"
        value={value}
        onChange={(v) => onChange(v as EngineMethod)}
        options={[
          {
            value: "api",
            icon: <Plug aria-hidden />,
            label: "Connect using API",
            badge: inUse("api"),
            description:
              "Use your own key from OpenAI, Anthropic, Google, Azure OpenAI or an OpenAI-compatible service. The app calls the model directly.",
          },
          {
            value: "mcp",
            icon: <Network aria-hidden />,
            label: "Connect using MCP",
            badge: inUse("mcp"),
            description:
              "An AI client such as Claude Desktop or Claude Code connects to this app and does the reading and drafting. No key is stored here.",
          },
        ]}
      />
      {rulesNote ? (
        <Banner title="The same rules apply to every model">
          Only models that meet the workspace rules and pass the qualification exam can work here. Light, deprecated or
          unsafe models are refused, through the API and through MCP. An engineer reviews everything before anything is sent.
        </Banner>
      ) : null}
    </div>
  );
}
