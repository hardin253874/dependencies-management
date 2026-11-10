---
packages: [next]
fromMajor: 12
toMajor: 13
sources: [https://nextjs.org/docs/pages/building-your-application/upgrading/version-13, https://nextjs.org/blog/next-13]
---
# Next.js 12 → 13 (pages router)

What usually needs a change in a project:

- **React 18 is required** (`react` and `react-dom` 18.2+). See the React 17 → 18 notes if
  the project is still on 17. Node.js 16.8 or newer is required.
- **`next/image`.** The old component moved to `next/legacy/image`; the new `next/image`
  has a different API (no `layout`, `objectFit`, `objectPosition`, `lazyBoundary`,
  `lazyRoot` props; it renders a plain `<img>` without wrapper spans, which can change CSS).
  Codemods: `next-image-to-legacy-image`, then optionally `next-image-experimental`.
- **`next/link`.** `<Link>` renders the `<a>` itself; a child `<a>` must be removed (or
  `legacyBehavior` added). Codemod: `new-link`. Every file that renders `<Link><a>…</a></Link>`
  changes.
- **`next.config.js`.** The `target` option is removed (use `output: 'standalone'` if a
  standalone build is needed). SWC minification is the default (`swcMinify`). Options that
  were experimental in 12 may have moved or been renamed; check the config against the 13 docs.
- **Browser support.** Internet Explorer is dropped; the default browserslist targets modern
  browsers.
- **`next/script`.** `beforeInteractive` scripts must be placed in `pages/_document`.
- **Fonts.** `@next/font` (built in later as `next/font`) is new and optional.
- The `app/` directory is new and optional (beta in 13); `pages/` keeps working.
- Peer dependencies of Next plugins (`next-*`, `@next/*`, eslint-config-next) usually need
  the matching 13.x version.
