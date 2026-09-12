import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { loadDonations } from '../lib/donationRecords.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDir = path.join(root, 'data/lcb/results');
const resultNames = ['rankings.json', 'rankings.csv', 'transfers.json', 'coverage.json'];
const hashResults = () =>
  resultNames.map((name) =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(resultsDir, name)))
      .digest('hex')
  );

describe('generate LCB data', () => {
  it('generates byte-identical offline outputs and passes drift checking', () => {
    const first = spawnSync(process.execPath, ['scripts/generate-lcb-data.js'], { cwd: root, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    const firstHashes = hashResults();
    const second = spawnSync(process.execPath, ['scripts/generate-lcb-data.js'], { cwd: root, encoding: 'utf8' });
    expect(second.status, second.stderr).toBe(0);
    expect(hashResults()).toEqual(firstHashes);
    const check = spawnSync(process.execPath, ['scripts/generate-lcb-data.js', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr).toBe(0);
  });

  it('keeps JSON and CSV ranking rows aligned', () => {
    const rankings = JSON.parse(fs.readFileSync(path.join(resultsDir, 'rankings.json'), 'utf8'));
    const csv = fs.readFileSync(path.join(resultsDir, 'rankings.csv'), 'utf8');
    expect(csv.trimEnd().split('\n')).toHaveLength(rankings.rows.length + 1);
    for (const row of rankings.rows) expect(csv).toContain(`,${row.donorId},`);
  });

  it('uses the explicit October CPI estimate and dividend-inclusive endpoint ratio', () => {
    const cpi = fs.readFileSync(path.join(root, 'data/lcb/inputs/cpi-u.csv'), 'utf8');
    expect(cpi).toContain('2025-10-01,324.461,estimated-missing-source');
    const transfers = JSON.parse(fs.readFileSync(path.join(resultsDir, 'transfers.json'), 'utf8')).transfers;
    expect(
      transfers.filter((row) => row.effectiveDate.startsWith('2025-10')).every((row) => row.usesEstimatedCpi)
    ).toBe(true);
    const marketRows = fs.readFileSync(path.join(root, 'data/lcb/inputs/sp500-total-return.csv'), 'utf8');
    const value = (year) => Number(marketRows.match(new RegExp(`${year}-12-31,([\\d.]+)`))[1]);
    expect(value(2011) / value(2010)).toBeCloseTo(1.0209837205799197, 14);
  });

  it('regresses material reconciliation and once-only rules', () => {
    const events = loadDonations(path.join(root, 'content/donations'));
    expect(events.some((event) => event.amount === 43_000_000_000 && event.date === '2006-11-25')).toBe(false);
    const buffettGates = events.filter(
      (event) => event.sourcePath.endsWith('warren_buffett.md') && event.recipientId === 'gates-foundation'
    );
    expect(buffettGates.reduce((sum, event) => sum + event.amount, 0)).toBe(47_915_285_000);
    const gatesEvents = events.filter((event) => event.sourcePath.endsWith('bill_gates.md'));
    expect(
      gatesEvents.some((event) =>
        ['united-negro-college-fund', 'gavi-alliance-the-vaccine-fund'].includes(event.recipientId)
      )
    ).toBe(false);
    expect(
      gatesEvents
        .filter((event) => event.recipientId.startsWith('pivotal-philanthropies'))
        .reduce((sum, event) => sum + event.amount, 0)
    ).toBe(10_826_505_730);
  });

  it('accounts for every active donor and event without coercing missing values to zero', () => {
    const coverage = JSON.parse(fs.readFileSync(path.join(resultsDir, 'coverage.json'), 'utf8'));
    const rankings = JSON.parse(fs.readFileSync(path.join(resultsDir, 'rankings.json'), 'utf8'));
    expect(coverage.activeDonors).toBe(78);
    expect(coverage.wealth).toEqual({ matched: 62, unmatched: 8, unusable: 8 });
    expect(coverage.includedTransfers + coverage.excludedTransfers).toBe(coverage.seedEvents);
    expect(
      rankings.rows.filter((row) => row.wealthStatus !== 'matched').every((row) => row.charityAdjustedWealth === null)
    ).toBe(true);
    expect(rankings.rows.every((row) => row.partialGivingHistory)).toBe(true);
  });
});
