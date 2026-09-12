#!/usr/bin/env node

/* eslint-env node */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { glob } from 'glob';
import { aggregateDonors, midpointDate, parseUtcDate, roundUsd } from './lib/lcbCalculation.js';
import { loadDonations } from './lib/donationRecords.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputsDir = path.join(root, 'data/lcb/inputs');
const resultsDir = path.join(root, 'data/lcb/results');
const contentDir = path.join(root, 'content');
const checkOnly = process.argv.includes('--check');

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(inputsDir, name), 'utf8'));
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  const string = String(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
};

function readCsv(name) {
  const [header, ...lines] = fs.readFileSync(path.join(inputsDir, name), 'utf8').trimEnd().split('\n');
  const columns = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [columns[index], value])));
}

function loadDonors() {
  return glob
    .sync(path.join(contentDir, 'donors/*.md'))
    .sort()
    .filter((file) => path.basename(file) !== '_index.md')
    .map((file) => matter(fs.readFileSync(file, 'utf8')).data)
    .map(({ id, name }) => ({ id, name }));
}

function assertHash(source) {
  if (!source.savedSource || !source.savedSourceSha256) return;
  const bytes = fs.readFileSync(path.join(inputsDir, source.savedSource));
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== source.savedSourceSha256) {
    throw new Error(`Saved source ${source.savedSource} hash is ${actual}; expected ${source.savedSourceSha256}.`);
  }
}

function resolveTransfer(event, disposition, sourceIds, snapshotDate) {
  const context = `Transfer disposition ${event.fingerprint} (${event.sourcePath} ${event.rowLocator})`;
  const fields = new Set([
    'decision',
    'exclusionReason',
    'datePrecision',
    'effectiveDate',
    'transferIdentity',
    'fundingChain',
    'cumulativePeriodMembership',
    'sourceIds',
    'estimationRationale',
    'periodStart',
    'periodEnd',
  ]);
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
    throw new Error(`${context} must be an object.`);
  }
  for (const field of Object.keys(disposition)) {
    if (!fields.has(field)) throw new Error(`${context} has unknown field ${field}.`);
  }
  if (!['include', 'exclude'].includes(disposition.decision)) {
    throw new Error(`${context} has invalid decision.`);
  }
  if (
    disposition.decision === 'include'
      ? disposition.exclusionReason !== null
      : typeof disposition.exclusionReason !== 'string' || !disposition.exclusionReason.trim()
  ) {
    throw new Error(`${context} has an invalid exclusionReason for its decision.`);
  }
  for (const field of ['transferIdentity', 'fundingChain', 'estimationRationale']) {
    if (typeof disposition[field] !== 'string' || !disposition[field].trim()) {
      throw new Error(`${context} needs ${field}.`);
    }
  }
  for (const field of ['sourceIds', 'cumulativePeriodMembership']) {
    if (!Array.isArray(disposition[field]) || disposition[field].some((id) => typeof id !== 'string' || !id)) {
      throw new Error(`${context} needs a ${field} array of non-empty strings.`);
    }
  }
  if (
    !disposition.sourceIds.length ||
    disposition.sourceIds.some((id) => !sourceIds.has(id) && !/^https?:\/\//.test(id))
  ) {
    throw new Error(`${context} references an unknown or missing source.`);
  }
  let expectedDate;
  const year = event.date.slice(0, 4);
  if (disposition.datePrecision !== 'period' && ('periodStart' in disposition || 'periodEnd' in disposition)) {
    throw new Error(`${context} has period bounds without period precision.`);
  }
  if (disposition.datePrecision === 'unresolved-interval') {
    if (disposition.decision !== 'exclude' || disposition.effectiveDate !== null) {
      throw new Error(`${context} must exclude an unresolved interval with a null effectiveDate.`);
    }
  } else {
    if (disposition.datePrecision === 'day') expectedDate = event.date;
    else if (disposition.datePrecision === 'month') {
      const start = `${event.date.slice(0, 7)}-01`;
      const next = parseUtcDate(start);
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(0);
      expectedDate = midpointDate(start, next.toISOString().slice(0, 10));
    } else if (disposition.datePrecision === 'year') {
      expectedDate = midpointDate(`${year}-01-01`, `${year}-12-31`);
    } else if (disposition.datePrecision === 'period') {
      expectedDate = midpointDate(disposition.periodStart, disposition.periodEnd);
      if (event.date < disposition.periodStart || event.date > disposition.periodEnd) {
        throw new Error(`${context} reporting period must contain its seed date.`);
      }
    } else throw new Error(`${context} has invalid datePrecision.`);
    if (disposition.effectiveDate !== expectedDate) {
      throw new Error(`${context} effectiveDate must be ${expectedDate} for its datePrecision.`);
    }
  }
  const transfer = { ...event, ...disposition };
  return transfer.effectiveDate && transfer.effectiveDate > snapshotDate
    ? { ...transfer, decision: 'exclude', exclusionReason: 'after-snapshot' }
    : transfer;
}

