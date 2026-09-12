import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDonations } from '../lib/donationRecords.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDir = path.join(root, 'data/lcb/results');
const resultNames = ['rankings.json', 'rankings.csv', 'transfers.json', 'coverage.json'];
const hashResults = (directory = resultsDir) =>
  resultNames.map((name) =>
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(directory, name)))
      .digest('hex')
  );

const workspaces = [];
const setupWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'impactlist-lcb-'));
  workspaces.push(workspace);
  for (const directory of ['content/donors', 'content/donations', 'data/lcb']) {
    fs.cpSync(path.join(root, directory), path.join(workspace, directory), { recursive: true });
  }
  for (const file of [
    'scripts/generate-lcb-data.js',
    'scripts/lib/donationRecords.js',
    'scripts/lib/lcbCalculation.js',
    'src/utils/dataValidation.js',
    'src/utils/constants.js',
    'src/utils/globalParameterRules.js',
    'src/utils/typeGuards.js',
  ]) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(workspace, file));
  }
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
  return workspace;
};
const runGenerator = (workspace, args = [], cwd = workspace) =>
  spawnSync(process.execPath, [path.join(workspace, 'scripts/generate-lcb-data.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
const editInput = (workspace, file, edit) => {
  const target = path.join(workspace, 'data/lcb/inputs', file);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  edit(value);
  fs.writeFileSync(target, JSON.stringify(value));
};
afterEach(() => {
  while (workspaces.length) fs.rmSync(workspaces.pop(), { recursive: true, force: true });
});

describe('generate LCB data', () => {
  it('generates byte-identical offline outputs and passes drift checking', () => {
    const originalHashes = hashResults();
    const workspace = setupWorkspace();
    const output = path.join(workspace, 'data/lcb/results');
    const first = runGenerator(workspace);
    expect(first.status, first.stderr).toBe(0);
    const firstHashes = hashResults(output);
    const second = runGenerator(workspace, [], path.join(workspace, 'scripts'));
    expect(second.status, second.stderr).toBe(0);
    expect(hashResults(output)).toEqual(firstHashes);
    const check = runGenerator(workspace, ['--check'], path.join(workspace, 'scripts'));
    expect(check.status, check.stderr).toBe(0);
    expect(hashResults()).toEqual(originalHashes);
  });

  it.each([
    ['duplicate wealth', 'wealth.json', (data) => data.records.push({ ...data.records[0] }), 'Duplicate wealth'],
    [
      'missing observation',
      'wealth.json',
      (data) => {
        data.records[0].observation = null;
      },
      'sourced observation',
    ],
    [
      'future observation',
      'wealth.json',
      (data) => {
        data.records[0].observation.date = '2026-01-01';
      },
      'ineligible observation',
    ],
    [
      'invalid observation date',
      'wealth.json',
      (data) => {
        data.records[0].observation.date = '2025-02-30';
      },
      'real calendar date',
    ],
    [
      'changed carried wealth',
      'wealth.json',
      (data) => {
        data.records[0].estimateAtSnapshot += 1;
      },
      'forward unchanged',
    ],
    [
      'wealth snapshot mismatch',
      'wealth.json',
      (data) => {
        data.snapshotDate = '2024-12-31';
      },
      'snapshotDate does not match',
    ],
    [
      'transfer snapshot mismatch',
      'transfers.json',
      (data) => {
        data.snapshotDate = '2024-12-31';
      },
      'snapshotDate does not match',
    ],
    ['stale partial donor', 'transfers.json', (data) => data.partialDonorIds.push('stale'), 'unique active donor'],
    [
      'unknown overlap',
      'transfers.json',
      (data) => data.unresolvedBalances[0].overlapLinks.push('missing'),
      'unresolved overlap link',
    ],
    [
      'unresolved interval date',
      'transfers.json',
      (data) => {
        Object.values(data.dispositions).find((d) => d.datePrecision === 'unresolved-interval').effectiveDate =
          '2025-01-01';
      },
      'null effectiveDate',
    ],
    [
      'period containment',
      'transfers.json',
      (data) => {
        const d = Object.values(data.dispositions).find((d) => d.datePrecision === 'period');
        d.periodStart = '2025-01-01';
        d.periodEnd = '2025-12-31';
      },
      'contain its seed date',
    ],
    [
      'missing evidence state',
      'sources.json',
      (data) => {
        delete data.sources[0].savedSource;
      },
      'explicit nulls',
    ],
    [
      'included downstream',
      'transfers.json',
      (data) => {
        const d = Object.values(data.dispositions).find((d) => d.transferStage === 'vehicle-distribution');
        d.decision = 'include';
        d.exclusionReason = null;
      },
      'downstream',
    ],
    [
      'missing disposition',
      'transfers.json',
      (data) => {
        delete data.dispositions[Object.keys(data.dispositions)[0]];
      },
      'no disposition',
    ],
    [
      'stale fingerprint',
      'transfers.json',
      (data) => {
        data.dispositions.stale = {};
      },
      'stale fingerprint',
    ],
    [
      'missing wealth donor',
      'wealth.json',
      (data) => {
        data.records.pop();
      },
      'omit active donor',
    ],
    [
      'unknown wealth donor',
      'wealth.json',
      (data) => {
        data.records.push({ donorId: 'unknown-person' });
      },
      'unknown donor',
    ],
    [
      'unknown wealth source',
      'wealth.json',
      (data) => {
        data.records.find((row) => row.observation).observation.sourceId = 'missing';
      },
      'unknown source',
    ],
    [
      'source hash mismatch',
      'sources.json',
      (data) => {
        data.sources.find((row) => row.savedSource).savedSourceSha256 = 'wrong';
      },
      'hash is',
    ],
    [
      'decision typo',
      'transfers.json',
      (data) => {
        Object.values(data.dispositions)[0].decision = 'includ';
      },
      'invalid decision',
    ],
    [
      'seed override',
      'transfers.json',
      (data) => {
        Object.values(data.dispositions)[0].amount = 1;
      },
      'unknown field amount',
    ],
    [
      'wrong midpoint',
      'transfers.json',
      (data) => {
        Object.values(data.dispositions).find((row) => row.datePrecision === 'year').effectiveDate = '2020-01-01';
      },
      'effectiveDate must be',
    ],
    [
      'unknown precision',
      'transfers.json',
      (data) => {
        Object.values(data.dispositions)[0].datePrecision = 'approximately';
      },
      'invalid datePrecision',
    ],
  ])('fails loudly for %s without rewriting exports', (_name, file, edit, message) => {
    const workspace = setupWorkspace();
    const output = path.join(workspace, 'data/lcb/results');
    const before = hashResults(output);
    editInput(workspace, file, edit);
    const result = runGenerator(workspace);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(hashResults(output)).toEqual(before);
  });

  it('rejects an unlabeled October estimate', () => {
    const workspace = setupWorkspace();
    const file = path.join(workspace, 'data/lcb/inputs/cpi-u.csv');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('estimated-missing-source', 'observed'));
    const result = runGenerator(workspace);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('October 2025 CPI');
  });

  it('keeps JSON and CSV ranking rows aligned', () => {
    const rankings = JSON.parse(fs.readFileSync(path.join(resultsDir, 'rankings.json'), 'utf8'));
    const csv = fs.readFileSync(path.join(resultsDir, 'rankings.csv'), 'utf8');
    const [header, ...lines] = csv.trimEnd().split('\n');
    const columns = header.split(',');
    expect(columns).toEqual([
      'rank',
      'donorId',
      'name',
      'snapshotDate',
      'wealthRecordReference',
      'wealthStatus',
      'wealthAtSnapshot',
      'nominalGiving',
      'marketAdjustedGiving',
      'inflationAdjustedGiving',
      'charityAdjustedWealth',
      'partialGivingHistory',
    ]);
    const parsed = lines.map((line) =>
      [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
        .slice(0, -1)
        .map((match) => (match[1].startsWith('"') ? match[1].slice(1, -1).replaceAll('""', '"') : match[1]))
    );
    expect(parsed).toEqual(
      rankings.rows.map((row) => columns.map((column) => (row[column] === null ? '' : String(row[column]))))
    );
  });

  it.each([
    ['2024-02-29', 'month', {}, '2024-02-15'],
    ['2025-12-01', 'month', {}, '2025-12-16'],
    ['2020-04-05', 'period', { periodStart: '2019-04-06', periodEnd: '2020-04-05' }, '2019-10-05'],
  ])('aligns %s with %s precision', (seedDate, precision, bounds, expectedDate) => {
    const workspace = setupWorkspace();
    const event = loadDonations(path.join(workspace, 'content/donations')).find((e) => e.date === seedDate);
    expect(event).toBeDefined();
    editInput(workspace, 'transfers.json', (data) =>
      Object.assign(data.dispositions[event.fingerprint], {
        decision: 'include',
        exclusionReason: null,
        datePrecision: precision,
        transferStage: 'personal-transfer',
        fundingVehicleId: null,
        effectiveDate: expectedDate,
        ...bounds,
      })
    );
    const result = runGenerator(workspace);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(fs.readFileSync(path.join(workspace, 'data/lcb/results/transfers.json')));
    expect(output.transfers.find((t) => t.fingerprint === event.fingerprint).effectiveDate).toBe(expectedDate);
  });

  it('preserves an explicit exclusion reason for a future event', () => {
    const workspace = setupWorkspace();
    const ledger = JSON.parse(fs.readFileSync(path.join(workspace, 'data/lcb/inputs/transfers.json')));
    const fingerprint = Object.keys(ledger.dispositions).find(
      (id) => ledger.dispositions[id].effectiveDate > '2025-12-31'
    );
    editInput(workspace, 'transfers.json', (data) =>
      Object.assign(data.dispositions[fingerprint], { decision: 'exclude', exclusionReason: 'unverified-commitment' })
    );
    const result = runGenerator(workspace);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(fs.readFileSync(path.join(workspace, 'data/lcb/results/transfers.json')));
    expect(output.transfers.find((t) => t.fingerprint === fingerprint).exclusionReason).toBe('unverified-commitment');
  });

  it('independently recomputes an exported donor total and rank', () => {
    const rankings = JSON.parse(fs.readFileSync(path.join(resultsDir, 'rankings.json')));
    const transfers = JSON.parse(fs.readFileSync(path.join(resultsDir, 'transfers.json'))).transfers;
    const giving = transfers.filter((t) => t.decision === 'include' && t.credit['dietmar-hopp']);
    expect(giving).toHaveLength(1);
    expect(giving[0]).toMatchObject({
      amountUSD: 2_971_250,
      effectiveDate: '2004-07-01',
      credit: { 'dietmar-hopp': 1 },
    });
    const endpoints = fs
      .readFileSync(path.join(root, 'data/lcb/inputs/sp500-total-return.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(','));
    const value = (year) => Number(endpoints.find(([date]) => date === `${year}-12-31`)[1]);
    const expectedMarket = (2_971_250 * value(2025)) / (value(2003) * (value(2004) / value(2003)) ** (183 / 366));
    const row = rankings.rows.find((r) => r.donorId === 'dietmar-hopp');
    expect(row.marketAdjustedGiving).toBeCloseTo(expectedMarket, 2);
    expect(row.nominalGiving).toBe(2_971_250);
    expect(row.rank).toBeGreaterThan(0);
    const ranked = rankings.rows.filter((r) => r.rank !== null);
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
    for (const r of ranked) expect(r.charityAdjustedWealth).toBeCloseTo(r.wealthAtSnapshot + r.marketAdjustedGiving, 1);
  });

  it('uses the explicit October CPI estimate and dividend-inclusive endpoint ratio', () => {
    const cpi = fs.readFileSync(path.join(root, 'data/lcb/inputs/cpi-u.csv'), 'utf8');
    expect(cpi).toContain('2025-10-01,324.461,estimated-missing-source');
    const transfers = JSON.parse(fs.readFileSync(path.join(resultsDir, 'transfers.json'), 'utf8')).transfers;
    expect(
      transfers
        .filter((row) => row.decision === 'include' && row.effectiveDate?.startsWith('2025-10'))
        .every((row) => row.usesEstimatedCpi)
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
    const transfers = JSON.parse(fs.readFileSync(path.join(resultsDir, 'transfers.json'), 'utf8')).transfers;
    for (const [file, amount] of [
      ['david_sainsbury.md', 1_837_499_000],
      ['michael_bloomberg.md', 21_000_000_000],
      ['jensen_huang.md', 2_000_000_000],
      ['hasso_plattner.md', 10_900_000_000],
    ]) {
      expect(transfers.find((row) => row.sourcePath.endsWith(file) && row.amountUSD === amount)).toMatchObject({
        decision: 'exclude',
        exclusionReason: 'unresolved-interval',
        effectiveDate: null,
      });
    }
    expect(transfers.find((row) => row.amountUSD === 19_515_465_281)).toMatchObject({
      datePrecision: 'day',
      effectiveDate: '2022-12-31',
    });
    expect(transfers.find((row) => row.amountUSD === 116_482_000)).toMatchObject({
      datePrecision: 'period',
      periodStart: '2019-04-06',
      periodEnd: '2020-04-05',
    });
  });

  it('accounts for every active donor and event without coercing missing values to zero', () => {
    const coverage = JSON.parse(fs.readFileSync(path.join(resultsDir, 'coverage.json'), 'utf8'));
    const rankings = JSON.parse(fs.readFileSync(path.join(resultsDir, 'rankings.json'), 'utf8'));
    expect(coverage.activeDonors).toBe(rankings.rows.length);
    for (const [status, count] of Object.entries(coverage.wealth)) {
      expect(count).toBe(rankings.rows.filter((row) => row.wealthStatus === status).length);
    }
    expect(coverage.includedTransfers + coverage.excludedTransfers).toBe(coverage.seedEvents);
    const transfers = JSON.parse(fs.readFileSync(path.join(resultsDir, 'transfers.json'), 'utf8')).transfers;
    expect(coverage.futureTransfers).toBe(transfers.filter((row) => row.effectiveDate > coverage.snapshotDate).length);
    expect(
      transfers.filter((row) => row.effectiveDate > coverage.snapshotDate).every((row) => row.decision === 'exclude')
    ).toBe(true);
    expect(
      rankings.rows.filter((row) => row.wealthStatus !== 'matched').every((row) => row.charityAdjustedWealth === null)
    ).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data/lcb/inputs/transfers.json'), 'utf8'));
    expect(
      rankings.rows
        .filter((row) => row.partialGivingHistory)
        .map((row) => row.donorId)
        .sort()
    ).toEqual([...ledger.partialDonorIds].sort());
  });
});
