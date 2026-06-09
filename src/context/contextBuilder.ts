import type { BeliefsReader } from "./beliefsReader.js";
import type { ScoredBelief } from "./beliefsReader.js";
import type { Belief } from "../types/belief.js";
import { buildSearchQuery } from "./queryExpander.js";

export type ProjectionMode = "rich" | "lean";

export interface ContextBudget {
  maxBeliefs: number;
  maxPinnedFacts: number;
  maxTeamBeliefs: number;
  maxUserBeliefs: number;
  maxQuestions: number;
  maxCharsPerBelief: number;
  maxPersonaChars: number;
  maxOrgSummaryChars: number;
  maxScopePreludeChars: number;
  projection: ProjectionMode;
  scoreDetails: boolean;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxBeliefs: 20,
  maxPinnedFacts: 10,
  maxTeamBeliefs: 5,
  maxUserBeliefs: 3,
  maxQuestions: 15,
  maxCharsPerBelief: 400,
  maxPersonaChars: 800,
  maxOrgSummaryChars: 600,
  maxScopePreludeChars: 400,
  projection: "lean",
  scoreDetails: false
};

export interface BeliefScore {
  id: string;
  score: number;
  scoreDetails?: unknown;
}

export interface OrgSummaryLookup {
  get(orgId: string): Promise<{ summary: string } | null>;
}

export interface BuiltContext {
  personaPrelude: string;
  pinnedFactsJson: string;
  orgSummaryPrelude: string;
  teamBeliefsJson: string;
  expandedQuery: string;
  queryWasNoisy: boolean;
  relevantBeliefsJson: string;
  openQuestionsJson: string;
  beliefCount: number;
  questionCount: number;
  truncated: boolean;
  searchScores: BeliefScore[];
  rawPinnedFacts: Belief[];
  rawRelevantBeliefs: Belief[];
  rawOpenQuestions: Belief[];
  rawTeamBeliefs: Belief[];
}

export interface PersonaLookup {
  get(userId: string): Promise<{
    universal?: string;
    per_scope?: Record<string, string>;
  } | null>;
}

export const EMPTY_CONTEXT: BuiltContext = {
  personaPrelude: "",
  orgSummaryPrelude: "",
  teamBeliefsJson: "[]",
  pinnedFactsJson: "[]",
  expandedQuery: "",
  queryWasNoisy: false,
  relevantBeliefsJson: "[]",
  openQuestionsJson: "[]",
  beliefCount: 0,
  questionCount: 0,
  truncated: false,
  searchScores: [],
  rawPinnedFacts: [],
  rawRelevantBeliefs: [],
  rawOpenQuestions: [],
  rawTeamBeliefs: []
};

export class ContextBuilder {
  private readonly budget: ContextBudget;

