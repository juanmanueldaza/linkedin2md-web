import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';

export const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
export const MAX_ENTRY = 100 * 1024 * 1024;
export const MAX_RATIO = 1000;

// LinkedIn source filename (lowercased, no .csv) -> output base name.
// Unknown files fall through to their own stem.
export const NAME_MAP: Record<string, string> = {
  profile: 'profile',
  positions: 'experience',
  education: 'education',
  skills: 'skills',
  certifications: 'certifications',
  languages: 'languages',
  projects: 'projects',
  recommendations_received: 'recommendations',
  recommendations_given: 'recommendations_given',
  endorsement_received_info: 'endorsements',
  endorsement_given_info: 'endorsements_given',
  learning: 'learning',
  reviews: 'learning_reviews',
  connections: 'connections',
  company_follows: 'companies_followed',
  member_follows: 'members_followed',
  invitations: 'invitations',
  importedcontacts: 'imported_contacts',
  groups: 'groups',
  shares: 'posts',
  comments: 'comments',
  reactions: 'reactions',
  instantreposts: 'reposts',
  votes: 'votes',
  saved_items: 'saved_items',
  events: 'events',
  rich_media: 'media',
  messages: 'messages',
  scripts: 'scripts',
  articles: 'articles',
  job_applications: 'job_applications',
  job_applications_1: 'job_applications',
  job_applications_2: 'job_applications',
  job_descriptions: 'job_descriptions',
  job_descriptions_1: 'job_descriptions',
  job_descriptions_2: 'job_descriptions',
  saved_jobs: 'saved_jobs',
  job_seeker_preferences: 'job_preferences',
  job_applicant_saved_answers: 'saved_job_answers',
  job_applicant_saved_screening_question_responses: 'screening_responses',
  job_applicant_saved_screening_question_responses_1: 'screening_responses',
  job_applicant_saved_screening_question_responses_2: 'screening_responses',
  savedjobalerts: 'saved_job_alerts',
  searchqueries: 'search_queries',
  logins: 'logins',
  security_challenges: 'security_challenges',
  ads_clicked: 'ads_clicked',
  ad_targeting: 'ad_targeting',
  lan_ads_engagement: 'lan_ads',
  linkedin_audience_network_ad_engagement: 'lan_ads',
  inferences_about_you: 'inferences',
  receipts: 'receipts',
  receipts_v2: 'receipts',
  engagements: 'service_engagements',
  opprtunities: 'service_opportunities',
  verifications: 'verifications',
  private_identity_asset: 'identity_assets',
  causes: 'causes',
  interests: 'interests',
  courses: 'courses',
  honors_awards: 'honors_awards',
  test_scores: 'test_scores',
  patents: 'patents',
  organizations: 'organizations',
  publications: 'publications',
  volunteer_experience: 'volunteer_experience',
  contact_settings: 'contact_settings',
  data_export_history: 'data_export_history',
  deletion_history: 'deletion_history',
  who_viewed_profile: 'who_viewed_profile',
  linkedin_salary: 'linkedin_salary',
  profile_for_business: 'profile_for_business',
  profile_summary: 'profile_summary',
  email_addresses: 'profile',
  phonenumbers: 'profile',
};

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface Group {
  fields: string[];
  rows: any[];
  sources: string[];
}

export function pretty(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  const j = p.lastIndexOf('\\');
  return p.slice(Math.max(i, j) + 1);
}

export function escapeCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function extractZip(buf: ArrayBuffer): ZipEntry[] {
  const seen = new Set<string>();
  let total = 0;
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f: any) => {
      const name = (f.name as string).replace(/\\/g, '/');
      if (!name || name.endsWith('/')) return false;
      if (name.includes('..') || name.startsWith('/') || name.includes('\0')) return false;
      if (f.originalSize > MAX_ENTRY) return false;
      if (f.size > 0 && f.originalSize / f.size > MAX_RATIO) return false;
      if (total + f.originalSize > MAX_UNCOMPRESSED) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      total += f.originalSize;
      return true;
    },
  });
  return Object.entries(files).map(([name, data]) => ({ name, data: data as Uint8Array }));
}

export interface ParsedCsv {
  fields: string[];
  rows: Array<Record<string, string>>;
}

