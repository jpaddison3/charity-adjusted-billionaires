/* eslint-env node */

export function parseStrictUtcDate(value, errorPrefix = 'date', messages = {}) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(messages.format ?? `${errorPrefix} Expected YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  // Date.UTC treats years 0–99 as 1900–1999; setUTCFullYear preserves them.
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(messages.calendar ?? `${errorPrefix} Expected a real calendar date.`);
  }
  return date;
}
