import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  aggregateDonors,
  calculateAttributedGift,
  marketIndexAt,
  midpointDate,
  validateFundingChains,
  validateMarketSeries,
  validateWealthAllocations,
} from '../lib/lcbCalculation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../__fixtures__/lcb/synthetic.json'), 'utf8'));

describe('LCB calculation', () => {
  it('uses independently calculable market and CPI factors', () => {
    const result = calculateAttributedGift({
      event: { amount: 100, effectiveDate: '2020-01-01' },
      credit: 0.5,
      snapshotDate: fixture.snapshotDate,
      market: fixture.market,
      cpi: fixture.cpi,
    });
    expect(result.marketFactor).toBeCloseTo(132 / marketIndexAt('2020-01-01', fixture.market), 12);
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
    expect(sunday).toBeGreaterThan(saturday);
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

  it('rejects duplicate funding-chain transfers and overallocated shared wealth', () => {
    expect(() =>
      validateFundingChains([
        { decision: 'include', fingerprint: 'a', fundingChain: 'pool', transferIdentity: 'gift' },
        { decision: 'include', fingerprint: 'b', fundingChain: 'pool', transferIdentity: 'gift' },
      ])
    ).toThrow('duplicate');
    expect(() =>
      validateWealthAllocations([
        { donorId: 'a', status: 'matched', estimateAtSnapshot: 1, sharedPoolId: 'couple', allocationShare: 0.6 },
        { donorId: 'b', status: 'matched', estimateAtSnapshot: 1, sharedPoolId: 'couple', allocationShare: 0.5 },
      ])
    ).toThrow('above 100%');
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
