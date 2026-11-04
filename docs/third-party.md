# Third-party code

Open source files and data copied into this repository, with where they came from and their license.

| Path | Source | License | What we use it for |
| --- | --- | --- | --- |
| `apps/site/components/stageshow/` | Stageshow kit by Benji Taylor, `stageshow/kit` in https://github.com/benjitaylor/skills (https://benji.org/stageshow) | MIT, copy in `apps/site/components/stageshow/LICENSE` | The stage, script clock, phone frame and message thread behind the animated text thread in the withmano.com hero. Only the files the hero imports are copied. The copied TypeScript files are unchanged except for a one-line license header that points to the `LICENSE` copy. The 6 CSS files are unchanged and carry no header, so the `LICENSE` copy in the folder covers them. `index.ts` is ours. The kit's own notice says that device and operating system marks stay with their owners. |
| `apps/site/lib/coverage.ts` (county dots) | County centroids from us-atlas 3.0.1, `counties-albers-10m`, https://github.com/topojson/us-atlas | ISC, Copyright 2013-2019 Michael Bostock, credited in the file's header | One dot per county on the withmano.com coverage map. |
| `apps/site/lib/coverage.ts` (counts) | Front Door's open data API, https://localcarehub.org/open-data, generated October 10, 2026 | CC BY 4.0, credited in the file's header and on the coverage map | The state-by-state counts of offices and services on withmano.com. |
