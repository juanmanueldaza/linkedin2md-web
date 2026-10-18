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

export function csvToMarkdown(title: string, fields: string[], rows: any[]): string {
  const lines = [`# ${title}`, ''];
  if (!fields.length || !rows.length) return lines.join('\n');
  lines.push('| ' + fields.map(escapeCell).join(' | ') + ' |');
  lines.push('| ' + fields.map(() => '---').join(' | ') + ' |');
  for (const row of rows) {
    lines.push('| ' + fields.map(f => escapeCell(String(row?.[f] ?? ''))).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

export function outputBase(stem: string): string {
  const out = (NAME_MAP[stem.toLowerCase()] ?? stem).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return out;
}

export function buildIndex(groups: Map<string, Group>): string {
  const lines = ['# LinkedIn Export', '', '## Sections', ''];
  const bases = [...groups.keys()].sort();
  for (const base of bases) {
    const g = groups.get(base)!;
    lines.push(`- [${pretty(base)}](${base}.md) — ${g.rows.length} row(s)`);
  }
  lines.push('');
  return lines.join('\n');
}

export function groupCsvs(entries: ZipEntry[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith('.csv')) continue;
    const text = stripBom(strFromU8(e.data));
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    const rows = (parsed.data as any[]).filter(r => r && Object.keys(r).length);
    if (!rows.length) continue;
    const stem = basename(e.name).replace(/\.csv$/i, '');
    const out = outputBase(stem);
    if (!groups.has(out)) groups.set(out, { fields: [], rows: [], sources: [] });
    const g = groups.get(out)!;
    g.sources.push(stem);
    g.rows.push(...rows);
    const fields = parsed.meta.fields ?? [];
    for (const f of fields) if (!g.fields.includes(f)) g.fields.push(f);
  }
  return groups;
}

