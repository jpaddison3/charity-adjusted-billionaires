/* eslint-env node */

import { parseStrictUtcDate as parseUtcDate } from './strictDate.js';

export { parseUtcDate };

const DAY_MS = 24 * 60 * 60 * 1000;
const compareIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function midpointDate(start, end) {
  const startDate = parseUtcDate(start, 'period start');
  const endDate = parseUtcDate(end, 'period end');
  const days = (endDate - startDate) / DAY_MS;
  if (!Number.isInteger(days) || days < 0) throw new Error('Period end must not precede period start.');
  return new Date(startDate.valueOf() + Math.floor(days / 2) * DAY_MS).toISOString().slice(0, 10);
}

function assertPositiveObservation(observation, label) {
  if (!Number.isFinite(observation.value) || observation.value <= 0) {
    throw new Error(`${label} observation ${observation.date} must have a positive finite value.`);
  }
}

export function validateMarketSeries(observations) {
  if (!Array.isArray(observations) || observations.length < 2) {
    throw new Error('Market series needs at least two year-end observations.');
  }
  observations.forEach((observation, index) => {
    assertPositiveObservation(observation, 'Market');
    const date = parseUtcDate(observation.date, 'market observation date');
    if (date.getUTCMonth() !== 11 || date.getUTCDate() !== 31) {
      throw new Error(`Market observation ${observation.date} is not a December 31 endpoint.`);
    }
    if (index > 0) {
      const previousYear = Number(observations[index - 1].date.slice(0, 4));
      const year = Number(observation.date.slice(0, 4));
      if (year !== previousYear + 1) throw new Error(`Market series skips the ${previousYear + 1} endpoint.`);
    }
  });
  return observations;
}

export function marketIndexAt(dateValue, observations) {
  const date = parseUtcDate(dateValue, 'market valuation date');
  validateMarketSeries(observations);
  const exact = observations.find((observation) => observation.date === dateValue);
  if (exact) return exact.value;

  const afterIndex = observations.findIndex((observation) => parseUtcDate(observation.date) > date);
  if (afterIndex <= 0) throw new Error(`Market valuation date ${dateValue} is outside saved endpoints.`);
  const before = observations[afterIndex - 1];
  const after = observations[afterIndex];
  const beforeDate = parseUtcDate(before.date);
  const afterDate = parseUtcDate(after.date);
  const elapsed = (date - beforeDate) / DAY_MS;
  const interval = (afterDate - beforeDate) / DAY_MS;
  return before.value * (after.value / before.value) ** (elapsed / interval);
}

export function cpiAt(dateValue, observations) {
  parseUtcDate(dateValue, 'CPI valuation date');
  const key = `${dateValue.slice(0, 7)}-01`;
  const observation = observations.find((candidate) => candidate.date === key);
  if (!observation) throw new Error(`No CPI observation is saved for ${key}.`);
  assertPositiveObservation(observation, 'CPI');
  return observation.value;
}

export function calculateAttributedGift({ event, credit, snapshotDate, market, cpi }) {
  if (!Number.isFinite(event.amount) || event.amount <= 0) throw new Error('Gift amount must be positive and finite.');
  if (!Number.isFinite(credit) || credit <= 0 || credit > 1) throw new Error('Gift credit must be in (0, 1].');
  if (parseUtcDate(event.effectiveDate) > parseUtcDate(snapshotDate)) {
    return {
      attributedAmount: event.amount * credit,
      included: false,
      exclusionReason: 'after-snapshot',
      marketFactor: null,
      inflationFactor: null,
      marketContribution: null,
      inflationContribution: null,
      usesEstimatedCpi: false,
    };
  }
  const attributedAmount = event.amount * credit;
  const marketFactor = marketIndexAt(snapshotDate, market) / marketIndexAt(event.effectiveDate, market);
  const inflationFactor = cpiAt(snapshotDate, cpi) / cpiAt(event.effectiveDate, cpi);
  return {
    attributedAmount,
    included: true,
    exclusionReason: null,
    marketFactor,
    inflationFactor,
    marketContribution: attributedAmount * marketFactor,
    inflationContribution: attributedAmount * inflationFactor,
    usesEstimatedCpi: [snapshotDate, event.effectiveDate].some((date) =>
      cpi.find((observation) => observation.date === `${date.slice(0, 7)}-01`)?.status?.startsWith('estimated')
    ),
  };
}

export function validateFundingChains(events) {
  const identities = new Map();
  for (const event of events.filter((candidate) => candidate.decision === 'include')) {
    if (event.transferStage === 'vehicle-distribution') {
      throw new Error(`Transfer ${event.fingerprint} is a downstream vehicle distribution, not a personal inflow.`);
    }
    const identityKey = event.transferIdentity;
    const existing = identities.get(identityKey);
    if (existing) throw new Error(`Included transfers ${existing} and ${event.fingerprint} duplicate ${identityKey}.`);
    identities.set(identityKey, event.fingerprint);
  }
}

