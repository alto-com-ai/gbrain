// v0.41 T6 — synthesize_concepts cycle phase (minimal-viable implementation).
//
// v0.41 ships a working concept synthesis path: group atoms by simple
// frontmatter tag/concept references, tier by count (T1 ≥10, T2 ≥5,
// T3 ≥2, T4 ≥1), Sonnet-synthesize T1/T2 narratives. Voice gate
// integration + dedup-by-embedding-similarity ship in v0.42+.
//
// Sequencing:
//   1. Query all atom-typed pages from DB (excluding imported_from
//      marker → atoms already extracted by your OpenClaw don't get
//      re-synthesized as concepts here; their original concept pages
//      come through greenfield import already).
//   2. Group by `concepts:` frontmatter field on each atom (when the
//      Haiku 3-check from extract_atoms decides "this atom is about
//      concept X", it stamps the field).
//   3. For each group with count ≥2: assign tier (T1/T2/T3/T4 by count).
//   4. For T1/T2 groups: Sonnet call to produce a 1-paragraph narrative.
//      For T3/T4: deterministic stub narrative.
//   5. Write concept-typed pages.

import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { AIConfigError } from '../ai/errors.ts';
import { resolveModel } from '../model-config.ts';
import { createHash } from 'node:crypto';

const DEFAULT_BUDGET_USD = 1.5;
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;
const DREAM_PROVENANCE_LINK_SOURCE = 'dream-provenance';

export interface SynthesizeConceptsOpts {
  brainDir?: string;
  /** Restrict synthesis to one source. Unset processes every source independently. */
  sourceId?: string;
  dryRun?: boolean;
  /**
   * Native concept-synthesis cadence is intentionally narrower than the
   * minimal dream phase: routine runs should synthesize only T1/T2 concepts.
   * Leave undefined for the historical v0.41 dream behavior (T3+ pages too).
   */
  minTier?: AtomGroup['tier'];
  /**
   * Incremental lane: only write groups whose evidence fingerprint differs
   * from the existing concept page, or whose page is missing.
   */
  changedOnly?: boolean;
  yieldDuringPhase?: (() => Promise<void>) | undefined;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — see extract-atoms.ts for
   * the path-collision bug codex caught). Phases only call `tick()` /
   * `heartbeat()`; cycle.ts owns start/finish.
   */
  progress?: ProgressReporter;
  /** Test seam: alternative chat function. */
  _chat?: typeof gatewayChat;
  /** Test seam: skip DB query; cluster these atoms directly. */
  _atoms?: Array<{ source_id?: string; slug: string; source_slug?: string; concept_refs: string[]; body: string; title: string }>;
}

interface AtomGroup {
  sourceId: string;
  conceptSlug: string;
  atomTitles: string[];
  atomBodies: string[];
  atoms: Array<{ source_id: string; slug: string }>;
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  fingerprint: string;
}

const SYNTH_PROMPT = `You write a 1-paragraph executive summary of a concept
based on multiple atom-shaped insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON,
no preamble. Write in plain English, present-tense voice. Synthesize what
the atoms collectively SAY about the concept; don't enumerate the atoms.`;

const TIER_RANK: Record<AtomGroup['tier'], number> = { T4: 1, T3: 2, T2: 3, T1: 4 };

