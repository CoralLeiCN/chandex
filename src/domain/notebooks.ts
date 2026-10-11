export const fold = (value: string) => value.normalize("NFC").toLowerCase();
export const NOTEBOOK_TITLE_LIMIT = 200;
export const NOTEBOOK_INSTRUCTIONS_LIMIT = 100000;
export function notebookInstructions(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Array.from(value).length > NOTEBOOK_INSTRUCTIONS_LIMIT
  )
    throw new Error(
      `Notebook instructions must be text of at most ${NOTEBOOK_INSTRUCTIONS_LIMIT} characters.`,
    );
  return value;
}
function field(value: unknown, label: string, max: number, required = false) {
  if (typeof value !== "string" || /[\0]/.test(value))
    throw new Error(`${label} must be text of at most ${max} characters.`);
  const normalized = value.normalize("NFC").trim();
  if (Array.from(normalized).length > max)
    throw new Error(`${label} must be text of at most ${max} characters.`);
  if (required && !normalized) throw new Error(`${label} is required.`);
  return normalized;
}
export function notebookTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new Error("Use at most 10 notebook tags.");
  const seen = new Set<string>();
  return value
    .map((v) => field(v, "Tag", 48, true))
    .filter((tag) => {
      if (/[\r\n\t]/.test(tag))
        throw new Error("Tags must be single-line labels.");
      const key = fold(tag);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function starterQuestions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Use at most eight starter questions.");
  const questions = value.map((q) => field(q, "Starter question", 1000, true));
  if (questions.some((q) => /[\r\n]/.test(q)))
    throw new Error("Starter questions must be single-line text.");
  return [...new Set(questions)];
}
export interface NotebookRecipe {
  title: string;
  description: string;
  instructions: string;
  tags: string[];
  questions: string[];
}
export interface NotebookTemplate extends NotebookRecipe {
  id: string;
  version: number;
  builtin: boolean;
  created?: string;
  updated?: string;
}
export function recipe(value: unknown): NotebookRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A notebook template recipe is required.");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        !["title", "description", "instructions", "tags", "questions"].includes(
          k,
        ),
    )
  )
    throw new Error(
      "Templates may contain only settings and starter questions.",
    );
  return {
    title: field(v.title, "Template name", NOTEBOOK_TITLE_LIMIT, true),
    description: field(v.description ?? "", "Description", 500),
    instructions: field(
      v.instructions ?? "",
      "Instructions",
      NOTEBOOK_INSTRUCTIONS_LIMIT,
    ),
    tags: notebookTags(v.tags ?? []),
    questions: starterQuestions(v.questions ?? []),
  };
}
export const builtinTemplates: readonly NotebookTemplate[] = [
  {
    id: "builtin-comparison",
    version: 1,
    builtin: true,
    title: "Compare sources",
    description:
      "Compare claims, qualifications and disagreements across selected evidence.",
    instructions:
      "Compare the selected sources carefully. Attribute conflicting statements to their sources, preserve qualifiers, distinguish inference from fact and make missing evidence explicit.",
    tags: ["Comparison"],
    questions: [
      "Where do the selected sources agree and disagree?",
      "What qualifications or evidence gaps affect the comparison?",
    ],
  },
  {
    id: "builtin-study",
    version: 1,
    builtin: true,
    title: "Study a topic",
    description:
      "Learn concepts from cited explanations and check what remains unclear.",
    instructions:
      "Explain the selected evidence in clear language for a learner. Define supported terms, connect concepts with citations and identify unresolved questions. Do not fill evidence gaps from general knowledge.",
    tags: ["Study"],
    questions: [
      "What are the key concepts and how do they relate?",
      "What should I study next based on the gaps in these sources?",
    ],
  },
  {
    id: "builtin-decision",
    version: 1,
    builtin: true,
    title: "Research a decision",
    description:
      "Assess alternatives and conditional claims without inventing a recommendation.",
    instructions:
      "Assess alternatives using the selected sources. Separate stated facts, assumptions and labeled inferences. Preserve costs, units, conditions and uncertainty; identify what additional evidence a decision needs.",
    tags: ["Decision"],
    questions: [
      "What alternatives and tradeoffs are supported by these sources?",
      "What information is missing before a decision can be made?",
    ],
  },
];
export interface DiscoveryResult {
  kind: "notebook" | "source" | "passage" | "note";
  id: string;
  notebookId: string;
  notebookTitle: string;
  archived: number;
  title: string;
  snippet: string;
  locator: string | null;
  revisionId: string | null;
}
