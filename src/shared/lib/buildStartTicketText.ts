/**
 * Builds a plain-text "start ticket" receipt for pool session start printing.
 * Pure function — no side effects, no imports from upper FSD layers.
 */

import { formatMoney } from '@shared/lib/format';

function centerLine(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text + ' '.repeat(width - pad - text.length);
}

function divider(width: number): string {
  return '-'.repeat(width);
}

function lineLeftRight(left: string, right: string, width: number): string {
  const r = right.length >= width ? right.slice(-width) : right;
  const maxLeft = width - r.length;
  const l = left.length > maxLeft ? `${left.slice(0, Math.max(0, maxLeft - 1))}~` : left;
  const padding = ' '.repeat(Math.max(0, width - l.length - r.length));
  return l + padding + r;
}

export type StartTicketOpts = {
  storeName: string;
  tableLabel: string;
  startedAt: Date;
  ratePerHour: number;
  paperWidthChars: number;
};

export function buildStartTicketText(opts: StartTicketOpts): string {
  const { storeName, tableLabel, startedAt, ratePerHour, paperWidthChars: w } = opts;
  const lines: string[] = [];

  lines.push(centerLine(storeName || 'Bar', w));
  lines.push(centerLine('TICKET INICIO', w));
  lines.push(centerLine('START TICKET', w));
  lines.push(divider(w));
  lines.push(lineLeftRight('Mesa', tableLabel, w));
  lines.push(lineLeftRight('Inicio', startedAt.toLocaleString(), w));
  lines.push(lineLeftRight('Tarifa', `${formatMoney(ratePerHour)}/h`, w));
  lines.push(divider(w));
  lines.push('');
  lines.push('');

  return lines.join('\n');
}
