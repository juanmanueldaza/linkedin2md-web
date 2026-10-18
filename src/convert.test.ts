import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  pretty,
  stripBom,
  basename,
  escapeCell,
  csvToMarkdown,
  outputBase,
  normalizeStem,
  extractZip,
  groupCsvs,
  buildIndex,
  parseCsv,
  headerRowIndex,
  decodeEntities,
  htmlToText,
  messagesToMarkdown,
  renderGroup,
} from './convert';

// LinkedIn's real preamble: a label line, a quoted note, a blank line, then the header.
const CONNECTIONS_CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. See https://www.linkedin.com/help/linkedin/answer/261"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Juan Martín ,Isasti,https://www.linkedin.com/in/juan,ja@example.com,Coderio,Talent Acquisition,15 Oct 2026
Ana,Lopez,https://www.linkedin.com/in/ana,,Acme,Engineer,14 Oct 2026`;

const MESSAGES_CSV = `CONVERSATION ID,CONVERSATION TITLE,FROM,TO,DATE,SUBJECT,CONTENT
c-2,Ana Lopez,Juan Manuel Daza,Ana Lopez,2026-10-15 21:32:20 UTC,,<p class="x">Hablemos, saludos</p>
c-1,"Group &amp; Friends",Ana Lopez,Juan Manuel Daza,2026-10-14 10:00:00 UTC,Re: hi,&lt;b&gt;Hi&lt;/b&gt;<br>Line two<ul><li>bullet</li></ul><a href="https://daza.ar/">site</a>
c-1,"Group &amp; Friends",Juan Manuel Daza,Ana Lopez,2026-10-18 09:00:00 UTC,,Which <strong>one</strong>?`;

describe('normalizeStem', () => {
  it('collapses separators and trims', () => {
    expect(normalizeStem('Job Applications_1')).toBe('job_applications_1');
    expect(normalizeStem('  Email Addresses ')).toBe('email_addresses');
    expect(normalizeStem('Receipts_v2')).toBe('receipts_v2');
  });
});

describe('parseCsv', () => {
  it('skips the Notes preamble and keeps every column', () => {
    const { fields, rows } = parseCsv(CONNECTIONS_CSV);
    expect(fields).toEqual([
      'First Name',
      'Last Name',
      'URL',
      'Email Address',
      'Company',
      'Position',
      'Connected On',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]['Last Name']).toBe('Isasti');
    expect(rows[0]['Company']).toBe('Coderio');
    expect(rows[0]['Connected On']).toBe('15 Oct 2026');
    expect(rows[1]['Email Address']).toBe('');
  });
  it('treats the first line as the header for a normal file', () => {
    const { fields, rows } = parseCsv('Title,Company\nDev,Acme\n');
    expect(fields).toEqual(['Title', 'Company']);
    expect(rows).toEqual([{ Title: 'Dev', Company: 'Acme' }]);
  });
  it('supports single-column exports', () => {
    const { fields, rows } = parseCsv('Name\nAWS Lambda\nTypeScript\n');
    expect(fields).toEqual(['Name']);
    expect(rows).toHaveLength(2);
  });
  it('drops rows that are entirely empty', () => {
    const { rows } = parseCsv('Extension,Number,Type\n,,\n');
    expect(rows).toHaveLength(0);
  });
  it('renames duplicate headers instead of losing columns', () => {
    const { fields } = parseCsv('Name,Name\nA,B\n');
    expect(fields).toEqual(['Name', 'Name_1']);
  });
  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual({ fields: [], rows: [] });
  });
});

describe('csvToMarkdown entity handling', () => {
  it('decodes the entity artifacts LinkedIn writes', () => {
    const md = csvToMarkdown('Profile', ['Summary'], [{ Summary: 'DevEx &amp; Core Migration' }]);
    expect(md).toContain('DevEx & Core Migration');
    expect(md).not.toContain('&amp;');
  });
  it('never turns escaped cell text into live markup', () => {
    const md = csvToMarkdown('X', ['v'], [{ v: '&lt;script&gt;alert(1)&lt;/script&gt;' }]);
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;script&gt;');
  });
  it('still escapes pipes and newlines after decoding', () => {
    const md = csvToMarkdown('X', ['v'], [{ v: 'a &amp; b | c' }]);
    expect(md).toContain('a & b \\| c');
  });
});

