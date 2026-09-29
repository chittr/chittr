import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

const community = ['CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md'];
const linked = [...community, 'README.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md'];
const formsDir = '.github/ISSUE_TEMPLATE';

/** Relative Markdown link targets, excluding URLs, mailto and pure in-page anchors. */
function relativeLinks(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0] ?? '';
    if (path) targets.push(path);
  }
  return targets;
}

describe('community and governance documents', () => {
  it('ships every document the contribution routes point at', () => {
    for (const file of community) expect(existsSync(join(root, file)), file).toBe(true);
    expect(existsSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md'))).toBe(true);
    expect(existsSync(join(root, '.github/CODEOWNERS'))).toBe(true);
  });

  it('resolves every relative link in the community and navigation documents', () => {
    const broken: string[] = [];
    for (const file of linked)
      for (const target of relativeLinks(read(file)))
        if (!existsSync(resolve(root, dirname(file), target))) broken.push(`${file} -> ${target}`);
    expect(broken).toEqual([]);
  });

  it('routes each kind of report to exactly one channel', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const target of ['SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md'])
      expect(contributing).toContain(target);
    expect(read('SECURITY.md')).toContain('security/advisories/new');
    // Private vulnerability reporting is the security channel only; it is not the
    // conduct inbox, and conduct reports are not support requests.
    expect(read('CODE_OF_CONDUCT.md')).not.toContain('security/advisories/new');
    expect(read('SUPPORT.md')).toContain('CODE_OF_CONDUCT.md');
  });

  it('uses the approved conduct contact without introducing other addresses', () => {
    const conductContact = 'mcgloneb@gmail.com';
    for (const file of [
      ...community,
      '.github/PULL_REQUEST_TEMPLATE.md',
      ...readdirSync(join(root, formsDir)).map((n) => `${formsDir}/${n}`),
    ]) {
      const addresses = read(file).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      for (const address of addresses) expect(address, file).toBe(conductContact);
    }
    expect(read('CODE_OF_CONDUCT.md')).toContain(`mailto:${conductContact}`);
  });

  it('names the sole accountable maintainer and no other owner', () => {
    const owners = [...read('.github/CODEOWNERS').matchAll(/(?<![`\w])@[\w-]+/g)].map((m) => m[0]);
    expect(new Set(owners)).toEqual(new Set(['@mcgloneb']));
  });

  it('keeps every issue form parseable, labelled and routed', () => {
    const files = readdirSync(join(root, formsDir)).filter((name) => name !== 'config.yml');
    expect(files.length).toBeGreaterThan(0);
    const known = new Set(['bug', 'enhancement', 'documentation', 'question', 'accessibility']);
    for (const name of files) {
      const form = parse(read(`${formsDir}/${name}`)) as {
        name?: string;
        description?: string;
        labels?: string[];
        body?: { type?: string; id?: string }[];
      };
      expect(form.name, name).toBeTruthy();
      expect(form.description, name).toBeTruthy();
      expect(Array.isArray(form.body) && form.body.length > 0, name).toBe(true);
      for (const label of form.labels ?? []) expect(known, `${name}: ${label}`).toContain(label);
      const ids = (form.body ?? []).filter((f) => f.id).map((f) => f.id);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
    const config = parse(read(`${formsDir}/config.yml`)) as {
      blank_issues_enabled?: boolean;
      contact_links?: { name: string; url: string; about: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    const urls = (config.contact_links ?? []).map((link) => link.url);
    expect(urls).toContain('https://github.com/mcgloneb/ai-chat/security/advisories/new');
  });
});

describe('contributor-usable maintenance instructions', () => {
  it('stages implementation trees with ordinary Git rather than a maintainer wrapper', () => {
    const doc = read('docs/image-support.md');
    expect(doc).toContain('git fetch origin codex/epic-29-persistent-image-sharing');
    expect(doc).not.toContain('agent-tools');
    expect(doc).not.toContain('git-codex');
  });

  it('keeps personal project configuration out of the tracked tree', () => {
    expect(read('.gitignore')).toContain('.agents/chittr/');
    expect(existsSync(join(root, '.agents/ai-chat/human-chair-room.md'))).toBe(false);
    // The retained deployment bundle is maintainer documentation, not a contributor step.
    expect(read('.agents/skills/deploy-website/SKILL.md')).toContain(
      'Maintainer deployment documentation',
    );
  });
});
