import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  aggregateDonors,
  calculateAttributedGift,
  marketIndexAt,
  midpointDate,
  parseUtcDate,
  validateFundingChains,
  validateMarketSeries,
  validateWealthAllocations,
} from '../lib/lcbCalculation.js';
import { normalizeStrictDateString } from '../lib/donationRecords.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../__fixtures__/lcb/synthetic.json'), 'utf8'));

describe('LCB calculation', () => {
  it('shares calendar validation while retaining the stricter calculation input contract', () => {
    expect(parseUtcDate('0000-02-29').toISOString()).toBe('0000-02-29T00:00:00.000Z');
    expect(parseUtcDate('0099-01-01').getUTCFullYear()).toBe(99);
    expect(normalizeStrictDateString(' "0099-01-01" ', 'seed')).toBe('0099-01-01');
    expect(() => parseUtcDate(' "0099-01-01" ')).toThrow('YYYY-MM-DD');
    expect(() => parseUtcDate('bad', 'period start')).toThrow('period start must use YYYY-MM-DD.');
    expect(() => parseUtcDate('2025-02-29', 'period start')).toThrow('period start must be a real calendar date.');
    expect(() => normalizeStrictDateString('bad', 'seed')).toThrow('seed Expected YYYY-MM-DD.');
    expect(() => normalizeStrictDateString('2025-02-29', 'seed')).toThrow('seed Expected a real calendar date.');
    for (const invalid of ['0099-02-29', '2025-02-29', '2024-13-01']) {
      expect(() => parseUtcDate(invalid)).toThrow('real calendar date');
      expect(() => normalizeStrictDateString(invalid, 'seed')).toThrow('real calendar date');
    }
  });

  it('uses independently calculable market and CPI factors', () => {
    const result = calculateAttributedGift({
      event: { amount: 100, effectiveDate: '2020-01-01' },
      credit: 0.5,
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    });
    expect(result.marketFactor).toBeCloseTo(132 / (100 * 1.1 ** (1 / 366)), 12);
    expect(result.inflationFactor).toBe(1.25);
    expect(result.marketContribution).not.toBe(result.inflationContribution);
  });

  it('conserves a joint gift across donor credits', () => {
    const common = {
      event: { amount: 100, effectiveDate: '2020-01-01' },
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    };
    const first = calculateAttributedGift({ ...common, credit: 0.25 });
    const second = calculateAttributedGift({ ...common, credit: 0.75 });
    expect(first.attributedAmount + second.attributedAmount).toBe(100);
    expect(first.marketContribution + second.marketContribution).toBeCloseTo(
      calculateAttributedGift({ ...common, credit: 1 }).marketContribution,
      12
    );
  });

  it('returns factors of one on the snapshot endpoint', () => {
    const result = calculateAttributedGift({
      event: { amount: 25, effectiveDate: fixture.snapshotDate },
      credit: 1,
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    });
    expect(result.marketFactor).toBe(1);
    expect(result.inflationFactor).toBe(1);
  });

  it('uses UTC calendar days across leap years, weekends, and year boundaries', () => {
    expect(midpointDate('2020-01-01', '2020-12-31')).toBe('2020-07-01');
    const saturday = marketIndexAt('2020-02-29', fixture.market);
    const sunday = marketIndexAt('2020-03-01', fixture.market);
    expect(saturday).toBeCloseTo(100 * 1.1 ** (60 / 366), 12);
    expect(sunday).toBeCloseTo(100 * 1.1 ** (61 / 366), 12);
    expect(marketIndexAt('2020-12-31', fixture.market)).toBe(110);
  });

  it('rejects skipped and absent observations instead of extrapolating', () => {
    expect(() => validateMarketSeries([fixture.market[0], fixture.market[2]])).toThrow('skips');
    expect(() => marketIndexAt('2019-01-01', fixture.market)).toThrow('outside saved endpoints');
    expect(() =>
      calculateAttributedGift({
        event: { amount: 10, effectiveDate: '2020-02-01' },
        credit: 1,
        snapshotDate: fixture.snapshotDate,
        market: fixture.market,
        cpi: fixture.cpi,
      })
    ).toThrow('No CPI observation');
  });

  it('reports future gifts as excluded', () => {
    const result = calculateAttributedGift({
      event: { amount: 10, effectiveDate: '2022-01-01' },
      credit: 1,
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    });
    expect(result).toMatchObject({ included: false, exclusionReason: 'after-snapshot' });
    expect(result.usesEstimatedCpi).toBe(false);
  });

  it('labels estimated CPI from the observations actually used', () => {
    const result = calculateAttributedGift({
      event: { amount: 10, effectiveDate: '2020-01-01' },
      credit: 1,
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi.map((row) => ({
        ...row,
        status: row.date === '2020-01-01' ? 'estimated-missing-source' : 'observed',
      })),
    });
    expect(result.usesEstimatedCpi).toBe(true);
  });

  it('carries estimated CPI into donor totals only for included attributed gifts', () => {
    const { rows } = aggregateDonors({
      donors: ['a', 'b', 'c'].map((id) => ({ id, name: id })),
      transfers: [
        {
          fingerprint: 'estimated',
          transferIdentity: 'estimated',
          decision: 'include',
          amount: 100,
          effectiveDate: '2020-01-01',
          credit: { a: 1 },
        },
        {
          fingerprint: 'observed',
          transferIdentity: 'observed',
          decision: 'include',
          amount: 50,
          effectiveDate: '2021-12-31',
          credit: { a: 0.5, b: 0.5 },
        },
        {
          fingerprint: 'excluded',
          transferIdentity: 'excluded',
          decision: 'exclude',
          amount: 100,
          effectiveDate: '2020-01-01',
          credit: { b: 1 },
        },
      ],
      wealthRecords: [],
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi.map((row) => ({
        ...row,
        status: row.date === '2020-01-01' ? 'estimated-missing-source' : 'observed',
      })),
    });
    expect(rows.find((r) => r.donorId === 'a')).toMatchObject({ usesEstimatedCpi: true, inflationAdjustedGiving: 150 });
    expect(rows.find((r) => r.donorId === 'b')).toMatchObject({ usesEstimatedCpi: false, inflationAdjustedGiving: 25 });
    expect(rows.find((r) => r.donorId === 'c')).toMatchObject({
      usesEstimatedCpi: false,
      inflationAdjustedGiving: null,
    });
  });

  it('rejects duplicate funding-chain transfers and overallocated shared wealth', () => {
    expect(() =>
      validateFundingChains([
        { decision: 'include', fingerprint: 'a', fundingChain: 'pool', transferIdentity: 'gift' },
        { decision: 'include', fingerprint: 'b', fundingChain: 'other-donor-set', transferIdentity: 'gift' },
      ])
    ).toThrow('duplicate');
    expect(() =>
      validateWealthAllocations([
        {
          donorId: 'a',
          status: 'matched',
          estimateAtSnapshot: 60,
          sharedPoolId: 'couple',
          allocationShare: 0.6,
          observation: { amountUSD: 100 },
        },
        {
          donorId: 'b',
          status: 'matched',
          estimateAtSnapshot: 50,
          sharedPoolId: 'couple',
          allocationShare: 0.5,
          observation: { amountUSD: 100 },
        },
      ])
    ).toThrow('above 100%');
  });

  it('rejects downstream distributions with different recipient identities', () => {
    expect(() =>
      validateFundingChains([
        {
          decision: 'include',
          fingerprint: 'in',
          fundingChain: 'donor',
          transferIdentity: 'vehicle',
          transferStage: 'vehicle-inflow',
          fundingVehicleId: 'fund',
        },
        {
          decision: 'include',
          fingerprint: 'out',
          fundingChain: 'donor',
          transferIdentity: 'recipient',
          transferStage: 'vehicle-distribution',
          fundingVehicleId: 'fund',
        },
      ])
    ).toThrow('downstream');
  });

  it('conserves allocated dollars and accepts floating point share noise', () => {
    const record = (donorId, share) => ({
      donorId,
      status: 'matched',
      sharedPoolId: 'pool',
      allocationShare: share,
      estimateAtSnapshot: 100 * share,
      observation: { amountUSD: 100, date: '2025-01-01', sourceId: 'source' },
    });
    expect(() => validateWealthAllocations([record('a', 0.5), record('b', 0.5000000000000002)])).not.toThrow();
    expect(() =>
      validateWealthAllocations([{ ...record('a', 0.5), estimateAtSnapshot: 100 }, record('b', 0.5)])
    ).toThrow('allocated pool amount');
    expect(() => validateWealthAllocations([record('a', 0.5), record('a', 0.5)])).toThrow('Duplicate wealth');
    expect(() =>
      validateWealthAllocations([
        record('a', 0.5),
        { ...record('b', 0.5), observation: { amountUSD: 100, date: '2025-02-01', sourceId: 'source' } },
      ])
    ).toThrow('inconsistent observations');
  });

  it('rejects reusing a wealth observation under different individual donors', () => {
    const observation = { sourceId: 'forbes', sourceName: 'Founder', date: '2025-03-07', amountUSD: 100 };
    expect(() =>
      validateWealthAllocations(
        ['a', 'b'].map((donorId) => ({ donorId, status: 'matched', estimateAtSnapshot: 100, observation }))
      )
    ).toThrow('without a shared pool');
  });

  it('keeps missing wealth and no-giving donors unranked while retaining partial donors', () => {
    const result = aggregateDonors({
      donors: [
        { id: 'covered', name: 'Covered', partialGivingHistory: true },
        { id: 'missing', name: 'Missing' },
        { id: 'no-gifts', name: 'No Gifts' },
      ],
      transfers: [
        {
          fingerprint: 'gift',
          decision: 'include',
          fundingChain: 'direct',
          transferIdentity: 'gift',
          amount: 10,
          effectiveDate: '2020-01-01',
          credit: { covered: 1 },
        },
      ],
      wealthRecords: [
        { donorId: 'covered', status: 'matched', estimateAtSnapshot: 100 },
        { donorId: 'missing', status: 'unmatched', estimateAtSnapshot: null },
        { donorId: 'no-gifts', status: 'matched', estimateAtSnapshot: 100 },
      ],
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    });
    expect(result.rows.find((row) => row.donorId === 'covered')).toMatchObject({ rank: 1, partialGivingHistory: true });
    expect(result.rows.find((row) => row.donorId === 'missing').charityAdjustedWealth).toBeNull();
    expect(result.rows.find((row) => row.donorId === 'no-gifts')).toMatchObject({
      rank: null,
      wealthAtSnapshot: 100,
      nominalGiving: null,
      marketAdjustedGiving: null,
      inflationAdjustedGiving: null,
      charityAdjustedWealth: null,
    });
  });
});