  constructor(
    private readonly reader: BeliefsReader,
    private readonly persona: PersonaLookup,
    private readonly orgSummary: OrgSummaryLookup,
    budget: Partial<ContextBudget> = {}
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async build(
    userId: string,
    scope: string[],
    query: string,
    agentId: string | null = null,
    teamId?: string,
    orgId?: string,
    ideMode = false
  ): Promise<BuiltContext> {
    const teamMode = !!(teamId && orgId);

    const { query: expandedQuery, wasNoisy: queryWasNoisy } =
      buildSearchQuery(query);

    const [personaDoc, pinnedFacts, questions] = await Promise.all([
      this.persona.get(userId),
      this.reader.listPinnedFacts(
        userId,
        scope,
        this.budget.maxPinnedFacts,
        new Set(),
        agentId
      ),
      this.reader.listPinnedOpenQuestions(
        userId,
        scope,
        this.budget.maxQuestions,
        agentId
      )
    ]);

    let teamBeliefs: Belief[] = [];
    let orgSummaryDoc: { summary: string } | null = null;

    if (teamMode) {
      [teamBeliefs, orgSummaryDoc] = await Promise.all([
        this.reader.listTeamBeliefs(
          teamId!,
          scope,
          this.budget.maxTeamBeliefs,
          agentId
        ),
        this.orgSummary.get(orgId!)
      ]);
    }

    const pinnedIds = new Set(pinnedFacts.map((b) => b._id));
    const teamIds = new Set(teamBeliefs.map((b) => b._id));
    const excludeIds = new Set([...pinnedIds, ...teamIds]);

    const userBeliefCap =
      teamMode && ideMode ? this.budget.maxUserBeliefs : this.budget.maxBeliefs;

    const rawSearchResults =
      expandedQuery && userBeliefCap > 0
        ? await this.reader.searchText(userId, expandedQuery, scope, {
            limit: userBeliefCap,
            minScore: 3,
            scoreDetails: this.budget.scoreDetails,
            excludeIds: pinnedIds,
            agentId
          })
        : ([] as ScoredBelief[]);

    const relationExpansions =
      rawSearchResults.length > 0
        ? await this.reader.expandRelationParticipants(
            userId,
            rawSearchResults,
            scope,
            {
              excludeIds: new Set([
                ...excludeIds,
                ...rawSearchResults.map((b) => b._id)
              ]),
              agentId
            }
          )
        : [];

    const allRelevant: ScoredBelief[] = [
      ...rawSearchResults,
      ...relationExpansions.map((b) => ({
        ...b,
        _searchScore: 0
      }))
    ];

    const searchScores: BeliefScore[] = allRelevant.map((b) => ({
      id: b._id as string,
      score: b._searchScore,
      ...(b._scoreDetails != null ? { scoreDetails: b._scoreDetails } : {})
    }));

    const personaPrelude = this.clip(
      personaDoc?.universal ?? "",
      this.budget.maxPersonaChars
    );

    const orgSummaryPrelude = teamMode
      ? this.clip(orgSummaryDoc?.summary ?? "", this.budget.maxOrgSummaryChars)
      : "";

    const combined = [...pinnedFacts, ...allRelevant];
    const cap =
      teamMode && ideMode ? this.budget.maxUserBeliefs : this.budget.maxBeliefs;
    const truncated = combined.length > cap;
    const capped = combined.slice(0, cap);

    const cappedPinned = capped.slice(0, Math.min(pinnedFacts.length, cap));
    const cappedRelevant = capped.slice(cappedPinned.length);

    const projector =
      this.budget.projection === "rich"
        ? this.projectRich.bind(this)
        : this.projectLean.bind(this);

    const searchResultIds = new Set(allRelevant.map((b) => b._id));

    return {
      expandedQuery,
      queryWasNoisy,
      personaPrelude,
      orgSummaryPrelude,
      teamBeliefsJson: JSON.stringify(teamBeliefs.map((b) => projector(b))),
      pinnedFactsJson: JSON.stringify(
        cappedPinned.map((b) => projector(b, false))
      ),
      relevantBeliefsJson: JSON.stringify(
        cappedRelevant.map((b) =>
          this.budget.projection === "lean"
            ? this.projectLean(b, searchResultIds.has(b._id as string))
            : this.projectRich(b)
        )
      ),
      openQuestionsJson: JSON.stringify(
        questions.map((q) => this.projectQuestion(q))
      ),
      beliefCount: capped.length + teamBeliefs.length,
      questionCount: questions.length,
      truncated,
      searchScores,
      rawPinnedFacts: cappedPinned,
      rawRelevantBeliefs: cappedRelevant,
      rawOpenQuestions: questions,
      rawTeamBeliefs: teamBeliefs
    };
  }

  private clip(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
  }

  private truncate(s: string): string {
    return this.clip(s, this.budget.maxCharsPerBelief);
  }

  private projectRich(b: Belief): Record<string, unknown> {
    return {
      id: b._id,
      type: b.type,
      canonical_name: b.canonical_name,
      aliases: b.aliases,
      content: this.truncate(b.content),
      why_it_matters: b.why_it_matters,
      scope: b.scope,
      epistemic_status: b.epistemic_status,
      confidence: b.confidence,
      pinned: b.pinned
    };
  }

  private projectLean(
    b: Belief,
    isSearchResult = false
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: b._id,
      canonical_name: b.canonical_name,
      content: this.truncate(b.content),
      why_it_matters: b.why_it_matters
    };
    if (b.type === "open_question" || b.type === "decision") {
      out.type = b.type;
    }
    if (b.epistemic_status !== "active") {
      out.epistemic_status = b.epistemic_status;
    }
    if (b.confidence < 0.65) {
      out.confidence = b.confidence;
    }
    if (isSearchResult && b.aliases?.length) {
      out.aliases = b.aliases;
    }
    return out;
  }

  private projectQuestion(q: Belief): Record<string, unknown> {
    return {
      id: q._id,
      canonical_name: q.canonical_name,
      content: this.truncate(q.content),
      scope: q.scope
    };
  }
}