/**
 * LinkedIn prepends a free-text preamble to some exports:
 *
 *   Notes:
 *   "When exporting your connection data, ..."
 *
 *   First Name,Last Name,URL,Email Address,Company,Position,Connected On
 *
 * Papa's header mode takes `Notes:` for the header and buries every real column
 * past the first, so locate the header row ourselves.
 */
export function headerRowIndex(data: string[][]): number {
  if (!data.length) return -1;
  if (data[0].length >= 2) return 0;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].length >= 2 && data[i + 1].length === data[i].length) return i;
  }
  // Single-column export (Skills.csv, Profile Summary.csv): line 0 is the header.
  return 0;
}

function uniqueFields(header: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  header.forEach((raw, i) => {
    const name = (raw ?? '').trim() || `Column ${i + 1}`;
    const n = seen.get(name);
    if (n === undefined) {
      seen.set(name, 1);
      out.push(name);
    } else {
      seen.set(name, n + 1);
      out.push(`${name}_${n}`);
    }
  });
  return out;
}

export function parseCsv(text: string): ParsedCsv {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const data = (parsed.data ?? []).filter(r => Array.isArray(r) && r.length);
  const h = headerRowIndex(data);
  if (h < 0) return { fields: [], rows: [] };
  const fields = uniqueFields(data[h]);
  const rows = data
    .slice(h + 1)
    .map(r => {
      const row: Record<string, string> = {};
      fields.forEach((f, i) => {
        row[f] = r[i] ?? '';
      });
      return row;
    })
    .filter(r => Object.values(r).some(v => v.trim() !== ''));
  return { fields, rows };
}

