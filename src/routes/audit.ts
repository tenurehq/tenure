import type { FastifyInstance } from "fastify";
import type { Collection } from "mongodb";
import type { InjectionAuditRecord } from "../types/injectionAudit.js";

export interface AuditDeps {
  injectionAudit: Collection<InjectionAuditRecord>;
  userId: string;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: AuditDeps,
): void {
  app.get<{
    Querystring: {
      limit?: string;
      skip?: string;
      start?: string;
      end?: string;
      belief_id?: string;
      scope?: string;
    };
  }>("/admin/audit/injections", async (req) => {
    const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
    const skip = parseInt(req.query.skip ?? "0", 10) || 0;

    const filter: Record<string, unknown> = { user_id: deps.userId };

    if (req.query.start || req.query.end) {
      const createdAt: Record<string, unknown> = {};
      if (req.query.start) {
        const startDate = new Date(req.query.start);
        if (!isNaN(startDate.getTime())) createdAt.$gte = startDate;
      }
      if (req.query.end) {
        const endDate = new Date(req.query.end);
        if (!isNaN(endDate.getTime())) createdAt.$lte = endDate;
      }
      if (Object.keys(createdAt).length > 0) {
        filter.created_at = createdAt;
      }
    }

    if (req.query.belief_id) {
      filter.$or = [
        { "injected_beliefs.pinned_facts._id": req.query.belief_id },
        { "injected_beliefs.relevant_beliefs._id": req.query.belief_id },
        { "injected_beliefs.open_questions._id": req.query.belief_id },
      ];
    }

    if (req.query.scope) {
      filter.scope = req.query.scope;
    }

    const [records, total] = await Promise.all([
      deps.injectionAudit
        .find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      deps.injectionAudit.countDocuments(filter),
    ]);

    return { records, total, limit, skip };
  });

  app.get<{ Params: { id: string } }>(
    "/admin/audit/injections/:id",
    async (req, reply) => {
      const record = await deps.injectionAudit.findOne({
        _id: req.params.id,
        user_id: deps.userId,
      });

      if (!record) {
        return reply.code(404).send({ error: { message: "not found" } });
      }

      return { record };
    },
  );

  app.get("/admin/audit/scopes", async () => {
    const raw = await deps.injectionAudit.distinct("scope", {
      user_id: deps.userId,
    });
    const scopes = [...new Set(raw.flat().filter(Boolean))].sort();
    return { scopes };
  });

  app.get<{ Querystring: { days?: string } }>(
    "/admin/audit/orientation-tax",
    async (req) => {
      const days = Math.min(parseInt(req.query.days ?? "30", 10) || 30, 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const baseFilter = {
        user_id: deps.userId,
        created_at: { $gte: since },
      };

      const midpoint = new Date(
        since.getTime() + (days * 24 * 60 * 60 * 1000) / 2,
      );

      const [taxPaid, totalWithBeliefs, taxPaidFirstHalf, taxPaidSecondHalf] =
        await Promise.all([
          deps.injectionAudit.countDocuments({
            ...baseFilter,
            orientation_tax: true,
          }),
          deps.injectionAudit.countDocuments({
            ...baseFilter,
            belief_count: { $gt: 0 },
            injected: true,
          }),
          deps.injectionAudit.countDocuments({
            user_id: deps.userId,
            created_at: { $gte: since, $lt: midpoint },
            orientation_tax: true,
          }),
          deps.injectionAudit.countDocuments({
            user_id: deps.userId,
            created_at: { $gte: midpoint },
            orientation_tax: true,
          }),
        ]);

      const taxPrevented = Math.max(0, totalWithBeliefs - taxPaid);
      const taxRatePctChange =
        taxPaidFirstHalf > 0 && taxPaidSecondHalf >= 0
          ? Math.round(
              ((taxPaidSecondHalf - taxPaidFirstHalf) / taxPaidFirstHalf) * 100,
            )
          : null;

      return {
        period_days: days,
        orientation_tax_paid: taxPaid,
        orientation_tax_prevented: taxPrevented,
        total_injected_turns: totalWithBeliefs,
        tax_rate_trend_pct: taxRatePctChange,
        estimated_minutes_saved: taxPrevented,
      };
    },
  );
}
