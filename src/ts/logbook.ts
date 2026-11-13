/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Instrument logbook on the edit page of an experiment.
 * Resources with a "Logbook required" checkbox extra field need a logbook entry each time they are used:
 * an experiment created from an experiment template linked to the instrument, that links to this experiment.
 * - linked instruments get a badge: logbook missing (opens the form) or done (links to the entry)
 * - linking such an instrument opens a short form built from the template extra fields
 */
import $ from 'jquery';
import i18next from './i18n';
import { ApiC } from './api';
import { entity } from './getEntity';
import { notify } from './notify';
import { addAutocompleteToLinkInputs, reloadElements } from './misc';
import { LINK_CREATED_EVENT } from './link-events';
import type { LinkCreatedDetail } from './link-events';

type ExtraField = {
  type?: string;
  value?: unknown;
  unit?: string;
  units?: string[];
  options?: string[];
  group_id?: number | string;
  position?: number | string;
  required?: boolean;
  description?: string;
  allow_multi_values?: boolean;
};
type FieldGroup = { id: number | string; name: string };
type TemplateMetadata = { elabftw?: { extra_fields_groups?: FieldGroup[] }; extra_fields?: Record<string, ExtraField> };
type LogbookTemplate = { id: number; title: string; body: string; content_type: number; metadata: string | null };
type LogbookEntry = { id: number; title: string; created_at: string | null; fullname: string | null };
type Instrument = { id: number; title: string; templates: LogbookTemplate[]; entries: LogbookEntry[] };
type LogbookStatus = { is_logbook_entry: boolean; instruments: Instrument[] };

// field types the form can render, the others are left to fill in the full entry
const SIMPLE_TYPES = ['text', 'number', 'select', 'checkbox', 'date', 'datetime-local', 'time', 'url', 'email'];

const t = (key: string, fallback: string, options: Record<string, unknown> = {}): string =>
  i18next.t(key, { defaultValue: fallback, ...options }) as string;

const modal = document.getElementById('logbookModal');
const form = document.getElementById('logbookForm') as HTMLFormElement | null;
const fieldsDiv = document.getElementById('logbookFields');
const templateGroup = document.getElementById('logbookTemplateGroup');
const templateSelect = document.getElementById('logbookTemplateSelect') as HTMLSelectElement | null;
const observations = document.getElementById('logbookObservations') as HTMLTextAreaElement | null;
const saveBtn = document.getElementById('logbookSave') as HTMLButtonElement | null;
const fullEntryLink = document.getElementById('logbookFullEntry');

let status: LogbookStatus | null = null;
let current: Instrument | null = null;
let saving = false;

const fetchStatus = async (): Promise<LogbookStatus> => {
  status = await ApiC.getJson<LogbookStatus>(`${entity.type}/${entity.id}/logbook`);
  return status;
};

const parseMetadata = (template: LogbookTemplate): TemplateMetadata => {
  try {
    return JSON.parse(template.metadata ?? '{}') ?? {};
  } catch {
    return {};
  }
};

const todayIso = (): string => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

///////////
// BADGES

const decorate = (): void => {
  document.querySelectorAll('.logbook-badge').forEach(badge => badge.remove());
  if (!status || status.is_logbook_entry) return;
  for (const instrument of status.instruments) {
    // only on the direct links of the experiment, not on related ones
    const rows = document.querySelectorAll<HTMLElement>(
      `#itemsLinksDiv [data-link-type='items'][data-link-id='${instrument.id}']:not([data-link-related])`,
    );
    rows.forEach(row => {
      const anchor = row.querySelector('a.mr-auto');
      if (!anchor) return;
      let badge: HTMLElement;
      if (instrument.entries.length > 0) {
        const latest = instrument.entries[0];
        badge = el('a', 'logbook-badge logbook-badge-done mr-2');
        (badge as HTMLAnchorElement).href = `experiments.php?mode=view&id=${latest.id}`;
        badge.title = latest.title;
        badge.append(el('i', 'fas fa-fw fa-clipboard-check mr-1'));
        badge.append(document.createTextNode(instrument.entries.length > 1
          ? t('logbook-done-count', 'Logbook ({{count}})', { count: instrument.entries.length })
          : t('logbook-done', 'Logbook')));
      } else if (instrument.templates.length > 0) {
        badge = el('button', 'logbook-badge logbook-badge-missing mr-2');
        (badge as HTMLButtonElement).type = 'button';
        badge.title = t('logbook-missing-help', 'This instrument requires a logbook entry: click to fill it');
        badge.append(el('i', 'fas fa-fw fa-clipboard-list mr-1'));
        badge.append(document.createTextNode(t('logbook-missing', 'Logbook missing')));
        badge.addEventListener('click', () => open(instrument));
      } else {
        // flag on, but no template linked to the instrument: tell how to fix it
        badge = el('span', 'logbook-badge logbook-badge-missing mr-2');
        badge.title = t('logbook-no-template', 'Logbook required, but no experiment template is linked to this instrument');
        badge.append(el('i', 'fas fa-fw fa-clipboard-question mr-1'));
        badge.append(document.createTextNode(t('logbook-missing', 'Logbook missing')));
      }
      anchor.after(badge);
    });
  }
};