/** True when two column sets describe the same shape, ignoring order. */
export function sameSchema(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/**
 * LinkedIn HTML-escapes some field values ("DevEx &amp; Core Migration").
 * Decode them, then keep angle brackets escaped: markdown renderers do not
 * re-parse entities, so cell text can still never become live markup.
 */
export function tableCell(v: string): string {
  return escapeCell(decodeEntities(v)).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function csvToMarkdown(title: string, fields: string[], rows: any[]): string {
  const lines = [`# ${title}`, ''];
  if (!fields.length || !rows.length) return lines.join('\n');
  lines.push('| ' + fields.map(tableCell).join(' | ') + ' |');
  lines.push('| ' + fields.map(() => '---').join(' | ') + ' |');
  for (const row of rows) {
    lines.push('| ' + fields.map(f => tableCell(String(row?.[f] ?? ''))).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

/**
 * LinkedIn filenames use spaces ("Job Applications_1.csv"); NAME_MAP keys use
 * underscores. Normalize before lookup or every merge target in NAME_MAP is dead code.
 */
export function normalizeStem(stem: string): string {
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** LinkedIn splits large exports into `Name.csv`, `Name_1.csv`, `Name_2.csv` continuations. */
export function splitBase(stem: string): string {
  return stem.replace(/_\d+$/, '');
}

export function outputBase(stem: string): string {
  const key = splitBase(normalizeStem(stem));
  return (NAME_MAP[key] ?? key) || 'section';
}

export function buildIndex(groups: Map<string, Group>, empty: string[] = []): string {
  const lines = ['# LinkedIn Export', '', '## Sections', ''];
  const bases = [...groups.keys()].sort();
  for (const base of bases) {
    const g = groups.get(base)!;
    lines.push(`- [${pretty(base)}](${base}.md) — ${g.rows.length} row(s)`);
  }
  lines.push('');
  if (empty.length) {
    lines.push('## Empty sections', '', 'Present in the archive but with no data rows:', '');
    for (const stem of [...empty].sort()) lines.push(`- ${pretty(stem)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface GroupCsvsReport {
  /** Source stems that parsed to zero data rows (header-only exports). */
  empty: string[];
}

export function groupCsvs(entries: ZipEntry[], report?: GroupCsvsReport): Map<string, Group> {
  const parsed: Array<{
    source: string;
    native: string;
    mapped: string;
    fields: string[];
    rows: Array<Record<string, string>>;
  }> = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith('.csv')) continue;
    const stem = basename(e.name).replace(/\.csv$/i, '');
    const { fields, rows } = parseCsv(stripBom(strFromU8(e.data)));
    if (!fields.length || !rows.length) {
      report?.empty.push(stem);
      continue;
    }
    const native = splitBase(normalizeStem(stem)) || 'section';
    parsed.push({ source: stem, native, mapped: outputBase(stem), fields, rows });
  }

  // Resolve names against the whole archive first: a NAME_MAP rename must not
  // steal the name of a file that is genuinely called that (the `Email Addresses
  // -> profile` alias would otherwise swallow Profile.csv, depending on zip order).
  const nativeNames = new Set(parsed.map(p => p.native));
  const groups = new Map<string, Group>();
  for (const p of parsed) {
    let base = p.mapped !== p.native && nativeNames.has(p.mapped) ? p.native : p.mapped;
    const existing = groups.get(base);
    if (existing && !sameSchema(existing.fields, p.fields)) base = p.native;
    if (!groups.has(base)) groups.set(base, { fields: [...p.fields], rows: [], sources: [] });
    const g = groups.get(base)!;
    g.sources.push(p.source);
    g.rows.push(...p.rows);
    for (const f of p.fields) if (!g.fields.includes(f)) g.fields.push(f);
  }
  return groups;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    const k = entity.toLowerCase();
    let cp: number;
    if (k.startsWith('#x')) cp = parseInt(k.slice(2), 16);
    else if (k.startsWith('#')) cp = parseInt(k.slice(1), 10);
    else return ENTITIES[k] ?? whole;
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

/** LinkedIn message bodies are HTML. Turn them into readable plain text/markdown. */
export function htmlToText(html: string): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html.trim();
  let s = html.replace(
    /<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]*>/g, '').trim();
      return href ? `[${text || href}](${href})` : text;
    },
  );
  s = s.replace(/<\s*li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/?\s*(?:p|div|ul|ol|table|tr|h[1-6])\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function keyOf(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Match a column by name, ignoring case, spaces and punctuation. */
export function pickField(fields: string[], name: string): string | undefined {
  const want = keyOf(name);
  return fields.find(f => keyOf(f) === want);
}

/** Thread a messages CSV by conversation instead of dumping 2k rows of HTML into a table. */
export function messagesToMarkdown(title: string, fields: string[], rows: any[]): string {
  const cId = pickField(fields, 'CONVERSATION ID');
  const cTitle = pickField(fields, 'CONVERSATION TITLE');
  const from = pickField(fields, 'FROM');
  const to = pickField(fields, 'TO');
  const date = pickField(fields, 'DATE');
  const subject = pickField(fields, 'SUBJECT');
  const content = pickField(fields, 'CONTENT');
  if (!cId || !content) return '';

  const order: string[] = [];
  const threads = new Map<string, any[]>();
  for (const r of rows) {
    const id = String(r?.[cId] ?? '').trim();
    if (!threads.has(id)) {
      threads.set(id, []);
      order.push(id);
    }
    threads.get(id)!.push(r);
  }

  const lines = [`# ${title}`, '', `${threads.size} conversation(s), ${rows.length} message(s).`, ''];
  const clean = (v: unknown) => decodeEntities(String(v ?? '').trim());
  for (const id of order) {
    const msgs = threads.get(id)!;
    if (date) msgs.sort((a, b) => String(a?.[date] ?? '').localeCompare(String(b?.[date] ?? '')));
    // Untitled conversations would otherwise be headed by an opaque base64 id.
    const participants = new Set<string>();
    for (const m of msgs) {
      if (from) {
        const n = clean(m?.[from]);
        if (n) participants.add(n);
      }
      if (to) {
        for (const t of clean(m?.[to]).split(',')) if (t.trim()) participants.add(t.trim());
      }
    }
    const heading = (cTitle ? clean(msgs[0]?.[cTitle]) : '') || [...participants].join(', ') || id;
    lines.push(`## ${heading}`, '');
    for (const m of msgs) {
      const when = date ? clean(m?.[date]) : '';
      const who = from ? clean(m?.[from]) : '';
      const toWho = to ? clean(m?.[to]) : '';
      const head = [when, who].filter(Boolean).join(' — ') + (toWho ? ` → ${toWho}` : '');
      if (head) lines.push(`**${head}**`, '');
      const subj = subject ? clean(m?.[subject]) : '';
      if (subj) lines.push(`_${subj}_`, '');
      const body = htmlToText(String(m?.[content] ?? ''));
      if (body) lines.push(body, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function renderGroup(base: string, g: Group): string {
  if (base === 'messages') {
    const threaded = messagesToMarkdown(pretty(base), g.fields, g.rows);
    if (threaded) return threaded; // '' means an unexpected schema: fall back to a table
  }
  return csvToMarkdown(pretty(base), g.fields, g.rows);
}

