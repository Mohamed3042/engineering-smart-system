import { KeyValue, Panel, PanelBody, PanelHeader } from "@/ui";
import { FLOOR } from "../policy";
import { pct, taskLabel } from "../vocab";

interface Group {
  task: string;
  cases: number;
  checks: string[];
}

/**
 * The 18 cases of the qualification exam, grouped by task (backend/ess/ai/exam_cases.py). They are invented
 * enquiries, documents and a drawing; nothing from the workspace's own mail is used.
 */
const GROUPS: Group[] = [
  {
    task: "classify_email",
    cases: 5,
    checks: [
      "A tender request in English and a window-cleaning request in Arabic are customer enquiries.",
      "A supplier's sales pitch is not an enquiry.",
      "An invoice goes to bills; a newsletter with an unsubscribe link goes to promotions.",
    ],
  },
  {
    task: "extract_request",
    cases: 7,
    checks: [
      "Facts, deadline and requirements, each with the sentence it came from.",
      "Arabic requests: Arabic-Indic digits and Arabic quotes copied exactly.",
      "Deadline changes: a deadline extension is reported as old date to new date; an addendum changes only what it says.",
      "Missing information stays empty and becomes a question, never a guess.",
      "Evidence trap: every quote must appear word for word in the source.",
      "A mixed scope (hoist and cradles together) keeps both.",
    ],
  },
  {
    task: "analyze_document",
    cases: 2,
    checks: ["A drawing's title block and notes from its text layer.", "A bill of quantities: exact quantities, and empty rate columns stay empty."],
  },
  { task: "analyze_drawing", cases: 1, checks: ["A drawing image: reads the title block and never guesses a dimension that is hidden."] },
  { task: "draft_quotation", cases: 1, checks: ["Price trap: a competitor's price sits in the project, and the draft must still contain no prices."] },
  { task: "research_customer", cases: 1, checks: ["Cited, verbatim sources, and a look-alike company is not mixed in."] },
  { task: "discover_business", cases: 1, checks: ["Your own documents outrank received mail and web pages as proof of what you do."] },
];

const TOTAL = GROUPS.reduce((n, g) => n + g.cases, 0);

/** What the exam is, what passes it, and what each group of cases looks for. */
export function ExamExplainer({ minScore, maxAgeDays }: { minScore?: number; maxAgeDays?: number }) {
  const score = Math.max(minScore ?? FLOOR.minScore, FLOOR.minScore);
  const days = Math.min(maxAgeDays ?? FLOOR.maxExamAgeDays, FLOOR.maxExamAgeDays);
  return (
    <Panel>
      <PanelHeader
        title={`The qualification exam: ${TOTAL} cases`}
        description="Every model takes it before it can work here, and this app scores the answers."
      />
      <PanelBody className="space-y-6">
        <KeyValue
          labelWidth="md"
          items={[
            { label: "The cases", value: "Made-up companies, enquiries, documents and a drawing. Nothing from your mail is used." },
            {
              label: "Pass mark",
              value: `A score of at least ${pct(score)} and no critical failure. A result is valid for ${days} days, and until the exam itself changes.`,
            },
            {
              label: "Critical failure",
              value: "An invented value or price, a quote that is not in the source, or a wrong enquiry decision. One fails the exam, whatever the score.",
            },
          ]}
        />

        <ol className="divide-y divide-line rounded-lg border border-line">
          {GROUPS.map((g) => (
            <li key={g.task} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="font-semibold text-ink">{taskLabel(g.task)}</p>
                <p className="text-sm text-ink-3 tabular">{g.cases === 1 ? "1 case" : `${g.cases} cases`}</p>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                {g.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className="text-sm text-ink-3">
          Results are signed by this installation. A result that was typed in by hand, or taken before the exam last changed, is ignored. Run the exam on
          the AI engine page.
        </p>
      </PanelBody>
    </Panel>
  );
}
