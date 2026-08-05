/**
 * The pipeline, as an async generator rather than a function (trick #8).
 *
 * This is the decision that makes the CLI, a Telegram bot and a web SSE stream
 * three thin adapters over one implementation instead of three copies of the
 * orchestration logic. An adapter consumes AosEvent values and decides how to
 * render them; it never knows what a role is.
 *
 * Roles communicate only through the WorkOrder. There is no shared memory, no
 * agent chatter, no message bus. Every input a role receives is assembled here,
 * explicitly, from the WorkOrder and the previous role's validated output, which
 * is why the whole control flow fits in one file you can read top to bottom.
 */
import fs from 'node:fs';
import { WorkOrder, blockingDefects, openDefects } from '../core/schema.ts';
import type { Artifact, Decision, Defect } from '../core/schema.ts';
import { assertTransition, MAX_REWORK } from '../core/states.ts';
import type { State } from '../core/states.ts';
import { writeArtifact } from '../core/paths.ts';
import type { RunPaths } from '../core/paths.ts';
import type { AosEvent, EventLog } from '../core/events.ts';
import type { Sequencer } from '../core/ids.ts';
import type { RouterContext } from '../core/router.ts';
import { callStructured } from '../core/structured.ts';
import { requireRole } from '../core/roles.ts';
import type { RuntimeRole } from '../core/roles.ts';
import { AosError, isAosError } from '../core/errors.ts';
import { buildCostReport, writeCostReport } from '../report/cost-report.ts';
import { billNoOneGate, writeFounderBrief } from './herald.ts';
import type {
  BuildResult,
  CritiqueReport,
  DefectReport,
  DeliveryPackage,
  IdeaOption,
  Plan,
} from '../roles/outputs.ts';

export interface PipelineDeps {
  wo: WorkOrder;
  paths: RunPaths;
  roles: Map<string, RuntimeRole>;
  ctx: RouterContext;
  seq: Sequencer;
}

/** The three angles MUSE is pushed toward, one per parallel call. */
const MUSE_ANGLES = [
  'the most minimal thing that could possibly satisfy this',
  'a differently shaped solution that a competent engineer would reach for instead',
  'an approach that questions whether the request itself is the right request',
];

