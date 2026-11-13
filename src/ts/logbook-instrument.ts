/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Logbook of an instrument, on its resource page (see logbook-instrument.html and Models/Logbook.php)
 * Latest status banner, table of the entries with their fields, filters, CSV export and new entry.
 */
import i18next from './i18n';
import { ApiC } from './api';
import { entity } from './getEntity';
import { notify } from './notify';

type Status = { name: string; value: string; ready: boolean } | null;
type Entry = {
  id: number;
  title: string;
  created_at: string;
  fullname: string;
  userid: number;
  linked: Array<{ id: number; title: string }>;
  status: Status;
  values: Record<string, string>;
};
type InstrumentLogbook = {
  required: boolean;
  templates: Array<{ id: number; title: string }>;
  fields: Array<{ name: string; type: string }>;
  entries: Entry[];
  latest_status: { value: string; ready: boolean; entry_id: number; fullname: string; created_at: string } | null;
};

const t = (key: string, fallback: string, options: Record<string, unknown> = {}): string =>
  i18next.t(key, { defaultValue: fallback, interpolation: { escapeValue: false }, ...options }) as string;

const section = document.getElementById('logbookInstrument');
const head = document.getElementById('logbookHead');
const body = document.getElementById('logbookBody');
const count = document.getElementById('logbookCount');
const banner = document.getElementById('logbookStatusBanner');
const empty = document.getElementById('logbookEmpty');
const statusFilter = document.getElementById('logbookStatusFilter') as HTMLSelectElement | null;
const search = document.getElementById('logbookSearch') as HTMLInputElement | null;

let data: InstrumentLogbook | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const formatDate = (value: string): string => {
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};

// columns shown besides date, user, linked experiment and status
const valueColumns = (): string[] => {
  if (!data) return [];
  const statusName = data.entries.find(entry => entry.status)?.status?.name;
  return data.fields
    .filter(field => field.type !== 'experiments' && field.name !== statusName)
    .map(field => field.name);
};

const statusPill = (status: Status): HTMLElement => {
  if (!status || !status.value) return el('span', 'text-muted', '—');
  return el('span', `logbook-pill ${status.ready ? 'logbook-pill-ready' : 'logbook-pill-attention'}`, status.value);
};

const renderBanner = (): void => {
  if (!banner || !data) return;
  const latest = data.latest_status;
  banner.hidden = !latest;
  if (!latest) return;
  banner.className = `logbook-status-banner ${latest.ready ? 'logbook-banner-ready' : 'logbook-banner-attention'}`;
  const icon = el('i', `fas fa-fw mr-2 ${latest.ready ? 'fa-circle-check' : 'fa-triangle-exclamation'}`);
  icon.setAttribute('aria-hidden', 'true');
  const text = el('span', 'mr-auto');
  text.append(el('strong', '', latest.value));
  text.append(document.createTextNode(` · ${t('logbook-reported-by', 'reported by {{name}}', { name: latest.fullname })} · ${formatDate(latest.created_at)}`));
  const link = el('a', 'ml-2', t('logbook-see-entry', 'See entry'));
  link.href = `experiments.php?mode=view&id=${latest.entry_id}`;
  banner.replaceChildren(icon, text, link);
};

const matches = (entry: Entry): boolean => {
  const filter = statusFilter?.value ?? 'all';
  if (filter === 'attention' && (!entry.status || entry.status.ready || !entry.status.value)) return false;
  if (filter === 'ready' && !entry.status?.ready) return false;
  const query = (search?.value ?? '').trim().toLowerCase();
  if (!query) return true;
  const haystack = [entry.title, entry.fullname, entry.status?.value ?? '', ...entry.linked.map(l => l.title), ...Object.values(entry.values)]
    .join(' ').toLowerCase();
  return haystack.includes(query);
};

