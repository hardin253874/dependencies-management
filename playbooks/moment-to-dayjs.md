---
packages: [moment, dayjs]
fromMajor: *
toMajor: *
sources: [https://momentjs.com/docs/#/-project-status/, https://day.js.org/docs/en/installation/installation, https://day.js.org/docs/en/plugin/plugin]
---
# moment → Day.js

Moment.js is in maintenance mode and its docs recommend alternatives; Day.js has a
largely moment-compatible API. What usually needs a change:

- **Every import and call site.** `import moment from 'moment'` → `import dayjs from 'dayjs'`;
  `moment(...)` → `dayjs(...)`. Wrappers (a `date.ts` utility) concentrate most changes.
- **Immutability.** Day.js objects are immutable: `d.add(1, 'day')` returns a new object.
  Moment code that relies on mutation (calling `.add()` / `.startOf()` and ignoring the
  result) silently breaks and must assign the result.
- **Plugins.** Features that are built into moment are plugins in Day.js and must be
  imported and registered with `dayjs.extend(...)`: e.g. `customParseFormat` (parsing with a
  format string), `relativeTime` (`fromNow`), `utc`, `timezone`, `duration`, `isBetween`,
  `isSameOrBefore` / `isSameOrAfter`, `advancedFormat`, `localizedFormat`, `weekOfYear`,
  `isoWeek`, `localeData`.
- **Locales** are separate imports: `import 'dayjs/locale/de'` then `dayjs.locale('de')`.
- **Library integrations.** Date pickers and form libraries that take moment objects
  (e.g. antd < 5, some react-datepicker setups) need their Day.js adapter or version.
- **Types.** Variables typed as `moment.Moment` become `dayjs.Dayjs`.
- **Tests and mocks** that mock `moment` (jest.mock('moment')) or snapshot formatted dates
  need updating.
