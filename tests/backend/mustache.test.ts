/**
 * Mustache/Handlebars-flavored renderer unit test (spec §11.7).
 *
 *  - Placeholders resolve via dot-paths.
 *  - Sections render only when truthy.
 *  - Inverted sections render only when falsy.
 *  - `{{#each}}` iterates arrays; `{{this}}` resolves to the current item.
 *  - `../parent.foo` resolves on the parent context inside an iteration.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '@/lib/llm/prompts/mustache';

describe('renderTemplate — placeholders', () => {
  it('substitutes nested dot-path values', () => {
    const out = renderTemplate('Hello {{user.name}}!', { user: { name: 'Ada' } });
    expect(out).toBe('Hello Ada!');
  });

  it('renders empty string when value is undefined', () => {
    const out = renderTemplate('Hello {{user.name}}!', {});
    expect(out).toBe('Hello !');
  });
});

describe('renderTemplate — sections', () => {
  it('renders a section when the value is truthy', () => {
    const out = renderTemplate('{{#flag}}YES{{/flag}}', { flag: true });
    expect(out).toBe('YES');
  });

  it('skips a section when the value is falsy', () => {
    const out = renderTemplate('{{#flag}}YES{{/flag}}', { flag: false });
    expect(out).toBe('');
  });

  it('renders an inverted section when the value is falsy', () => {
    const out = renderTemplate('{{^flag}}NO{{/flag}}', { flag: false });
    expect(out).toBe('NO');
  });

  it('skips an inverted section when the value is truthy', () => {
    const out = renderTemplate('{{^flag}}NO{{/flag}}', { flag: true });
    expect(out).toBe('');
  });

  it('accepts {{#if x}} syntax as a section alias', () => {
    const out = renderTemplate('{{#if user.name}}has-name{{/if}}', { user: { name: 'x' } });
    expect(out).toBe('has-name');
  });
});

describe('renderTemplate — iteration', () => {
  it('iterates an array via {{#each}}', () => {
    const out = renderTemplate('{{#each xs}}[{{this}}]{{/each}}', { xs: ['a', 'b', 'c'] });
    expect(out).toBe('[a][b][c]');
  });

  it('renders nothing for an empty array', () => {
    const out = renderTemplate('{{#each xs}}X{{/each}}', { xs: [] });
    expect(out).toBe('');
  });

  it('resolves nested properties on the current iteration item', () => {
    const out = renderTemplate('{{#each items}}{{name}}:{{value}};{{/each}}', {
      items: [
        { name: 'a', value: 1 },
        { name: 'b', value: 2 }
      ]
    });
    expect(out).toBe('a:1;b:2;');
  });

  it('resolves parent-context paths via ../path', () => {
    const out = renderTemplate('{{#each items}}{{this}}@{{../version}};{{/each}}', {
      version: '1.0',
      items: ['x', 'y']
    });
    expect(out).toBe('x@1.0;y@1.0;');
  });
});