const renderTable = (): void => {
  if (!head || !body || !data) return;
  const columns = valueColumns();
  const headRow = el('tr');
  for (const label of [t('date', 'Date'), t('user', 'User'), t('logbook-experiment', 'Experiment'), t('status', 'Status'), ...columns]) {
    headRow.append(el('th', '', label));
  }
  head.replaceChildren(headRow);
  const rows = data.entries.filter(matches).map(entry => {
    const row = el('tr', entry.status && !entry.status.ready && entry.status.value ? 'logbook-row-attention' : '');
    const dateCell = el('td', 'text-nowrap');
    const dateLink = el('a', '', formatDate(entry.created_at));
    dateLink.href = `experiments.php?mode=view&id=${entry.id}`;
    dateLink.title = entry.title;
    dateCell.append(dateLink);
    const linkedCell = el('td');
    entry.linked.forEach((linked, index) => {
      if (index > 0) linkedCell.append(document.createTextNode(', '));
      const a = el('a', '', linked.title);
      a.href = `experiments.php?mode=view&id=${linked.id}`;
      linkedCell.append(a);
    });
    const statusCell = el('td');
    statusCell.append(statusPill(entry.status));
    row.append(dateCell, el('td', 'text-nowrap', entry.fullname), linkedCell, statusCell);
    for (const column of columns) {
      const value = entry.values[column] ?? '';
      const cell = el('td', 'logbook-cell', value);
      if (value.length > 40) cell.title = value;
      row.append(cell);
    }
    return row;
  });
  body.replaceChildren(...rows);
  if (empty) {
    empty.hidden = data.entries.length > 0;
  }
};

const csvCell = (value: string): string => /[",;\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const exportCsv = (): void => {
  if (!data) return;
  const columns = valueColumns();
  const lines = [[t('date', 'Date'), t('user', 'User'), t('logbook-entry', 'Entry'), t('logbook-experiment', 'Experiment'), t('status', 'Status'), ...columns]];
  for (const entry of data.entries.filter(matches)) {
    lines.push([
      entry.created_at,
      entry.fullname,
      `${entry.title} (#${entry.id})`,
      entry.linked.map(l => `${l.title} (#${l.id})`).join(', '),
      entry.status?.value ?? '',
      ...columns.map(column => entry.values[column] ?? ''),
    ]);
  }
  const csv = '﻿' + lines.map(line => line.map(value => csvCell(String(value))).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  const title = (document.getElementById('documentTitle')?.textContent ?? `resource-${entity.id}`).trim().replace(/[^\p{L}\p{N}._-]+/gu, '_');
  a.href = url;
  a.download = `logbook_${title}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// a new entry from the logbook template (asks which one if there are several), opened to be filled
const newEntry = async (): Promise<void> => {
  if (!data || data.templates.length === 0) {
    notify.error(t('logbook-no-template', 'Logbook required, but no experiment template is linked to this instrument'));
    return;
  }
  let template = data.templates[0];
  if (data.templates.length > 1) {
    const choice = window.prompt(
      `${t('logbook-choose-template', 'Which logbook template?')}\n${data.templates.map((tpl, i) => `${i + 1}. ${tpl.title}`).join('\n')}`,
      '1',
    );
    if (choice === null) return;
    template = data.templates[Number(choice) - 1] ?? template;
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const title = `${template.title} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`.replace(/\s+/g, ' ');
  const newId = await ApiC.post2location('experiments', { template: template.id, title, notifOnSaved: 0 });
  window.location.href = `experiments.php?mode=edit&id=${newId}`;
};

const load = async (): Promise<void> => {
  data = await ApiC.getJson<InstrumentLogbook>(`items/${entity.id}/logbook`);
  if (!section || !data.required) return;
  section.hidden = false;
  if (count) count.textContent = String(data.entries.length);
  const list = document.getElementById('logbookShowList') as HTMLAnchorElement | null;
  if (list) list.href = `experiments.php?mode=show&related=${entity.id}&related_origin=items`;
  const newBtn = document.getElementById('logbookNewEntry') as HTMLButtonElement | null;
  if (newBtn) newBtn.disabled = data.templates.length === 0;
  renderBanner();
  renderTable();
};

if (section) {
  statusFilter?.addEventListener('change', renderTable);
  search?.addEventListener('input', renderTable);
  document.getElementById('logbookExport')?.addEventListener('click', exportCsv);
  document.getElementById('logbookNewEntry')?.addEventListener('click', () => {
    newEntry().catch(error => notify.error(error instanceof Error ? error.message : String(error)));
  });
  load().catch(error => console.warn('Logbook not available', error));
}