/////////
// FORM

const fieldInputId = (name: string): string => `logbookField_${Array.from(name).map(c => c.charCodeAt(0).toString(16)).join('')}`;

const buildInput = (name: string, field: ExtraField): HTMLElement => {
  const id = fieldInputId(name);
  const type = field.type ?? 'text';
  const value = field.value === undefined || field.value === null ? '' : String(field.value);
  if (type === 'select') {
    const select = el('select', 'form-control');
    select.multiple = field.allow_multi_values === true;
    if (!select.multiple) {
      const empty = el('option', '', '—');
      empty.value = '';
      select.append(empty);
    }
    for (const option of field.options ?? []) {
      const opt = el('option', '', option);
      opt.value = option;
      opt.selected = Array.isArray(field.value) ? field.value.includes(option) : option === value;
      select.append(opt);
    }
    select.id = id;
    select.required = field.required === true;
    return select;
  }
  if (type === 'checkbox') {
    const wrapper = el('div', 'custom-control custom-checkbox');
    const input = el('input', 'custom-control-input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = value === 'on';
    const label = el('label', 'custom-control-label', name);
    label.htmlFor = id;
    wrapper.append(input, label);
    return wrapper;
  }
  const input = el('input', 'form-control');
  input.type = type;
  input.id = id;
  input.value = value;
  input.required = field.required === true;
  if (type === 'number') input.step = 'any';
  if (field.description) input.placeholder = field.description;
  if (type === 'number' && (field.units?.length ?? 0) > 0) {
    const group = el('div', 'input-group');
    group.append(input);
    const append = el('div', 'input-group-append');
    if ((field.units ?? []).length === 1) {
      append.append(el('span', 'input-group-text', field.units[0]));
    } else {
      const unit = el('select', 'form-control brl-none logbook-unit');
      unit.id = `${id}_unit`;
      unit.setAttribute('aria-label', t('unit', 'Unit'));
      for (const u of field.units ?? []) {
        const opt = el('option', '', u);
        opt.value = u;
        opt.selected = u === (field.unit ?? field.units[0]);
        unit.append(opt);
      }
      append.append(unit);
    }
    group.append(append);
    return group;
  }
  return input;
};

const renderForm = (template: LogbookTemplate): void => {
  if (!fieldsDiv) return;
  fieldsDiv.replaceChildren();
  const metadata = parseMetadata(template);
  const fields = Object.entries(metadata.extra_fields ?? {})
    .sort(([, a], [, b]) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const groups: FieldGroup[] = [...(metadata.elabftw?.extra_fields_groups ?? [])];
  const byGroup = new Map<string, Array<[string, ExtraField]>>();
  for (const [name, field] of fields) {
    const key = String(field.group_id ?? '');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push([name, field]);
  }
  // ungrouped fields first, then groups in their order
  const ordered: Array<[string, Array<[string, ExtraField]>]> = [];
  if (byGroup.has('')) ordered.push(['', byGroup.get('')]);
  for (const group of groups) {
    const list = byGroup.get(String(group.id));
    if (list) ordered.push([group.name, list]);
  }
  const later: string[] = [];
  for (const [groupName, list] of ordered) {
    const fieldset = el('fieldset', 'logbook-fieldset');
    if (groupName) fieldset.append(el('legend', 'logbook-legend', groupName));
    const row = el('div', 'form-row');
    for (const [name, field] of list) {
      const type = field.type ?? 'text';
      const col = el('div', 'form-group col-md-6');
      // the experiment this entry documents: this one, always
      if (type === 'experiments') {
        const label = el('label', '', name);
        const value = el('div', 'form-control-plaintext logbook-linked');
        value.append(el('i', 'fas fa-fw fa-link mr-1'));
        value.append(document.createTextNode(document.getElementById('documentTitle')?.textContent?.trim() || `#${entity.id}`));
        col.append(label, value);
        row.append(col);
        continue;
      }
      if (!SIMPLE_TYPES.includes(type)) {
        later.push(name);
        continue;
      }
      if (type !== 'checkbox') {
        const label = el('label', '', name);
        label.htmlFor = fieldInputId(name);
        if (field.required) label.append(el('span', 'text-danger ml-1', '*'));
        col.append(label);
      }
      col.append(buildInput(name, field));
      if (field.description && type !== 'text') col.append(el('small', 'form-text text-muted', field.description));
      const feedback = el('div', 'invalid-feedback', t('logbook-field-required', 'Please fill this field'));
      col.append(feedback);
      row.append(col);
    }
    fieldset.append(row);
    fieldsDiv.append(fieldset);
  }
  if (later.length > 0) {
    fieldsDiv.append(el('p', 'small text-muted', `${t('logbook-fill-later', 'To fill in the full entry')}: ${later.join(', ')}`));
  }
};

const readValues = (template: LogbookTemplate): { values: Record<string, { value: unknown }>; units: Record<string, string> } | null => {
  const metadata = parseMetadata(template);
  const values: Record<string, { value: unknown }> = {};
  const units: Record<string, string> = {};
  let firstInvalid: HTMLElement | null = null;
  for (const [name, field] of Object.entries(metadata.extra_fields ?? {})) {
    const type = field.type ?? 'text';
    if (type === 'experiments') {
      values[name] = { value: field.allow_multi_values ? [String(entity.id)] : String(entity.id) };
      continue;
    }
    if (!SIMPLE_TYPES.includes(type)) continue;
    const input = document.getElementById(fieldInputId(name)) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    let value: unknown;
    if (type === 'checkbox') {
      value = (input as HTMLInputElement).checked ? 'on' : '';
    } else if (input instanceof HTMLSelectElement && input.multiple) {
      value = Array.from(input.selectedOptions).map(o => o.value);
    } else {
      value = input.value.trim();
    }
    const empty = value === '' || (Array.isArray(value) && value.length === 0);
    input.classList.toggle('is-invalid', field.required === true && empty);
    if (field.required === true && empty && !firstInvalid) firstInvalid = input;
    if (!empty) values[name] = { value };
    const unit = document.getElementById(`${fieldInputId(name)}_unit`) as HTMLSelectElement | null;
    if (unit && unit.value !== (field.unit ?? field.units?.[0])) units[name] = unit.value;
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return null;
  }
  return { values, units };
};

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const selectedTemplate = (): LogbookTemplate | null => {
  if (!current) return null;
  const id = Number(templateSelect?.value);
  return current.templates.find(template => template.id === id) ?? current.templates[0] ?? null;
};

function open(instrument: Instrument): void {
  if (!modal || instrument.templates.length === 0) return;
  current = instrument;
  const title = document.getElementById('logbookModalTitle');
  if (title) title.textContent = t('logbook-for', 'Logbook entry: {{instrument}}', { instrument: instrument.title, interpolation: { escapeValue: false } });
  if (templateSelect && templateGroup) {
    templateSelect.replaceChildren(...instrument.templates.map(template => {
      const option = el('option', '', template.title);
      option.value = String(template.id);
      return option;
    }));
    templateGroup.hidden = instrument.templates.length < 2;
  }
  if (observations) observations.value = '';
  renderForm(instrument.templates[0]);
  $(modal).modal('show');
}

// create the entry from the template, link it to this experiment, then fill what the template can't
async function createEntry(withValues: boolean): Promise<number | null> {
  const template = selectedTemplate();
  if (!template || !current) return null;
  let values: Record<string, { value: unknown }> = {};
  let units: Record<string, string> = {};
  if (withValues) {
    const read = readValues(template);
    if (!read) return null;
    ({ values, units } = read);
  } else {
    const field = Object.entries(parseMetadata(template).extra_fields ?? {}).find(([, f]) => f.type === 'experiments');
    if (field) values[field[0]] = { value: field[1].allow_multi_values ? [String(entity.id)] : String(entity.id) };
  }
  const newId = await ApiC.post2location('experiments', {
    notifOnSaved: 0,
    template: template.id,
    title: `${template.title} ${todayIso()}`.replace(/\s+/g, ' ').trim(),
    metadata: { extra_fields: values },
  });
  // one direction only: the entry links to the experiment it documents, which shows it as a related link
  await ApiC.post(`experiments/${newId}/experiments_links/${entity.id}`, { notifOnSaved: 0 });
  // the instrument link comes from the template, make sure it is there
  const created = await ApiC.getJson<{ items_links?: Array<{ entityid: number }>; metadata?: string }>(`experiments/${newId}`);
  if (!(created.items_links ?? []).some(link => Number(link.entityid) === current.id)) {
    await ApiC.post(`experiments/${newId}/items_links/${current.id}`, { notifOnSaved: 0 });
  }
  // chosen units are part of the field schema, not of the value: patch the metadata
  if (Object.keys(units).length > 0 && created.metadata) {
    const metadata = typeof created.metadata === 'string' ? JSON.parse(created.metadata) : created.metadata;
    for (const [name, unit] of Object.entries(units)) {
      if (metadata.extra_fields?.[name]) metadata.extra_fields[name].unit = unit;
    }
    await ApiC.patch(`experiments/${newId}`, { metadata: JSON.stringify(metadata), notifOnSaved: 0 });
  }
  const text = observations?.value.trim() ?? '';
  if (withValues && text) {
    const body = template.content_type === 2
      ? `${template.body ?? ''}\n\n${text}`
      : `${template.body ?? ''}${text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}`;
    await ApiC.patch(`experiments/${newId}`, { body, notifOnSaved: 0 });
  }
  return newId;
}

const setSaving = (state: boolean): void => {
  saving = state;
  if (!saveBtn) return;
  saveBtn.disabled = state;
  saveBtn.replaceChildren(state ? el('i', 'fas fa-fw fa-spinner fa-spin mr-1') : '', t('logbook-save', 'Save logbook entry'));
};

const refresh = async (): Promise<void> => {
  await fetchStatus();
  // the new entry shows up as a related experiment link
  await reloadElements(['linksDiv']).catch(() => {});
  addAutocompleteToLinkInputs();
  decorate();
};

if (modal && form && entity.type === 'experiments') {
  templateSelect?.addEventListener('change', () => {
    const template = selectedTemplate();
    if (template) renderForm(template);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const newId = await createEntry(true);
      if (newId === null) return;
      $(modal).modal('hide');
      notify.success(t('logbook-saved', 'Logbook entry saved'));
      await refresh();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  });

  // for fields the short form doesn't cover: create the entry now and open it
  fullEntryLink?.addEventListener('click', async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const newId = await createEntry(false);
      if (newId === null) return;
      $(modal).modal('hide');
      await refresh();
      window.open(`experiments.php?mode=edit&id=${newId}`, '_blank');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  });

  // a resource was just linked: ask for the logbook right away if it needs one
  document.addEventListener(LINK_CREATED_EVENT, async (event: Event) => {
    const { endpoint, target } = (event as CustomEvent<LinkCreatedDetail>).detail;
    try {
      await fetchStatus();
    } catch {
      return;
    }
    decorate();
    if (endpoint !== 'items_links' || status.is_logbook_entry) return;
    const instrument = status.instruments.find(i => i.id === target);
    if (instrument && instrument.entries.length === 0 && instrument.templates.length > 0) open(instrument);
  });

  // links are re-rendered after many actions (delete, import...): put the badges back
  const linksDiv = document.getElementById('linksDiv')?.parentElement;
  if (linksDiv) {
    let pending = 0;
    new MutationObserver(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        if (status && !document.querySelector('#itemsLinksDiv .logbook-badge')) decorate();
      }, 50);
    }).observe(linksDiv, { childList: true, subtree: true });
  }

  fetchStatus().then(decorate).catch(error => console.warn('Logbook status not available', error));
}
