import Papa from 'papaparse';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import './style.css';

const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_ENTRY = 100 * 1024 * 1024;
const MAX_RATIO = 1000;

// LinkedIn source filename (lowercased, no .csv) -> output base name.
// Unknown files fall through to their own stem.
const NAME_MAP: Record<string, string> = {
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

function pretty(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  const j = p.lastIndexOf('\\');
  return p.slice(Math.max(i, j) + 1);
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function extractZip(buf: ArrayBuffer): { name: string; data: Uint8Array }[] {
  const seen = new Set<string>();
  let total = 0;
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => {
      const name = f.name.replace(/\\/g, '/');
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
  return Object.entries(files).map(([name, data]) => ({ name, data }));
}

function csvToMarkdown(title: string, fields: string[], rows: any[]): string {
  const lines = [`# ${title}`, ''];
  if (!fields.length || !rows.length) return lines.join('\n');
  lines.push('| ' + fields.map(escapeCell).join(' | ') + ' |');
  lines.push('| ' + fields.map(() => '---').join(' | ') + ' |');
  for (const row of rows) {
    lines.push('| ' + fields.map(f => escapeCell(String(row?.[f] ?? ''))).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const drop = document.getElementById('drop') as HTMLDivElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const status = document.getElementById('status') as HTMLDivElement;
const filesList = document.getElementById('files') as HTMLUListElement;

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

async function handleFile(file: File) {
  status.textContent = 'Reading archive…';
  filesList.innerHTML = '';
  try {
    const buf = await file.arrayBuffer();
    const entries = extractZip(buf);

    // Group CSVs by output base name (merging numbered variants).
    const groups = new Map<string, { fields: string[]; rows: any[]; sources: string[] }>();
    for (const e of entries) {
      if (!e.name.toLowerCase().endsWith('.csv')) continue;
      const text = stripBom(strFromU8(e.data));
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      const rows = (parsed.data as any[]).filter(r => r && Object.keys(r).length);
      if (!rows.length) continue;
      const stem = basename(e.name).replace(/\.csv$/i, '');
      const out = (NAME_MAP[stem.toLowerCase()] ?? stem).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (!groups.has(out)) groups.set(out, { fields: [], rows: [], sources: [] });
      const g = groups.get(out)!;
      g.sources.push(stem);
      g.rows.push(...rows);
      const fields = parsed.meta.fields ?? [];
      for (const f of fields) if (!g.fields.includes(f)) g.fields.push(f);
    }

    if (!groups.size) {
      status.textContent = 'No CSV data found in this archive.';
      return;
    }

    // Build output ZIP.
    const out: Record<string, Uint8Array> = {};
    const names: string[] = [];
    for (const [base, g] of groups) {
      const md = csvToMarkdown(pretty(base), g.fields, g.rows);
      out[base + '.md'] = strToU8(md);
      names.push(base + '.md');
    }
    const zipped = zipSync(out, { level: 6 });

    status.textContent = `Converted ${groups.size} section(s) from ${entries.filter(e => e.name.toLowerCase().endsWith('.csv')).length} CSV file(s). Downloading…`;
    for (const n of names.sort()) {
      const li = document.createElement('li');
      li.textContent = n;
      filesList.appendChild(li);
    }
    downloadBlob(new Blob([zipped as BlobPart], { type: 'application/zip' }), 'linkedin-export-markdown.zip');
  } catch (err) {
    status.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
  }
}