export async function* runPipeline(deps: PipelineDeps): AsyncGenerator<AosEvent, WorkOrder> {
  const { paths, roles, ctx, seq } = deps;
  const log = ctx.log;
  let wo = deps.wo;

  // Everything the log records is yielded, so an adapter sees the same stream
  // the audit trail does. No event can reach disk without reaching the UI.
  const pending: AosEvent[] = [];
  log.onAppend((e) => pending.push(e));
  function* drain(): Generator<AosEvent> {
    while (pending.length > 0) yield pending.shift()!;
  }

  const startedAt = Date.now();
  const go = (to: State, note?: string): void => {
    assertTransition(wo.state, to);
    log.append({ type: 'state.changed', from: wo.state, to, note });
    wo = WorkOrder.parse({ ...wo, state: to });
  };

  const save = (): void => fs.writeFileSync(paths.workorder, JSON.stringify(wo, null, 2) + '\n', 'utf-8');

  log.append({
    type: 'run.started',
    runId: wo.id,
    idea: wo.idea,
    budgetUsd: wo.budgetUsd,
    constraints: wo.constraints,
    transport: ctx.transport.kind,
  });
  yield* drain();

  try {
    // ---- MUSE: three divergent options, generated in parallel ----------------
    const muse = requireRole(roles, 'MUSE');
    log.append({ type: 'role.started', role: muse.name, model: muse.model });
    const museStarted = Date.now();
    const options: IdeaOption[] = (
      await Promise.all(
        MUSE_ANGLES.map((angle) =>
          callStructured<IdeaOption>(ctx, {
            role: muse,
            schema: muse.schema as never,
            messages: [
              {
                role: 'user',
                content: [
                  `Idea: ${wo.idea}`,
                  wo.constraints.length > 0 ? `Constraints: ${wo.constraints.join('; ')}` : '',
                  '',
                  `Angle for THIS option: ${angle}`,
                  '',
                  'Return one option only. Another call is handling the other angles.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
          }),
        ),
      )
    ).map((r) => r.value);
    log.append({ type: 'role.finished', role: muse.name, ok: true, ms: Date.now() - museStarted });
    go('IDEATED');
    yield* drain();

    // ---- ATLAS: choose, decompose, set the tier, record decisions ------------
    const atlas = requireRole(roles, 'ATLAS');
    log.append({ type: 'role.started', role: atlas.name, model: atlas.model });
    const atlasStarted = Date.now();
    const plan = (
      await callStructured<Plan>(ctx, {
        role: atlas,
        schema: atlas.schema as never,
        messages: [
          {
            role: 'user',
            content: [
              `Idea: ${wo.idea}`,
              wo.constraints.length > 0 ? `Constraints: ${wo.constraints.join('; ')}` : '',
              '',
              'MUSE returned three options:',
              '',
              options
                .map((o, i) => `${i + 1}. ${o.title}\n   ${o.sketch}\n   Why not: ${o.whyNot}`)
                .join('\n\n'),
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      })
    ).value;
    log.append({ type: 'role.finished', role: atlas.name, ok: true, ms: Date.now() - atlasStarted });

    const decisions: Decision[] = plan.decisions.map((d) => ({
      id: seq.id('dec'),
      title: d.title,
      chosen: d.chosen,
      alternatives: d.alternatives,
      assumptions: d.assumptions,
      falsifier: d.falsifier,
      reviewOn: new Date(Date.parse(wo.createdAt) + d.reviewInDays * 86_400_000).toISOString().slice(0, 10),
      tier: plan.tier,
      reversible: plan.reversible,
      status: 'ACTIVE' as const,
    }));
    for (const d of decisions) log.append({ type: 'decision.made', decision: d });

    wo = WorkOrder.parse({ ...wo, gate: plan.tier, decisions: [...wo.decisions, ...decisions] });
    go('PLANNED');
    yield* drain();

    // ---- FORGE / ECHO / SENTINEL, with a bounded rework loop -----------------
    let critiques: CritiqueReport[] = [];
    let defectReport: DefectReport = { defects: [], testsRun: [] };
    let buildNotes = '';

    for (;;) {
      const rework = wo.reworkCount > 0;

      // FORGE
      const forge = requireRole(roles, 'FORGE');
      log.append({ type: 'role.started', role: forge.name, model: forge.model });
      const forgeStarted = Date.now();
      const build = (
        await callStructured<BuildResult>(ctx, {
          role: forge,
          schema: forge.schema as never,
          messages: [
            {
              role: 'user',
              content: [
                `Idea: ${wo.idea}`,
                wo.constraints.length > 0 ? `Constraints: ${wo.constraints.join('; ')}` : '',
                '',
                `Chosen approach: ${plan.chosenOption}`,
                `Why: ${plan.rationale}`,
                '',
                'Tasks and their acceptance criteria:',
                plan.tasks.map((t) => `- [${t.id}] ${t.title}\n  Acceptance: ${t.acceptance}`).join('\n'),
                rework ? '\nFix these defects and change nothing else:' : '',
                rework
                  ? openDefects(wo)
                      .map((d) => `- ${d.severity}: ${d.description}\n  Evidence: ${d.evidence}`)
                      .join('\n')
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        })
      ).value;
      log.append({ type: 'role.finished', role: forge.name, ok: true, ms: Date.now() - forgeStarted });
      buildNotes = build.notes;

      // Artifacts land through the sandbox. A path the sandbox refuses costs
      // that one file, not the whole run; the delivery gate decides whether
      // what survived is enough.
      const artifacts: Artifact[] = [];
      for (const f of build.files) {
        try {
          const written = writeArtifact(paths, f.path, f.contents);
          artifacts.push({ path: written.path, kind: f.kind, runnable: f.runnable, producedBy: forge.name });
          log.append({
            type: 'artifact.written',
            path: written.path,
            kind: f.kind,
            runnable: f.runnable,
            producedBy: forge.name,
            bytes: written.bytes,
          });
        } catch (err) {
          if (!isAosError(err) || err.code !== 'PATH_ESCAPE') throw err;
          log.append({ type: 'log', level: 'warn', message: err.message });
        }
      }
      wo = WorkOrder.parse({ ...wo, artifacts });
      if (rework) assertTransition(wo.state, 'BUILT');
      go('BUILT', rework ? `rework pass ${wo.reworkCount}` : undefined);
      yield* drain();

      // ECHO: two providers in parallel. Agreement between them is evidence;
      // agreement with itself would be an artifact of the prompt.
      const echo = requireRole(roles, 'ECHO');
      const critics = [echo.model, ...echo.parallel];
      log.append({ type: 'role.started', role: echo.name, model: critics.join(' + ') });
      const echoStarted = Date.now();
      const critiqueMessage = [
        `Idea: ${wo.idea}`,
        `Plan: ${plan.chosenOption} — ${plan.rationale}`,
        '',
        'Files produced:',
        build.files.map((f) => `\n--- ${f.path} (runnable=${f.runnable}) ---\n${f.contents}`).join('\n'),
      ].join('\n');
      critiques = (
        await Promise.all(
          critics.map((model) =>
            callStructured<CritiqueReport>(ctx, {
              role: echo,
              model,
              schema: echo.schema as never,
              messages: [{ role: 'user', content: critiqueMessage }],
            }),
          ),
        )
      ).map((r) => r.value);
      log.append({ type: 'role.finished', role: echo.name, ok: true, ms: Date.now() - echoStarted });
      go('REVIEWED');
      yield* drain();

      // SENTINEL: defects with reproduction steps, or nothing.
      const sentinel = requireRole(roles, 'SENTINEL');
      log.append({ type: 'role.started', role: sentinel.name, model: sentinel.model });
      const sentinelStarted = Date.now();
      defectReport = (
        await callStructured<DefectReport>(ctx, {
          role: sentinel,
          schema: sentinel.schema as never,
          messages: [
            {
              role: 'user',
              content: [
                critiqueMessage,
                '',
                'The independent critics raised:',
                critiques
                  .flatMap((c, i) =>
                    c.objections.length > 0
                      ? c.objections.map((o) => `- (critic ${i + 1}) ${o.severity}: ${o.claim}`)
                      : [`- (critic ${i + 1}) no objection; suggested test: ${c.testThatWouldCreateOne}`],
                  )
                  .join('\n'),
                '',
                'Confirm or refute each by reading the files. File only what you can reproduce.',
              ].join('\n'),
            },
          ],
        })
      ).value;
      log.append({ type: 'role.finished', role: sentinel.name, ok: true, ms: Date.now() - sentinelStarted });

      const defects: Defect[] = defectReport.defects.map((d) => ({
        id: seq.id('def'),
        severity: d.severity,
        description: d.description,
        foundBy: sentinel.name,
        status: 'OPEN' as const,
        evidence: d.evidence,
      }));
      for (const d of defects) log.append({ type: 'defect.filed', defect: d });
      wo = WorkOrder.parse({ ...wo, defects: [...wo.defects, ...defects] });

      const blocking = blockingDefects(wo);
      if (blocking.length === 0) {
        go('DELIVERED');
        yield* drain();
        break;
      }

      go('DEFECTS_OPEN', `${blocking.length} S1 defect(s) block delivery`);
      yield* drain();

      if (wo.reworkCount >= MAX_REWORK) {
        // Out of rework passes. Ship what exists with the defects on the record
        // rather than looping; an unbounded fix loop is the cheapest way to
        // burn a budget on something the model cannot actually fix.
        log.append({
          type: 'log',
          level: 'warn',
          message: `rework limit (${MAX_REWORK}) reached with ${blocking.length} S1 defect(s) still open`,
        });
        go('DELIVERED');
        yield* drain();
        break;
      }
      wo = WorkOrder.parse({ ...wo, reworkCount: wo.reworkCount + 1 });
    }

    // ---- HERALD: package, then the Bill No. 1 gate ---------------------------
    const herald = requireRole(roles, 'HERALD');
    log.append({ type: 'role.started', role: herald.name, model: herald.model });
    const heraldStarted = Date.now();
    const pkg = (
      await callStructured<DeliveryPackage>(ctx, {
        role: herald,
        schema: herald.schema as never,
        messages: [
          {
            role: 'user',
            content: [
              `Idea: ${wo.idea}`,
              `Approach taken: ${plan.chosenOption}`,
              buildNotes ? `Build notes: ${buildNotes}` : '',
              '',
              'Artifacts written:',
              wo.artifacts.map((a) => `- ${a.path} (${a.kind}, runnable=${a.runnable})`).join('\n'),
              '',
              'Open defects:',
              openDefects(wo).length > 0
                ? openDefects(wo)
                    .map((d) => `- ${d.severity}: ${d.description}`)
                    .join('\n')
                : '- none',
              '',
              'Critic objections:',
              critiques.flatMap((c) => c.objections.map((o) => `- ${o.severity}: ${o.claim}`)).join('\n') || '- none',
              '',
              `Checks run: ${defectReport.testsRun.join('; ') || 'none recorded'}`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      })
    ).value;
    log.append({ type: 'role.finished', role: herald.name, ok: true, ms: Date.now() - heraldStarted });
    yield* drain();

    // The gate runs AFTER packaging so the brief can explain a refusal.
    let gateFailure: AosError | null = null;
    try {
      billNoOneGate(wo);
    } catch (err) {
      if (!isAosError(err)) throw err;
      gateFailure = err;
    }

    const autoApprove = !gateFailure && wo.gate === 'GREEN' && blockingDefects(wo).length === 0;
    go('FOUNDER_REVIEW');

    const cost = buildCostReport(paths.events, wo.id, wo.budgetUsd);
    writeCostReport(paths.cost, cost);

    if (gateFailure) {
      log.append({ type: 'gate.founder', briefPath: paths.brief, gate: wo.gate, blocking: true });
      go('REJECTED');
      // The brief is written after the transition so its status line reports
      // where the run actually ended, not where it was passing through.
      writeFounderBrief({
        wo,
        paths,
        pkg,
        cost,
        verdict: `**Delivery refused.** ${gateFailure.message}. A document describing the work is not the work.`,
        nextStep: 'Nothing runnable was produced, so there is nothing to approve. Re-run, or narrow the idea.',
      });
      save();
      log.append({
        type: 'run.finished',
        state: wo.state,
        spentUsd: cost.spentUsd,
        ms: Date.now() - startedAt,
        artifacts: wo.artifacts.length,
      });
      yield* drain();
      throw gateFailure;
    }

    if (autoApprove) {
      // `reversible` is the gate for autonomy, not task size. GREEN and
      // reversible with nothing blocking does not need a human.
      log.append({ type: 'gate.founder', briefPath: paths.brief, gate: wo.gate, blocking: false });
      go('DONE');
      writeFounderBrief({
        wo,
        paths,
        pkg,
        cost,
        verdict: 'Approved automatically: tier GREEN, reversible, no blocking defects.',
        nextStep: 'Open the artifact and see for yourself. If it is wrong, nothing here is hard to undo.',
      });
    } else {
      writeFounderBrief({
        wo,
        paths,
        pkg,
        cost,
        verdict: `Waiting on you. Tier ${wo.gate}${blockingDefects(wo).length > 0 ? ` with ${blockingDefects(wo).length} blocking defect(s)` : ''}, so AOS will not close this by itself.`,
        nextStep: `npm run aos:resume ${wo.id} -- --approve\nnpm run aos:resume ${wo.id} -- --reject "your reason"`,
      });
      log.append({ type: 'gate.founder', briefPath: paths.brief, gate: wo.gate, blocking: true });
      // The human gate is a state, not a console.log (trick #9). The run stops
      // here and stays stopped until aos:resume moves it.
    }

    save();
    writeCostReport(paths.cost, buildCostReport(paths.events, wo.id, wo.budgetUsd));
    log.append({
      type: 'run.finished',
      state: wo.state,
      spentUsd: cost.spentUsd,
      ms: Date.now() - startedAt,
      artifacts: wo.artifacts.length,
    });
    yield* drain();
    return wo;
  } catch (err) {
    // Any exit that is not the happy path still produces the four artifacts the
    // founder was promised. A run that fails silently is worse than one that
    // fails, and the failing runs are the ones worth reading.
    const halted = isAosError(err) && err.code === 'BUDGET_EXCEEDED';
    if (halted) wo = WorkOrder.parse({ ...wo, state: 'HALTED_BUDGET' });

    const cost = buildCostReport(paths.events, wo.id, wo.budgetUsd);
    writeCostReport(paths.cost, cost);
    wo = WorkOrder.parse({ ...wo, spentUsd: cost.spentUsd });
    save();

    if (!fs.existsSync(paths.brief)) {
      const message = err instanceof Error ? err.message : String(err);
      writeFounderBrief({
        wo,
        paths,
        pkg: null,
        cost,
        verdict: halted
          ? `**Stopped at the budget cap.** ${message}`
          : `**The run failed in ${wo.state}.** ${message}`,
        nextStep: halted
          ? `Raise the cap and re-run:  npm run aos -- "${wo.idea}" --budget ${(wo.budgetUsd * 2).toFixed(2)}`
          : 'Read events.jsonl for the full trace. The last model.response before the failure is usually the cause.',
      });
    }

    log.append({
      type: 'run.finished',
      state: wo.state,
      spentUsd: cost.spentUsd,
      ms: Date.now() - startedAt,
      artifacts: wo.artifacts.length,
    });
    yield* drain();
    throw err;
  }
}
