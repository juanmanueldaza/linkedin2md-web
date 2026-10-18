import { zipSync, strToU8 } from 'fflate';
import './style.css';
import { pretty, extractZip, csvToMarkdown, groupCsvs, buildIndex } from './convert';

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

    const groups = groupCsvs(entries);

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
    out['index.md'] = strToU8(buildIndex(groups));
    names.push('index.md');
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
