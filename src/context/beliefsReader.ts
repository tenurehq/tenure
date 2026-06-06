import type { Collection } from "mongodb";
import type { Belief, BeliefType } from "../types/belief.js";

const ACTIVE_FILTER = { resolved_at: null, superseded_by: null };

export type ScoredBelief = Belief & {
  _searchScore: number;
  _scoreDetails?: Record<string, unknown>;
};

export interface SearchTextOptions {
  limit?: number;
  minScore?: number;
  scoreDetails?: boolean;
  excludeIds?: Set<string>;
  agentId?: string | null;
}

export class BeliefsReader {
  constructor(private readonly col: Collection<Belief>) {}

  /**
   * Merges an agent filter with an existing $or clause without clobbering.
   * MongoDB does not allow multiple $or at the top level of a single filter
   * object, so when the base query already uses $or we wrap both in $and.
   */
  private mergeFilter(
    base: Record<string, unknown>,
    agentId: string | null | undefined,
  ): Record<string, unknown> {
    if (!agentId) return base;

    const agentOr = [{ agent_id: agentId }, { agent_id: null }];

    if (base.$or) {
      const existingOr = base.$or;
      const { $or: _, ...rest } = base;
      return {
        ...rest,
        $and: [{ $or: existingOr }, { $or: agentOr }],
      };
    }

    return { ...base, $or: agentOr };
  }

  FUZZY_OPTS = { maxEdits: 1, prefixLength: 2 };

