import type { SystemPrompt } from "../providers/types.js";
import { buildIdeSidecarInstructions } from "../sidecar/idePrompt.js";
import { buildSidecarInstructions } from "../sidecar/prompt.js";
import type { BuiltContext } from "./contextBuilder.js";

export interface BuildSystemPromptArgs {
  incomingSystem: string | undefined;
  beliefCtx: BuiltContext;
  extractionEnabled: boolean;
  injectionEnabled: boolean;
  activeScope: string | undefined;
  scopeAutoDetect: boolean;
  extractionMode?: "standard" | "ide";
  ideScope?: {
    projectScope: string | null;
    languageScope: string | null;
  } | null;
  teamMode?: boolean;
}

export function buildSystemPrompt(args: BuildSystemPromptArgs): SystemPrompt {
  const staticParts: string[] = [];

  if (args.extractionEnabled) {
    staticParts.push(
      "You have a secondary task: after your visible response, emit a hidden " +
        "metadata block recording beliefs about this user. While responding, " +
        "note facts the user would be frustrated to re-establish next session: " +
        "their preferences, decisions, project commitments, working principles, " +
        "and how they think and engage. " +
        "Respond fully first; the extraction format follows."
    );

    if (args.extractionMode === "ide" && args.ideScope) {
      staticParts.push(
        buildIdeSidecarInstructions({
          activeScope: args.activeScope,
          scopeAutoDetect: args.scopeAutoDetect,
          projectScope: args.ideScope.projectScope,
          languageScope: args.ideScope.languageScope
        })
      );
    } else {
      staticParts.push(
        buildSidecarInstructions({
          activeScope: args.activeScope,
          scopeAutoDetect: args.scopeAutoDetect
        })
      );
    }
  }

  if (args.injectionEnabled) {
    if (args.teamMode && args.beliefCtx.orgSummaryPrelude) {
      staticParts.push(
        "<org_summary>",
        args.beliefCtx.orgSummaryPrelude,
        "</org_summary>",
        "The <org_summary> block above describes organization standards and governance. Treat these as durable constraints."
      );
    }

    if (args.beliefCtx.personaPrelude) {
      staticParts.push(
        "<persona>",
        args.beliefCtx.personaPrelude,
        "</persona>"
      );
    }

    if (
      args.teamMode &&
      args.beliefCtx.teamBeliefsJson &&
      args.beliefCtx.teamBeliefsJson !== "[]"
    ) {
      staticParts.push(
        "<team_beliefs>",
        args.beliefCtx.teamBeliefsJson,
        "</team_beliefs>",
        "The <team_beliefs> block above describes working agreements for your team. Treat these as active constraints that shape implementation choices."
      );
    }

    staticParts.push(
      [
        "You have persistent memory of this user.",
        "The <persona> block above describes who they are and how they want to be engaged — standing context, not facts to quote.",
        "",
        "<pinned_facts> are standing constraints — treat them as hard requirements that shape every answer.",
        "<relevant_beliefs> are query-surfaced context — use them to disambiguate and inform, not as hard constraints.",
        "",
        "For each belief, the why_it_matters field is the primary action directive: it tells you what to change in your response.",
        "Beliefs with epistemic_status 'inferred' are system hypotheses — hold them loosely.",
        "Beliefs with epistemic_status 'exploratory' are unresolved — do not treat them as settled.",
        "Beliefs with confidence below 0.65 are low-certainty — weight them accordingly.",
        "Treat open questions as unresolved; do not invent closure."
      ].join("\n")
    );
  }

  const staticSection = staticParts.join("\n\n");

  const beliefsSection = args.injectionEnabled
    ? [
        "<pinned_facts>",
        args.beliefCtx.pinnedFactsJson,
        "</pinned_facts>"
      ].join("\n")
    : "";

  const dynamicParts: string[] = [];

  if (args.injectionEnabled) {
    dynamicParts.push(
      [
        "<relevant_beliefs>",
        args.beliefCtx.relevantBeliefsJson,
        "</relevant_beliefs>",
        "",
        "### Open Questions",
        args.beliefCtx.openQuestionsJson
      ].join("\n")
    );
  }

  if (args.incomingSystem) {
    dynamicParts.push(args.incomingSystem.trim());
  }

  dynamicParts.push(
    args.extractionEnabled
      ? "--- Respond to the user's message. After your complete, visible response, append the sidecar block. ---"
      : "--- Respond to the user's message. ---"
  );

  return {
    static: staticSection,
    beliefs: beliefsSection,
    dynamic: dynamicParts.join("\n\n")
  };
}
