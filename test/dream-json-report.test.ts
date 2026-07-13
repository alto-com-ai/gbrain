import { describe, expect, test } from 'bun:test';
import { serializeDreamReportJson } from '../src/commands/dream.ts';
import type { CycleReport } from '../src/core/cycle.ts';

describe('serializeDreamReportJson', () => {
  test('keeps oversized reports valid and below the transport ceiling', () => {
    const report = {
      schema_version: '1',
      timestamp: '2026-07-13T00:00:00.000Z',
      duration_ms: 123,
      status: 'partial',
      brain_dir: '/brain',
      phases: Array.from({ length: 30 }, (_, phaseIndex) => ({
        phase: 'purge',
        status: phaseIndex === 29 ? 'fail' : 'warn',
        duration_ms: 12,
        summary: 'completed with warnings',
        details: {
          pack_gated: false,
          slugs: Array.from({ length: 5_000 }, (_, i) => `very-long-page-slug-${i}-${'x'.repeat(80)}`),
        },
      })),
      totals: { pages_synced: 0 },
    } as unknown as CycleReport;

    const json = serializeDreamReportJson(report);
    const parsed = JSON.parse(json);

    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(parsed.status).toBe('partial');
    expect(parsed.phases).toHaveLength(30);
    expect(parsed.phases[29].status).toBe('fail');
    expect(parsed.phases[0].details.pack_gated).toBe(false);
    expect(parsed.phases[0].details.slugs.length).toBeLessThan(5_000);
  });
});
