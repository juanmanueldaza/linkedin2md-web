import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  pretty,
  stripBom,
  basename,
  escapeCell,
  csvToMarkdown,
  outputBase,
  extractZip,
  groupCsvs,
  buildIndex,
} from './convert';

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
