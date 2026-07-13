/**
 * issue #1678 — extract_atoms backlog count + doctor check.
 *
 * Pins:
 *  - countExtractAtomsBacklog counts eligible-but-unextracted pages (scoped +
 *    brain-wide) and excludes pages that already have an atom (NOT EXISTS).
 *  - computeExtractAtomsBacklogCheck WARNs with a `--drain` hint when the pack
 *    doesn't run the phase and the backlog is real; OK at 0.
 *
 * Real in-memory PGLite (canonical block, R3+R4). GBRAIN_HOME is pointed at an
 * empty tmpdir for the doctor-check cases so packDeclaresPhase resolves the
 * bundled base pack (which does NOT declare extract_atoms) deterministically,
 * independent of the developer's real ~/.gbrain config.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractAtomsBacklogCheck, computeSynthesizeConceptsBacklogCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-backlog-home-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedArticle(slug: string) {
  return engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY });
}

describe('countExtractAtomsBacklog (issue #1678)', () => {
  it('counts eligible pages with no atom (scoped + brain-wide)', async () => {
    await seedArticle('article-a');
    await seedArticle('article-b');
    await seedArticle('article-c');
    expect(await countExtractAtomsBacklog(engine)).toBe(3);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
  });

  it('excludes a page that already has a matching atom (NOT EXISTS)', async () => {
    const p = await seedArticle('article-x');
    const h16 = (p.content_hash ?? '').slice(0, 16);
    expect(h16.length).toBe(16);
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'a1',
      compiled_truth: 'an extracted nugget',
      frontmatter: { source_hash: h16 },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  it('ignores short pages and dream-generated pages', async () => {
    await engine.putPage('article-short', { type: 'article', title: 's', compiled_truth: 'too short' });
    await engine.putPage('article-dream', {
      type: 'article', title: 'd', compiled_truth: BODY,
      frontmatter: { dream_generated: 'true' },
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });
});

describe('computeExtractAtomsBacklogCheck (issue #1678)', () => {
  it('OK with no backlog', async () => {
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect((check.details as { backlog: number }).backlog).toBe(0);
  });

  it('WARNs with a --drain hint when the pack does not run the phase and backlog > 10', async () => {
    for (let i = 0; i < 11; i++) await seedArticle(`article-${i}`);
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () =>
      computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('--drain');
    expect((check.details as { pack_declares_phase: boolean }).pack_declares_phase).toBe(false);
    expect((check.details as { known_approximation: string }).known_approximation).toContain('page backlog only');
  });
});
describe('computeSynthesizeConceptsBacklogCheck', () => {
  it('FAILs when atoms have source/concept refs without graph materialization', async () => {
    await engine.putPage('meetings/m1', {
      type: 'meeting',
      title: 'Meeting',
      compiled_truth: BODY,
      frontmatter: {},
    });
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'A1',
      compiled_truth: 'atom one',
      frontmatter: { source_slug: 'meetings/m1', concepts: ['theme'] },
    });
    await engine.putPage('atoms/a2', {
      type: 'atom',
      title: 'A2',
      compiled_truth: 'atom two',
      frontmatter: { source_slug: 'meetings/m1', concepts: ['theme'] },
    });

    const check = await computeSynthesizeConceptsBacklogCheck(engine);
    expect(check.status).toBe('fail');
    expect((check.details as { eligible_groups_without_page: number }).eligible_groups_without_page).toBe(1);
    expect((check.details as { missing_source_to_atom: number }).missing_source_to_atom).toBe(2);
  });

  it('OK when source↔atom and concept↔atom graph links are present', async () => {
    await engine.putPage('meetings/m1', {
      type: 'meeting',
      title: 'Meeting',
      compiled_truth: BODY,
      frontmatter: {},
    });
    await engine.putPage('atoms/a1', {
      type: 'atom',
      title: 'A1',
      compiled_truth: 'atom one',
      frontmatter: { source_slug: 'meetings/m1', concepts: ['theme'] },
    });
    await engine.putPage('atoms/a2', {
      type: 'atom',
      title: 'A2',
      compiled_truth: 'atom two',
      frontmatter: { source_slug: 'meetings/m1', concepts: ['theme'] },
    });
    await engine.putPage('concepts/theme', {
      type: 'concept',
      title: 'theme',
      compiled_truth: 'theme narrative',
      frontmatter: {},
    });
    await engine.addLinksBatch([
      { from_slug: 'meetings/m1', to_slug: 'atoms/a1', link_type: 'yielded_atom', link_source: 'test' },
      { from_slug: 'atoms/a1', to_slug: 'meetings/m1', link_type: 'grounded_in_source', link_source: 'test' },
      { from_slug: 'meetings/m1', to_slug: 'atoms/a2', link_type: 'yielded_atom', link_source: 'test' },
      { from_slug: 'atoms/a2', to_slug: 'meetings/m1', link_type: 'grounded_in_source', link_source: 'test' },
      { from_slug: 'concepts/theme', to_slug: 'atoms/a1', link_type: 'grounded_in', link_source: 'test' },
      { from_slug: 'atoms/a1', to_slug: 'concepts/theme', link_type: 'evidence_for', link_source: 'test' },
      { from_slug: 'concepts/theme', to_slug: 'atoms/a2', link_type: 'grounded_in', link_source: 'test' },
      { from_slug: 'atoms/a2', to_slug: 'concepts/theme', link_type: 'evidence_for', link_source: 'test' },
    ]);

    const check = await computeSynthesizeConceptsBacklogCheck(engine);
    expect(check.status).toBe('ok');
    expect((check.details as { eligible_concept_groups: number }).eligible_concept_groups).toBe(1);
  });

  it('matches concept pages and provenance within each source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-a', 'source-a'), ('source-b', 'source-b') ON CONFLICT DO NOTHING`,
    );
    for (const sourceId of ['source-a', 'source-b']) {
      await engine.putPage('meetings/m1', {
        type: 'meeting', title: 'Meeting', compiled_truth: BODY, frontmatter: {},
      }, { sourceId });
      for (const suffix of ['a1', 'a2']) {
        await engine.putPage(`atoms/${suffix}`, {
          type: 'atom', title: suffix, compiled_truth: suffix,
          frontmatter: { source_slug: 'meetings/m1', concepts: ['theme'] },
        }, { sourceId });
      }
      await engine.putPage('concepts/theme', {
        type: 'concept', title: 'theme', compiled_truth: 'theme narrative', frontmatter: {},
      }, { sourceId });
      await engine.addLinksBatch([
        ...['a1', 'a2'].flatMap((suffix) => [
          { from_slug: 'meetings/m1', to_slug: `atoms/${suffix}`, from_source_id: sourceId, to_source_id: sourceId, link_type: 'yielded_atom', link_source: 'test' },
          { from_slug: `atoms/${suffix}`, to_slug: 'meetings/m1', from_source_id: sourceId, to_source_id: sourceId, link_type: 'grounded_in_source', link_source: 'test' },
          { from_slug: 'concepts/theme', to_slug: `atoms/${suffix}`, from_source_id: sourceId, to_source_id: sourceId, link_type: 'grounded_in', link_source: 'test' },
          { from_slug: `atoms/${suffix}`, to_slug: 'concepts/theme', from_source_id: sourceId, to_source_id: sourceId, link_type: 'evidence_for', link_source: 'test' },
        ]),
      ]);
    }

    const check = await computeSynthesizeConceptsBacklogCheck(engine);
    expect(check.status).toBe('ok');
    expect((check.details as { eligible_concept_groups: number }).eligible_concept_groups).toBe(2);
    expect((check.details as { eligible_groups_without_page: number }).eligible_groups_without_page).toBe(0);
  });
});