export async function runPhaseSynthesizeConcepts(
  engine: BrainEngine,
  opts: SynthesizeConceptsOpts = {},
): Promise<PhaseResult> {
  const chat = opts._chat ?? gatewayChat;

  // 1. Get atom pages (test seam OR DB query)
  let atoms = opts._atoms ?? [];
  if (atoms.length === 0 && opts._atoms === undefined) {
    try {
      const rows = await engine.executeRaw<{
        source_id: string;
        slug: string;
        title: string;
        compiled_truth: string;
        frontmatter: { concepts?: string[]; imported_from?: string; source_slug?: string };
      }>(
        `SELECT source_id, slug, title, compiled_truth, frontmatter
           FROM pages
          WHERE type = 'atom'
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`,
      );
      const scopedRows = opts.sourceId ? rows.filter((r) => r.source_id === opts.sourceId) : rows;
      atoms = scopedRows
        .filter((r) => Array.isArray(r.frontmatter?.concepts) && r.frontmatter.concepts.length > 0)
        .map((r) => ({
          source_id: r.source_id,
          slug: r.slug,
          title: r.title,
          body: r.compiled_truth,
          source_slug: r.frontmatter?.source_slug,
          concept_refs: r.frontmatter!.concepts!,
        }));
    } catch {
      // No atoms table or query failed — phase no-ops cleanly.
    }
  }
  if (opts.sourceId) {
    atoms = atoms.filter((atom) => (atom.source_id ?? 'default') === opts.sourceId);
  }

  if (atoms.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: 'synthesize_concepts: no atoms with concept refs',
      details: { reason: 'no_atoms' },
    };
  }

  // 2. Group atoms by concept slug
  const groups = new Map<string, { sourceId: string; conceptSlug: string; titles: string[]; bodies: string[]; atoms: Array<{ source_id: string; slug: string }> }>();
  for (const atom of atoms) {
    for (const conceptSlug of atom.concept_refs) {
      const sourceId = atom.source_id ?? 'default';
      const groupKey = `${sourceId}\0${conceptSlug}`;
      const existing = groups.get(groupKey) ?? { sourceId, conceptSlug, titles: [], bodies: [], atoms: [] };
      existing.titles.push(atom.title);
      existing.bodies.push(atom.body);
      existing.atoms.push({ source_id: sourceId, slug: atom.slug });
      groups.set(groupKey, existing);
    }
  }

  // 3. Filter to count ≥2, assign tier
  const atomGroups: AtomGroup[] = [];
  const minTier = opts.minTier ?? 'T3';
  for (const data of groups.values()) {
    const { sourceId, conceptSlug } = data;
    const count = data.titles.length;
    if (count < TIER_T3_MIN) continue;
    const tier: AtomGroup['tier'] =
      count >= TIER_T1_MIN ? 'T1' : count >= TIER_T2_MIN ? 'T2' : 'T3';
    if (TIER_RANK[tier] < TIER_RANK[minTier]) continue;
    atomGroups.push({
      sourceId,
      conceptSlug,
      atomTitles: data.titles,
      atomBodies: data.bodies,
      atoms: data.atoms,
      tier,
      fingerprint: conceptGroupFingerprint(conceptSlug, data),
    });
  }

  if (atomGroups.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: `synthesize_concepts: no concept groups with ≥${TIER_T3_MIN} atoms`,
      details: { reason: 'no_groups_above_threshold', atoms_seen: atoms.length },
    };
  }

  // 4. Per group: synthesize narrative (LLM for T1/T2, deterministic for T3+)
  let conceptsWritten = 0;
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;
  const model = await resolveModel(engine, {
    configKey: 'models.dream.synthesize_concepts',
    deprecatedConfigKey: 'models.dream.synthesize',
    tier: 'utility',
    fallback: 'haiku',
  });
  const failures: Array<{ concept: string; error: string }> = [];
  const tierCounts = { T1: 0, T2: 0, T3: 0, T4: 0 };
  let provenanceLinksCreated = 0;
  let conceptsUnchanged = 0;
  let conceptsChanged = 0;
  const existingConceptFingerprints = await loadExistingConceptFingerprints(engine, opts.sourceId);

  if (!opts.dryRun) {
    const sourceLinks: LinkBatchInput[] = [];
    for (const atom of atoms) {
      if (!atom.source_slug) continue;
      const atomSourceId = atom.source_id ?? 'default';
      sourceLinks.push(
        {
          from_slug: atom.source_slug,
          to_slug: atom.slug,
          from_source_id: atomSourceId,
          to_source_id: atomSourceId,
          link_type: 'yielded_atom',
          link_source: DREAM_PROVENANCE_LINK_SOURCE,
          origin_slug: atom.slug,
          origin_source_id: atomSourceId,
          origin_field: 'source_slug',
          context: `Source page yielded atom ${atom.slug}`,
        },
        {
          from_slug: atom.slug,
          to_slug: atom.source_slug,
          from_source_id: atomSourceId,
          to_source_id: atomSourceId,
          link_type: 'grounded_in_source',
          link_source: DREAM_PROVENANCE_LINK_SOURCE,
          origin_slug: atom.slug,
          origin_source_id: atomSourceId,
          origin_field: 'source_slug',
          context: `Atom is grounded in source page ${atom.source_slug}`,
        },
      );
    }
    provenanceLinksCreated += await engine.addLinksBatch(sourceLinks);
  }

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s — cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock + the existing external hook.
  // Pre-v0.41.19 the bare `if (opts.yieldDuringPhase) await ...()` at
  // every iteration fired hundreds of times per phase; the 30s throttle
  // matches the actual lock-refresh budget.
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesize_concepts] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  for (const group of atomGroups) {
    tierCounts[group.tier]++;
    const title = group.conceptSlug.split('/').pop() ?? group.conceptSlug;
    const conceptSlug = `concepts/${title}`;

    const conceptKey = `${group.sourceId}\0${conceptSlug}`;
    if (existingConceptFingerprints.get(conceptKey) === group.fingerprint) {
      if (!opts.dryRun) {
        const conceptLinks = conceptAtomLinks(conceptSlug, group);
        provenanceLinksCreated += await engine.addLinksBatch(conceptLinks);
      }
      conceptsUnchanged++;
      opts.progress?.tick(1, `${conceptsWritten} concepts (${conceptsUnchanged} unchanged)`);
      await maybeYield();
      continue;
    }

    conceptsChanged++;
    let narrative: string;
    if (opts.dryRun) {
      narrative = deterministicNarrative(group);
    } else if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
      } else {
        try {
          const result = await chat({
            model,
            system: SYNTH_PROMPT,
            messages: [
              {
                role: 'user',
                content:
                  `Concept slug: ${group.conceptSlug}\n` +
                  `${group.atomTitles.length} atoms reference this concept.\n\n` +
                  `Sample atom titles:\n${group.atomTitles.slice(0, 10).map((t) => `  - ${t}`).join('\n')}\n\n` +
                  `Sample atom bodies:\n${group.atomBodies
                    .slice(0, 5)
                    .map((b, i) => `${i + 1}. ${b.slice(0, 500)}`)
                    .join('\n\n')}`,
              },
            ],
            maxTokens: 500,
          });
          // Post-await yield (T3): the LLM call is the main TTL hazard
          // codex flagged. Throttle inside maybeYield bounds the actual
          // refresh rate.
          await maybeYield();
          // Sonnet at ~$3/M input + $15/M output
          estimatedSpendUsd +=
            (result.usage.input_tokens * 3.0 + result.usage.output_tokens * 15.0) / 1_000_000;
          narrative = result.text.trim() || deterministicNarrative(group);
        } catch (err) {
          if (err instanceof AIConfigError) throw err;
          failures.push({
            concept: group.conceptSlug,
            error: err instanceof Error ? err.message : String(err),
          });
          narrative = deterministicNarrative(group);
        }
      }
    } else {
      narrative = deterministicNarrative(group);
    }

    if (!opts.dryRun) {
      await engine.putPage(`concepts/${title}`, {
        title: title.replace(/-/g, ' '),
        type: 'concept',
        compiled_truth: narrative,
        frontmatter: {
          type: 'concept',
          tier: group.tier,
          mention_count: group.atomTitles.length,
          composite_score: group.atomTitles.length,
          synthesized_at: new Date().toISOString(),
          synthesized_by: 'synthesize_concepts-v0.41',
          synthesis_fingerprint: group.fingerprint,
          synthesis_fingerprint_version: 1,
        },
        timeline: '',
      }, { sourceId: group.sourceId });
      provenanceLinksCreated += await engine.addLinksBatch(conceptAtomLinks(conceptSlug, group));
    }
    conceptsWritten++;
    // v0.41.19.0 (T4): one tick per concept group with running count.
    opts.progress?.tick(1, `${conceptsWritten} concepts`);

    // v0.41.19.0 (T3): replaced bare per-iteration fire with throttled
    // helper. Same hook, same cycle-lock refresh effect, just at the
    // right cadence (30s instead of every-group).
    await maybeYield();
  }

  // v0.42 Wave B3: receipt + rollup for synthesize_concepts. Brain-global
  // phase — uses 'default' source_id because concepts span sources. Receipt
  // only fires when concepts were actually written; rollup always fires so
  // doctor sees the phase ran.
  if (!opts.dryRun && conceptsWritten > 0) {
    const runId = `concepts-${Date.now().toString(36)}`;
    try {
      await writeReceipt(engine, {
        kind: 'concepts',
        source_id: 'default',
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: conceptsWritten,
        cost_usd: estimatedSpendUsd,
        summary:
          `Synthesized ${conceptsWritten} concepts ` +
          `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3}) ` +
          `from ${atomGroups.length} groups across ${atoms.length} atoms.`,
      });
    } catch (err) {
      console.error(`[synthesize_concepts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'concepts',
      source_id: 'default',
      cost_delta: estimatedSpendUsd,
      round_completed_delta: failures.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'synthesize_concepts',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `synthesize_concepts: ${conceptsWritten} concepts ` +
      `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3})` +
      (failures.length > 0 ? ` (${failures.length} LLM-failed → template fallback)` : ''),
    details: {
      concepts_written: conceptsWritten,
      concepts_unchanged: conceptsUnchanged,
      concepts_changed: conceptsChanged,
      tier_counts: tierCounts,
      groups_found: atomGroups.length,
      atoms_seen: atoms.length,
      provenance_links_created: provenanceLinksCreated,
      failures,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      dry_run: opts.dryRun ?? false,
    },
  };
}

async function loadExistingConceptFingerprints(engine: BrainEngine, sourceId?: string): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; frontmatter: { synthesis_fingerprint?: string } }>(
    `SELECT source_id, slug, frontmatter
       FROM pages
      WHERE type = 'concept'
        AND deleted_at IS NULL
        AND slug LIKE 'concepts/%'
        AND ($1::text IS NULL OR source_id = $1)`,
    [sourceId ?? null],
  );
  const bySlug = new Map<string, string>();
  for (const row of rows) {
    const fingerprint = row.frontmatter?.synthesis_fingerprint;
    if (typeof fingerprint === 'string' && fingerprint.length > 0) {
      bySlug.set(`${row.source_id}\0${row.slug}`, fingerprint);
    }
  }
  return bySlug;
}

function conceptGroupFingerprint(
  conceptSlug: string,
  data: { titles: string[]; bodies: string[]; atoms: Array<{ source_id: string; slug: string }> },
): string {
  const evidence = data.atoms.map((atom, i) => ({
    source_id: atom.source_id,
    slug: atom.slug,
    title: data.titles[i] ?? '',
    body_hash: createHash('sha256').update(data.bodies[i] ?? '').digest('hex'),
  })).sort((a, b) =>
    `${a.source_id}\0${a.slug}\0${a.title}`.localeCompare(`${b.source_id}\0${b.slug}\0${b.title}`),
  );
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, conceptSlug, evidence }))
    .digest('hex');
}

function conceptAtomLinks(conceptSlug: string, group: AtomGroup): LinkBatchInput[] {
  const conceptLinks: LinkBatchInput[] = [];
  for (const atom of group.atoms) {
    conceptLinks.push(
      {
        from_slug: conceptSlug,
        to_slug: atom.slug,
        from_source_id: group.sourceId,
        to_source_id: atom.source_id,
        link_type: 'grounded_in',
        link_source: DREAM_PROVENANCE_LINK_SOURCE,
        origin_slug: conceptSlug,
        origin_source_id: group.sourceId,
        origin_field: 'concepts',
        context: `Concept is grounded in atom ${atom.source_id}::${atom.slug}`,
      },
      {
        from_slug: atom.slug,
        to_slug: conceptSlug,
        from_source_id: atom.source_id,
        to_source_id: group.sourceId,
        link_type: 'evidence_for',
        link_source: DREAM_PROVENANCE_LINK_SOURCE,
        origin_slug: conceptSlug,
        origin_source_id: group.sourceId,
        origin_field: 'concepts',
        context: `Atom supports concept ${conceptSlug}`,
      },
    );
  }
  return conceptLinks;
}

/**
 * Deterministic fallback narrative for T3/T4 concepts and budget-exhausted
 * T1/T2 groups. No LLM call. v0.41 minimal shape — v0.42 enriches with
 * dominant themes, time spread, breadth.
 */
function deterministicNarrative(group: AtomGroup): string {
  const tier = group.tier;
  const count = group.atomTitles.length;
  return (
    `${tier} concept. ${count} atom${count === 1 ? '' : 's'} reference this. ` +
    `Top mentions:\n${group.atomTitles
      .slice(0, 5)
      .map((t) => `  - ${t}`)
      .join('\n')}`
  );
}