function buildOutputs() {
  const snapshot = readJson('snapshot.json');
  parseUtcDate(snapshot.snapshotDate, 'snapshot date');
  const sources = readJson('sources.json');
  readJson('reconciliation.json');
  sources.sources.forEach(assertHash);
  const sourceIds = new Set(sources.sources.map((source) => source.id));
  const donorProfiles = loadDonors();
  const donorIds = new Set(donorProfiles.map((donor) => donor.id));
  const seedEvents = loadDonations(path.join(contentDir, 'donations'));
  const ledger = readJson('transfers.json');
  const wealth = readJson('wealth.json');
  const market = readCsv('sp500-total-return.csv').map((row) => ({ ...row, value: Number(row.value) }));
  const cpi = readCsv('cpi-u.csv').map((row) => ({ ...row, value: Number(row.value) }));

  const september = cpi.find((row) => row.date === '2025-09-01')?.value;
  const october = cpi.find((row) => row.date === '2025-10-01');
  const november = cpi.find((row) => row.date === '2025-11-01')?.value;
  if (october?.status !== 'estimated-missing-source' || october.value !== (september + november) / 2) {
    throw new Error('October 2025 CPI must be the labeled arithmetic mean of September and November.');
  }

  const fingerprints = new Set(seedEvents.map((event) => event.fingerprint));
  const dispositions = ledger.dispositions;
  for (const event of seedEvents) {
    if (!dispositions[event.fingerprint]) {
      throw new Error(
        `Transfer ledger has no disposition for ${event.fingerprint} (${event.sourcePath} ${event.rowLocator}).`
      );
    }
  }
  for (const fingerprint of Object.keys(dispositions)) {
    if (!fingerprints.has(fingerprint)) throw new Error(`Transfer ledger contains stale fingerprint ${fingerprint}.`);
  }
  const wealthIds = new Set(wealth.records.map((record) => record.donorId));
  for (const donorId of donorIds) {
    if (!wealthIds.has(donorId)) throw new Error(`Wealth inputs omit active donor ${donorId}.`);
  }
  for (const record of wealth.records) {
    if (!donorIds.has(record.donorId)) throw new Error(`Wealth inputs reference unknown donor ${record.donorId}.`);
    for (const sourceId of [record.observation?.sourceId, record.observation?.conversionSourceId].filter(Boolean)) {
      if (!sourceIds.has(sourceId))
        throw new Error(`Wealth input ${record.donorId} references unknown source ${sourceId}.`);
    }
  }

  const partialIds = new Set(ledger.partialDonorIds);
  const donors = donorProfiles.map((donor) => ({ ...donor, partialGivingHistory: partialIds.has(donor.id) }));
  const transfers = seedEvents.map((event) =>
    resolveTransfer(event, dispositions[event.fingerprint], sourceIds, snapshot.snapshotDate)
  );
  const { rows, transferResults } = aggregateDonors({
    donors,
    transfers,
    wealthRecords: wealth.records,
    snapshotDate: snapshot.snapshotDate,
    market,
    cpi,
  });
  const resultByTransferDonor = new Map(
    transferResults.map((result) => [`${result.fingerprint}:${result.donorId}`, result])
  );
  const roundedRows = rows.map((row) => ({
    ...row,
    nominalGiving: roundUsd(row.nominalGiving),
    marketAdjustedGiving: roundUsd(row.marketAdjustedGiving),
    inflationAdjustedGiving: roundUsd(row.inflationAdjustedGiving),
    wealthAtSnapshot: roundUsd(row.wealthAtSnapshot),
    charityAdjustedWealth: roundUsd(row.charityAdjustedWealth),
  }));
  const transferOutput = transfers.map((transfer) => ({
    fingerprint: transfer.fingerprint,
    sourcePath: transfer.sourcePath,
    rowLocator: transfer.rowLocator,
    originalDate: transfer.date,
    datePrecision: transfer.datePrecision,
    effectiveDate: transfer.effectiveDate,
    ...(transfer.periodStart ? { periodStart: transfer.periodStart, periodEnd: transfer.periodEnd } : {}),
    recipientId: transfer.recipientId,
    amountUSD: transfer.amount,
    credit: transfer.credit,
    decision: transfer.decision,
    exclusionReason: transfer.exclusionReason ?? null,
    transferIdentity: transfer.transferIdentity,
    fundingChain: transfer.fundingChain,
    cumulativePeriodMembership: transfer.cumulativePeriodMembership,
    sourceIds: transfer.sourceIds,
    estimationRationale: transfer.estimationRationale,
    usesEstimatedCpi: Object.keys(transfer.credit).some(
      (donorId) => resultByTransferDonor.get(`${transfer.fingerprint}:${donorId}`)?.usesEstimatedCpi
    ),
    attributions: Object.keys(transfer.credit).map((donorId) => {
      const result = resultByTransferDonor.get(`${transfer.fingerprint}:${donorId}`);
      return result
        ? {
            donorId,
            credit: result.credit,
            marketFactor: result.marketFactor,
            inflationFactor: result.inflationFactor,
            marketContribution: roundUsd(result.marketContribution),
            inflationContribution: roundUsd(result.inflationContribution),
          }
        : {
            donorId,
            credit: transfer.credit[donorId],
            marketFactor: null,
            inflationFactor: null,
            marketContribution: null,
            inflationContribution: null,
          };
    }),
  }));
  const rankings = {
    snapshot,
    methodology: '../../../docs/lcb-methodology.md',
    marketSourceId: 'damodaran-historical-returns',
    inflationSourceId: 'fred-cpiaucns',
    rows: roundedRows,
  };
  const coverage = {
    snapshotDate: snapshot.snapshotDate,
    activeDonors: donorProfiles.length,
    seedEvents: seedEvents.length,
    excludedDonorFiles: glob.sync(path.join(contentDir, 'donors/*.md.excluded')).length,
    excludedDonationFiles: glob.sync(path.join(contentDir, 'donations/*.md.excluded')).length,
    includedTransfers: transfers.filter((transfer) => transfer.decision === 'include').length,
    excludedTransfers: transfers.filter((transfer) => transfer.decision === 'exclude').length,
    futureTransfers: transfers.filter((transfer) => transfer.exclusionReason === 'after-snapshot').length,
    wealth: Object.fromEntries(
      ['matched', 'unmatched', 'unusable'].map((status) => [
        status,
        wealth.records.filter((record) => record.status === status).length,
      ])
    ),
    partialGivingHistories: ledger.partialDonorIds.length,
    unresolvedBalances: ledger.unresolvedBalances,
  };
  const csvColumns = [
    'rank',
    'donorId',
    'name',
    'wealthStatus',
    'wealthAtSnapshot',
    'nominalGiving',
    'marketAdjustedGiving',
    'inflationAdjustedGiving',
    'charityAdjustedWealth',
    'partialGivingHistory',
  ];
  const rankingsCsv = `${csvColumns.join(',')}\n${roundedRows
    .map((row) => csvColumns.map((column) => csvEscape(row[column])).join(','))
    .join('\n')}\n`;
  return {
    'rankings.json': stableJson(rankings),
    'rankings.csv': rankingsCsv,
    'transfers.json': stableJson({ snapshotDate: snapshot.snapshotDate, transfers: transferOutput }),
    'coverage.json': stableJson(coverage),
  };
}

const outputs = buildOutputs();
fs.mkdirSync(resultsDir, { recursive: true });
for (const [name, content] of Object.entries(outputs)) {
  const target = path.join(resultsDir, name);
  if (checkOnly) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      throw new Error(`${path.relative(root, target)} is stale. Run npm run generate-lcb-data.`);
    }
  } else {
    fs.writeFileSync(target, content);
  }
}
console.log(checkOnly ? 'LCB outputs are current.' : 'LCB outputs generated.');