export function validateWealthAllocations(wealthRecords) {
  const allocations = new Map();
  const donorIds = new Set();
  const observationOwners = new Map();
  for (const record of wealthRecords) {
    if (donorIds.has(record.donorId)) throw new Error(`Duplicate wealth record for ${record.donorId}.`);
    donorIds.add(record.donorId);
    if (record.status !== 'matched') continue;
    if (record.observation) {
      const key = JSON.stringify(
        ['sourceId', 'sourceName', 'date', 'amountUSD'].map((field) => record.observation[field])
      );
      const owner = observationOwners.get(key);
      if (owner && (!record.sharedPoolId || record.sharedPoolId !== owner.sharedPoolId)) {
        throw new Error(`Wealth observation reused by ${owner.donorId} and ${record.donorId} without a shared pool.`);
      }
      observationOwners.set(key, record);
    }
    if (!Number.isFinite(record.estimateAtSnapshot) || record.estimateAtSnapshot < 0) {
      throw new Error(`Matched wealth record ${record.donorId} needs a non-negative estimate.`);
    }
    if (record.sharedPoolId) {
      const share = record.allocationShare;
      if (!Number.isFinite(share) || share <= 0 || share > 1) {
        throw new Error(`Shared wealth record ${record.donorId} needs allocationShare in (0, 1].`);
      }
      const observation = record.observation;
      if (!Number.isFinite(observation?.amountUSD) || observation.amountUSD < 0) {
        throw new Error(`Shared wealth record ${record.donorId} needs a pool observation.`);
      }
      const expected = observation.amountUSD * share;
      if (Math.abs(record.estimateAtSnapshot - expected) > Math.max(0.005, expected * 1e-12)) {
        throw new Error(`Shared wealth record ${record.donorId} estimate must equal its allocated pool amount.`);
      }
      const pool = allocations.get(record.sharedPoolId);
      if (pool && ['amountUSD', 'date', 'sourceId'].some((key) => pool.observation[key] !== observation[key])) {
        throw new Error(`Shared wealth pool ${record.sharedPoolId} has inconsistent observations.`);
      }
      allocations.set(record.sharedPoolId, { share: (pool?.share ?? 0) + share, observation });
    }
  }
  for (const [poolId, { share }] of allocations) {
    if (share > 1 + 1e-12) throw new Error(`Shared wealth pool ${poolId} is allocated at ${share}, above 100%.`);
  }
}

export function aggregateDonors({ donors, transfers, wealthRecords, snapshotDate, market, cpi }) {
  validateFundingChains(transfers);
  validateWealthAllocations(wealthRecords);
  const byDonor = new Map(
    donors.map((donor) => [
      donor.id,
      {
        donorId: donor.id,
        name: donor.name,
        giftCount: 0,
        nominalGiving: 0,
        marketAdjustedGiving: 0,
        inflationAdjustedGiving: 0,
        usesEstimatedCpi: false,
        partialGivingHistory: Boolean(donor.partialGivingHistory),
      },
    ])
  );
  const transferResults = [];

  for (const transfer of transfers) {
    for (const [donorId, credit] of Object.entries(transfer.credit)) {
      const donor = byDonor.get(donorId);
      if (!donor) throw new Error(`Transfer ${transfer.fingerprint} references unknown donor ${donorId}.`);
      if (transfer.decision !== 'include') continue;
      const result = calculateAttributedGift({ event: transfer, credit, snapshotDate, market, cpi });
      transferResults.push({ fingerprint: transfer.fingerprint, donorId, credit, ...result });
      if (!result.included) continue;
      donor.giftCount += 1;
      donor.nominalGiving += result.attributedAmount;
      donor.marketAdjustedGiving += result.marketContribution;
      donor.inflationAdjustedGiving += result.inflationContribution;
      donor.usesEstimatedCpi ||= result.usesEstimatedCpi;
    }
  }

  const wealthByDonor = new Map(wealthRecords.map((record) => [record.donorId, record]));
  const rows = [...byDonor.values()].map((donor) => {
    const wealth = wealthByDonor.get(donor.donorId);
    const ranked = wealth?.status === 'matched' && donor.giftCount > 0;
    return {
      ...donor,
      wealthStatus: wealth?.status ?? 'unmatched',
      wealthAtSnapshot: wealth?.status === 'matched' ? wealth.estimateAtSnapshot : null,
      charityAdjustedWealth: ranked ? wealth.estimateAtSnapshot + donor.marketAdjustedGiving : null,
      nominalGiving: donor.giftCount > 0 ? donor.nominalGiving : null,
      marketAdjustedGiving: donor.giftCount > 0 ? donor.marketAdjustedGiving : null,
      inflationAdjustedGiving: donor.giftCount > 0 ? donor.inflationAdjustedGiving : null,
      rank: null,
    };
  });
  const ranked = rows
    .filter((row) => row.charityAdjustedWealth !== null)
    .sort((a, b) => b.charityAdjustedWealth - a.charityAdjustedWealth || compareIds(a.donorId, b.donorId));
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || compareIds(a.donorId, b.donorId));
  return { rows, transferResults };
}

export const roundUsd = (value) => (value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100);