describe('headerRowIndex', () => {
  it('returns 0 when the first row is a real header', () => {
    expect(headerRowIndex([['a', 'b'], ['1', '2']])).toBe(0);
  });
  it('finds the header after a preamble', () => {
    expect(headerRowIndex([['Notes:'], ['note'], ['a', 'b', 'c'], ['1', '2', '3']])).toBe(2);
  });
  it('falls back to the first row for single-column files', () => {
    expect(headerRowIndex([['Name'], ['AWS']])).toBe(0);
  });
  it('handles no rows', () => {
    expect(headerRowIndex([])).toBe(-1);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27;')).toBe("a & b <c> 'd'");
  });
  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&notreal;')).toBe('&notreal;');
  });
  it('rejects out-of-range code points', () => {
    expect(decodeEntities('&#999999999;')).toBe('&#999999999;');
  });
});

describe('htmlToText', () => {
  it('strips tags and keeps line structure', () => {
    const out = htmlToText('<p class="spinmail-quill-editor__spin-break">La <strong>EB2-NIW</strong></p><br>Next');
    expect(out).toBe('La EB2-NIW\nNext');
    expect(out).not.toContain('<');
  });
  it('renders list items as markdown bullets', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
  });
  it('keeps link targets', () => {
    expect(htmlToText('see <a href="https://daza.ar/">site</a>')).toBe('see [site](https://daza.ar/)');
  });
  it('decodes entities', () => {
    expect(htmlToText('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });
  it('passes plain text through', () => {
    expect(htmlToText('Hablemos, saludos')).toBe('Hablemos, saludos');
  });
});

describe('messagesToMarkdown', () => {
  const { fields, rows } = parseCsv(MESSAGES_CSV);
  const md = messagesToMarkdown('Messages', fields, rows);

  it('threads by conversation with the title as the heading', () => {
    expect(md).toContain('## Ana Lopez');
    expect(md).toContain('## Group & Friends');
    expect(md).toContain('2 conversation(s), 3 message(s).');
  });
  it('orders messages within a conversation by date', () => {
    const group = md.slice(md.indexOf('## Group & Friends'));
    expect(group.indexOf('2026-10-14')).toBeLessThan(group.indexOf('2026-10-18'));
  });
  it('leaves no HTML in the output', () => {
    expect(md).not.toContain('<p');
    expect(md).not.toContain('<strong>');
    expect(md).not.toContain('<ul>');
    expect(md).not.toContain('&amp;');
  });
  it('renders bullets and markdown links', () => {
    expect(md).toContain('- bullet');
    expect(md).toContain('[site](https://daza.ar/)');
  });
  it('returns empty for an unexpected schema', () => {
    expect(messagesToMarkdown('Messages', ['a'], [{ a: '1' }])).toBe('');
  });
  it('heads an untitled conversation with its participants, not the raw id', () => {
    const csv = [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,TO,DATE,CONTENT',
      '2-Zm9v,,"Ana Lopez","Juan Daza, Ana Lopez",2026-10-14 10:00:00 UTC,hola',
      '2-Zm9v,,"Juan Daza","Ana Lopez",2026-10-14 10:01:00 UTC,hola',
    ].join('\n');
    const { fields, rows } = parseCsv(csv);
    const md = messagesToMarkdown('Messages', fields, rows);
    expect(md).toContain('## Ana Lopez, Juan Daza');
    expect(md).not.toContain('## 2-Zm9v');
  });
});

describe('renderGroup', () => {
  it('threads messages', () => {
    const md = renderGroup('messages', { fields: parseCsv(MESSAGES_CSV).fields, rows: parseCsv(MESSAGES_CSV).rows, sources: [] });
    expect(md).toContain('## Ana Lopez');
    expect(md).not.toContain('| CONVERSATION ID |');
  });
  it('falls back to a table when a messages csv has an unknown schema', () => {
    const md = renderGroup('messages', { fields: ['a', 'b'], rows: [{ a: '1', b: '2' }], sources: [] });
    expect(md).toContain('| a | b |');
  });
  it('renders non-message sections as tables', () => {
    const md = renderGroup('skills', { fields: ['Name'], rows: [{ Name: 'AWS' }], sources: [] });
    expect(md).toContain('| Name |');
  });
});

describe('groupCsvs merge policy', () => {
  it('merges space-named numbered variants into one section', () => {
    const zipped = zipSync({
      'Job Applications.csv': strToU8('Role,Company\nA,Acme\n'),
      'Job Applications_1.csv': strToU8('Role,Company\nB,Acme\n'),
      'Job Applications_2.csv': strToU8('Role,Company\nC,Acme\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    expect([...groups.keys()]).toEqual(['job_applications']);
    expect(groups.get('job_applications')!.rows).toHaveLength(3);
  });
  it('does not widen a section with an unrelated schema', () => {
    const zipped = zipSync({
      'Profile.csv': strToU8('First Name,Last Name,Summary\nJuan,Daza,hi\n'),
      'Email Addresses.csv': strToU8('Email Address,Confirmed\njuan@example.com,Yes\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    expect([...groups.keys()].sort()).toEqual(['email_addresses', 'profile']);
    expect(groups.get('profile')!.fields).toEqual(['First Name', 'Last Name', 'Summary']);
  });
  it('resolves the profile alias the same way whatever the zip order', () => {
    const files = {
      'Email Addresses.csv': strToU8('Email Address,Confirmed\njuan@example.com,Yes\n'),
      'Profile.csv': strToU8('First Name,Last Name,Summary\nJuan,Daza,hi\n'),
    };
    const forward = groupCsvs(extractZip(zipSync(files).buffer as ArrayBuffer));
    const reversed = groupCsvs(
      extractZip(
        zipSync({
          'Profile.csv': files['Profile.csv'],
          'Email Addresses.csv': files['Email Addresses.csv'],
        }).buffer as ArrayBuffer,
      ),
    );
    expect([...forward.keys()].sort()).toEqual(['email_addresses', 'profile']);
    expect([...reversed.keys()].sort()).toEqual(['email_addresses', 'profile']);
    expect(forward.get('profile')!.fields).toEqual(reversed.get('profile')!.fields);
  });
  it('honours a NAME_MAP rename for a single file', () => {
    const zipped = zipSync({ 'Receipts_v2.csv': strToU8('a,b\n1,2\n') });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    expect([...groupCsvs(entries).keys()]).toEqual(['receipts']);
  });
  it('reports header-only files instead of vanishing', () => {
    const zipped = zipSync({
      'Skills.csv': strToU8('Name\nAWS\n'),
      'Profile Summary.csv': strToU8('Profile Summary\n'),
      'PhoneNumbers.csv': strToU8('Extension,Number,Type\n,,\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const report = { empty: [] as string[] };
    const groups = groupCsvs(entries, report);
    expect([...groups.keys()]).toEqual(['skills']);
    expect(report.empty.sort()).toEqual(['PhoneNumbers', 'Profile Summary']);
    const idx = buildIndex(groups, report.empty);
    expect(idx).toContain('## Empty sections');
    expect(idx).toContain('- Profile Summary');
  });
});

describe('pretty', () => {
  it('title-cases snake_case', () => {
    expect(pretty('job_applications')).toBe('Job Applications');
  });
  it('handles single word', () => {
    expect(pretty('profile')).toBe('Profile');
  });
});

describe('stripBom', () => {
  it('strips BOM', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello');
  });
  it('leaves no-BOM string', () => {
    expect(stripBom('hello')).toBe('hello');
  });
});

describe('basename', () => {
  it('unix path', () => {
    expect(basename('a/b/c.csv')).toBe('c.csv');
  });
  it('windows path', () => {
    expect(basename('a\\b\\c.csv')).toBe('c.csv');
  });
  it('no separator', () => {
    expect(basename('c.csv')).toBe('c.csv');
  });
});

describe('escapeCell', () => {
  it('escapes pipe', () => {
    expect(escapeCell('a|b')).toBe('a\\|b');
  });
  it('converts newlines to br', () => {
    expect(escapeCell('a\nb')).toBe('a<br>b');
    expect(escapeCell('a\r\nb')).toBe('a<br>b');
  });
  it('passes through normal text', () => {
    expect(escapeCell('hello')).toBe('hello');
  });
});

describe('csvToMarkdown', () => {
  it('returns header-only-ish for empty', () => {
    const out = csvToMarkdown('Title', [], []);
    expect(out).toBe('# Title\n');
  });
  it('renders table', () => {
    const out = csvToMarkdown('T', ['a', 'b'], [{ a: '1', b: '2' }]);
    expect(out).toContain('# T');
    expect(out).toContain('| a | b |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| 1 | 2 |');
  });
  it('handles missing field', () => {
    const out = csvToMarkdown('T', ['a', 'b'], [{ a: '1' }]);
    expect(out).toContain('| 1 |  |');
  });
});

describe('outputBase', () => {
  it('maps known stem', () => {
    expect(outputBase('Positions')).toBe('experience');
  });
  it('falls through unknown', () => {
    expect(outputBase('Foo Bar')).toBe('foo_bar');
  });
  it('merges numbered variants via map', () => {
    expect(outputBase('Job_Applications_1')).toBe('job_applications');
  });
});

describe('extractZip', () => {
  it('extracts entries', () => {
    const zipped = zipSync({ 'a.csv': strToU8('x,y\n1,2\n'), 'b.txt': strToU8('hi') });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    expect(entries.map(e => e.name).sort()).toEqual(['a.csv', 'b.txt']);
  });
  it('blocks path traversal entries', () => {
    const zipped = zipSync({ '../evil.csv': strToU8('x\n1\n') });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    expect(entries).toHaveLength(0);
  });
  it('dedups case-insensitively', () => {
    const zipped = zipSync({ 'A.csv': strToU8('x\n1\n'), 'a.csv': strToU8('x\n2\n') });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    expect(entries).toHaveLength(1);
  });
});

describe('groupCsvs', () => {
  it('groups and merges', () => {
    const zipped = zipSync({
      'Positions.csv': strToU8('Title,Company\nDev,Acme\n'),
      'Skills.csv': strToU8('Name\nTS\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    expect(groups.has('experience')).toBe(true);
    expect(groups.has('skills')).toBe(true);
    expect(groups.get('experience')!.rows).toHaveLength(1);
  });
  it('merges numbered variants', () => {
    const zipped = zipSync({
      'Job_Applications.csv': strToU8('Role\nA\n'),
      'Job_Applications_1.csv': strToU8('Role\nB\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    expect(groups.has('job_applications')).toBe(true);
    expect(groups.get('job_applications')!.rows).toHaveLength(2);
  });
  it('skips empty csv', () => {
    const zipped = zipSync({ 'Empty.csv': strToU8('a,b\n') });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    expect(groups.size).toBe(0);
  });
});

describe('buildIndex', () => {
  it('lists sections with row counts', () => {
    const zipped = zipSync({
      'Positions.csv': strToU8('Title,Company\nDev,Acme\n'),
      'Skills.csv': strToU8('Name\nTS\nJS\n'),
    });
    const entries = extractZip(zipped.buffer as ArrayBuffer);
    const groups = groupCsvs(entries);
    const idx = buildIndex(groups);
    expect(idx).toContain('# LinkedIn Export');
    expect(idx).toContain('[Experience](experience.md)');
    expect(idx).toContain('1 row(s)');
    expect(idx).toContain('[Skills](skills.md)');
    expect(idx).toContain('2 row(s)');
  });
  it('handles empty groups', () => {
    const idx = buildIndex(new Map());
    expect(idx).toContain('# LinkedIn Export');
    expect(idx).toContain('## Sections');
  });
});