  private buildBaseFilters(
    userId: string,
    scope?: string[],
    agentId?: string | null,
  ): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = [
      { equals: { path: "user_id", value: userId } },
      { equals: { path: "resolved_at", value: null } },
      { equals: { path: "superseded_by", value: null } },
    ];
    if (scope?.length) {
      clauses.push({ in: { path: "scope", value: scope } });
    }
    if (agentId) {
      clauses.push({
        compound: {
          should: [
            { equals: { path: "agent_id", value: agentId } },
            { equals: { path: "agent_id", value: null } },
          ],
          minimumShouldMatch: 1,
        },
      });
    }
    return clauses;
  }

  private buildSearchStage(
    query: string,
    filterClauses: Record<string, unknown>[],
    mustNotClauses?: Record<string, unknown>[],
    scoreDetails = false,
  ): Record<string, unknown> {
    const stage: Record<string, unknown> = {
      index: "beliefs_search",
      compound: {
        must: [
          {
            compound: {
              should: [
                {
                  text: {
                    query,
                    path: "canonical_name",
                    fuzzy: this.FUZZY_OPTS,
                    score: { boost: { value: 14 } },
                  },
                },
                {
                  text: {
                    query,
                    path: { value: "canonical_name", multi: "phrase" },
                    score: { boost: { value: 14 } },
                  },
                },
                {
                  text: {
                    query,
                    path: "aliases",
                    fuzzy: this.FUZZY_OPTS,
                    score: { boost: { value: 5 } },
                  },
                },
                {
                  text: {
                    query,
                    path: { value: "aliases", multi: "shingle" },
                    score: { boost: { value: 14 } },
                  },
                },
              ],
              minimumShouldMatch: 1,
            },
          },
        ],
        filter: filterClauses,
      },
    };
    if (mustNotClauses?.length) {
      const compound = stage.compound as Record<string, unknown>;
      compound.mustNot = mustNotClauses;
    }
    if (scoreDetails) {
      stage.scoreDetails = true;
    }
    return stage;
  }

  private runSearchPipeline(
    searchStage: Record<string, unknown>,
    minScore: number,
    limit: number,
    scoreDetails = false,
  ): Promise<ScoredBelief[]> {
    if (limit <= 0) return Promise.resolve([]);

    const addFields: Record<string, unknown> = {
      _searchScore: { $meta: "searchScore" },
    };
    if (scoreDetails) {
      addFields._scoreDetails = { $meta: "searchScoreDetails" };
    }

    const pipeline: object[] = [
      { $search: searchStage },
      { $addFields: addFields },
      { $match: { _searchScore: { $gte: minScore } } },
      { $limit: limit },
    ];

    return this.col.aggregate<ScoredBelief>(pipeline).toArray();
  }

  async listAlwaysOn(
    userId: string,
    scope?: string[],
    limit = 40,
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      $or: [{ pinned: true }, { type: "preference" }],
    };
    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, agentId);

    return this.col
      .find(filter)
      .sort({ pinned: -1, last_reinforced_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listPinnedFacts(
    userId: string,
    scope?: string[],
    limit = 40,
    excludeIds: Set<string> = new Set(),
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      pinned: true,
      type: { $ne: "open_question" as const },
      scope: { $nin: ["universal", "user:universal"] },
    };

    if (excludeIds.size > 0) {
      base._id = { $nin: [...excludeIds] };
    }

    if (scope?.length) {
      base.scope = { $in: scope };
    }

    const filter = this.mergeFilter(base, agentId);

    return this.col
      .find(filter)
      .sort({ user_edited: -1, last_reinforced_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listByScope(
    userId: string,
    scope: string[],
    types?: BeliefType[],
    limit = 40,
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      scope: { $in: scope },
    };
    if (types?.length) base.type = { $in: types };

    const filter = this.mergeFilter(base, agentId);

    return this.col.find(filter).limit(limit).toArray();
  }

  async searchText(
    userId: string,
    query: string,
    scope?: string[],
    opts: SearchTextOptions = {},
  ): Promise<ScoredBelief[]> {
    const {
      limit = 20,
      minScore = 1.0,
      scoreDetails = false,
      excludeIds,
      agentId,
    } = opts;

    if (!query.trim()) return [];

    const filterClauses = this.buildBaseFilters(userId, scope, agentId);

    const mustNotClauses: Record<string, unknown>[] = [
      { equals: { path: "type", value: "open_question" } },
      { equals: { path: "subtype", value: "expertise" } },
    ];
    if (excludeIds?.size) {
      for (const id of excludeIds) {
        mustNotClauses.push({ equals: { path: "_id", value: id } });
      }
    }

    const searchStage = this.buildSearchStage(
      query,
      filterClauses,
      mustNotClauses,
      scoreDetails,
    );

    return this.runSearchPipeline(searchStage, minScore, limit, scoreDetails);
  }

  /**
   * Atlas Search fallback for ingestion-time deduplication.
   * Unlike searchText(), this does NOT exclude expertise or open_question,
   * and it scopes tightly to the incoming belief's type/scope/agent.
   */
  async searchMergeCandidates(
    userId: string,
    query: string,
    scope: string[],
    type: string,
    subtype: string | null,
    opts: {
      agentId?: string | null;
      limit?: number;
      minScore?: number;
    } = {},
  ): Promise<ScoredBelief[]> {
    const { limit = 5, minScore = 1.0, agentId } = opts;
    if (!query.trim()) return [];

    const filterClauses = this.buildBaseFilters(userId, scope, agentId);
    filterClauses.push({ equals: { path: "type", value: type } });
    if (subtype) {
      filterClauses.push({ equals: { path: "subtype", value: subtype } });
    }

    const searchStage = this.buildSearchStage(query, filterClauses);

    return this.runSearchPipeline(searchStage, minScore, limit, false);
  }

  async expandRelationParticipants(
    userId: string,
    relationBeliefs: ScoredBelief[],
    scope?: string[],
    opts: { excludeIds?: Set<string>; agentId?: string | null } = {},
  ): Promise<Belief[]> {
    const relations = relationBeliefs.filter((b) => b.type === "relation");
    if (relations.length === 0) return [];

    const participantIds = new Set<string>();
    for (const rel of relations) {
      const parts = (rel as unknown as { participants?: string[] })
        .participants;
      if (parts) {
        for (const id of parts) {
          if (!opts.excludeIds?.has(id)) participantIds.add(id);
        }
      }
    }

    if (participantIds.size === 0) return [];

    const base: Record<string, unknown> = {
      user_id: userId,
      _id: { $in: [...participantIds] },
      resolved_at: null,
      superseded_by: null,
      type: { $ne: "open_question" },
    };

    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, opts.agentId);

    return this.col.find(filter).toArray();
  }

  async listPinnedOpenQuestions(
    userId: string,
    scope?: string[],
    limit = 15,
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      type: "open_question",
      pinned: true,
    };
    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, agentId);

    return this.col.find(filter).limit(limit).toArray();
  }

  async findByCanonicalNames(
    userId: string,
    names: string[],
    scope?: string[],
    opts: { agentId?: string | null; excludeIds?: Set<string> } = {},
  ): Promise<Belief[]> {
    if (names.length === 0) return [];

    const base: Record<string, unknown> = {
      user_id: userId,
      canonical_name: { $in: names.map((n) => n.trim().toLowerCase()) },
      ...ACTIVE_FILTER,
    };

    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, opts.agentId);

    const results = await this.col.find(filter).toArray();

    if (opts.excludeIds?.size) {
      return results.filter((b) => !opts.excludeIds!.has(b._id));
    }

    return results;
  }

  async countActive(userId: string, agentId?: string | null): Promise<number> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
    };

    const filter = this.mergeFilter(base, agentId);

    return this.col.countDocuments(filter);
  }
}
