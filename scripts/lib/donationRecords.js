/* eslint-env node */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { assertValidEntityId } from '../../src/utils/dataValidation.js';
import { isPlainObject } from '../../src/utils/typeGuards.js';

const DONATION_FIELDS = new Set(['date', 'recipient', 'amount', 'credit', 'source', 'notes']);
const CREDIT_SUM_TOLERANCE = 0.001;

// Content dates must be validated from the raw YAML text. YAML parsers can
// silently roll invalid dates and can interpret dates in the machine timezone.
export function normalizeStrictDateString(rawValue, errorPrefix) {
  const normalized = String(rawValue)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${errorPrefix} Expected YYYY-MM-DD.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalizedDate = new Date(0);
  normalizedDate.setUTCHours(0, 0, 0, 0);
  normalizedDate.setUTCFullYear(year, month - 1, day);
  if (
    normalizedDate.getUTCFullYear() !== year ||
    normalizedDate.getUTCMonth() !== month - 1 ||
    normalizedDate.getUTCDate() !== day
  ) {
    throw new Error(`${errorPrefix} Expected a real calendar date.`);
  }
  return normalized;
}

export function extractRawDonationDates(fileContent, fileName) {
  const frontmatterMatch = fileContent.match(/^---\s*\n([\s\S]*?)(?:\n---|$)/);
  if (!frontmatterMatch) throw new Error(`Error: Donations file ${fileName} has no frontmatter block.`);

  return frontmatterMatch[1]
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.match(/^\s*(?:-\s+)?date:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

export function buildDonationKeys(donation, date) {
  const creditKey = Object.entries(donation.credit)
    .map(([donorId, creditAmount]) => `${donorId}:${creditAmount}`)
    .sort()
    .join(',');
  const eventIdentity = [donation.recipient, date, donation.amount, donation.notes ?? null];
  return {
    exactKey: JSON.stringify([...eventIdentity, creditKey]),
    eventKey: JSON.stringify(eventIdentity),
  };
}

export function validateDonationFields(donation, context) {
  if (!isPlainObject(donation)) throw new Error(`${context} must be an object.`);
  for (const key of Object.keys(donation)) {
    if (!DONATION_FIELDS.has(key)) {
      throw new Error(`${context} has unknown field '${key}'. Allowed fields: ${[...DONATION_FIELDS].join(', ')}.`);
    }
  }
  if (typeof donation.recipient !== 'string' || donation.recipient.trim() === '') {
    throw new Error(`${context} is missing a valid 'recipient'. Got: ${JSON.stringify(donation.recipient)}`);
  }
  assertValidEntityId(donation.recipient, 'recipient', context);
}

export function validateDonationAmountAndCredit(donation, context) {
  if (typeof donation.amount !== 'number' || !Number.isFinite(donation.amount) || donation.amount <= 0) {
    throw new Error(`${context} must have a positive numeric 'amount'. Got: ${JSON.stringify(donation.amount)}`);
  }
  if (!isPlainObject(donation.credit) || Object.keys(donation.credit).length === 0) {
    throw new Error(
      `${context} must have a non-empty 'credit' object mapping donor IDs to credit fractions. ` +
        `Got: ${JSON.stringify(donation.credit)}`
    );
  }

  let creditSum = 0;
  for (const [donorId, creditAmount] of Object.entries(donation.credit)) {
    assertValidEntityId(donorId, 'donor ID', context);
    if (typeof creditAmount !== 'number' || !Number.isFinite(creditAmount) || creditAmount <= 0 || creditAmount > 1) {
      throw new Error(
        `${context} has invalid credit for donor "${donorId}". Credit must be a number in (0, 1]. ` +
          `Got: ${JSON.stringify(creditAmount)}`
      );
    }
    creditSum += creditAmount;
  }
  if (Math.abs(creditSum - 1) > CREDIT_SUM_TOLERANCE) {
    throw new Error(
      `${context} has credit values that sum to ${creditSum} instead of 1. ` +
        'Credit must describe how 100% of the donation is attributed across donors.'
    );
  }
  for (const field of ['source', 'notes']) {
    if (donation[field] !== undefined && (typeof donation[field] !== 'string' || donation[field].trim() === '')) {
      throw new Error(`${context} has invalid '${field}'. Got: ${JSON.stringify(donation[field])}`);
    }
  }
}

function eventFingerprint(event) {
  const content = {
    amount: event.amount,
    credit: Object.fromEntries(Object.entries(event.credit).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    date: event.date,
    notes: event.notes ?? null,
    recipientId: event.recipientId,
    source: event.source ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// Returns economic events before donor-row expansion. Consumers can therefore
// apply attribution once while retaining the complete credit map and provenance.
export function loadDonations(donationsDir, sourceRoot = path.resolve(donationsDir, '../..')) {
  const files = glob.sync(path.join(donationsDir, '*.md')).sort();
  const events = [];
  const seenExact = new Map();
  const seenEvents = new Map();

  for (const file of files) {
    if (path.basename(file) === '_index.md') continue;
    const fileName = path.basename(file);
    const fileContent = fs.readFileSync(file, 'utf8');
    const { data } = matter(fileContent);
    if (!Array.isArray(data.donations)) {
      throw new Error(
        `Error: Donations file ${fileName} must contain a 'donations' array in its frontmatter. ` +
          `Use 'donations: []' if the file intentionally has no donations yet.`
      );
    }
    const rawDates = extractRawDonationDates(fileContent, fileName);
    if (rawDates.length !== data.donations.length) {
      throw new Error(
        `Error: Donations file ${fileName} has ${rawDates.length} uncommented 'date:' lines but ` +
          `${data.donations.length} donations. Every donation must have exactly one 'date:' line and no other ` +
          `frontmatter key may be named 'date'.`
      );
    }

    data.donations.forEach((donation, index) => {
      validateDonationFields(donation, `Error: Donation #${index + 1} in ${fileName}`);
      const date = normalizeStrictDateString(
        rawDates[index],
        `Error: Donation #${index + 1} in ${fileName} (recipient: ${donation.recipient}) has invalid date ` +
          `"${rawDates[index]}".`
      );
      const context = `Error: Donation #${index + 1} in ${fileName} (recipient: ${donation.recipient}, date: ${date})`;
      validateDonationAmountAndCredit(donation, context);
      const { exactKey, eventKey } = buildDonationKeys(donation, date);
      const exactDuplicateFile = seenExact.get(exactKey);
      if (exactDuplicateFile) {
        throw new Error(
          `${context} is an exact duplicate of a donation in ${exactDuplicateFile}. Every donation event must be ` +
            `recorded exactly once across all files; use the 'credit' map to attribute joint donations. ` +
            `If these are genuinely separate donations, give each a distinct 'notes' field explaining the difference.`
        );
      }
      const sameEventFile = seenEvents.get(eventKey);
      if (sameEventFile) {
        throw new Error(
          `${context} matches a donation in ${sameEventFile} on recipient, date, and amount but with different ` +
            `credit — this usually means the same donation event was recorded once per donor. If so, merge them ` +
            `into a single entry (in one file) whose 'credit' map covers all donors. If these are genuinely ` +
            `separate donations, give each a distinct 'notes' field explaining the difference.`
        );
      }
      seenExact.set(exactKey, fileName);
      seenEvents.set(eventKey, fileName);

      const event = {
        date,
        recipientId: donation.recipient,
        amount: donation.amount,
        credit: { ...donation.credit },
        source: donation.source,
        notes: donation.notes,
        sourcePath: path.relative(sourceRoot, file).split(path.sep).join('/'),
        rowLocator: `donations[${index}]`,
      };
      events.push({ ...event, fingerprint: eventFingerprint(event) });
    });
  }
  return events;
}
