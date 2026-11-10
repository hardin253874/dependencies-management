---
packages: [react, react-dom]
fromMajor: 17
toMajor: 18
sources: [https://react.dev/blog/2022/03/08/react-18-upgrade-guide, https://react.dev/blog/2022/03/29/react-v18]
---
# React 17 → 18

What usually needs a change in a project:

- **Root API.** `ReactDOM.render(<App />, el)` → `createRoot(el).render(<App />)` with
  `createRoot` imported from `react-dom/client`. `ReactDOM.hydrate` → `hydrateRoot(el, <App />)`.
  `unmountComponentAtNode(el)` → `root.unmount()`. The `render` callback argument is gone
  (use an effect instead). Files that call these are usually the entry points (`index.js`,
  `main.tsx`, test helpers that mount components).
- **Automatic batching.** State updates inside promises, timeouts and native event
  handlers are now batched. Code that reads the DOM right after `setState` outside a React
  event may need `flushSync` from `react-dom`.
- **Strict Mode.** In development, `<StrictMode>` mounts, unmounts and re-mounts every
  component once, so effects without proper cleanup show bugs.
- **TypeScript (`@types/react` 18).** `children` is no longer implicit in `React.FC` /
  component props; components that render `children` must declare it. Upgrade
  `@types/react` and `@types/react-dom` together with React.
- **Server rendering.** `renderToNodeStream` is deprecated; streaming SSR uses
  `renderToPipeableStream` (Node) / `renderToReadableStream` (web streams).
- **Testing.** `@testing-library/react` 13+ supports React 18 (older versions use the
  legacy root and warn). `react-test-renderer` must match the React version. Tests may need
  `act()` around updates.
- **Peers.** Libraries with a `react` peer range that stops at 17 need an upgrade too
  (check them with `peer_requirements`).
- Internet Explorer is no longer supported.
