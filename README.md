# RegressionBot SDK

The official SDK for [RegressionBot.com](https://regressionbot.com) — the simplest way to automate visual regression testing.

RegressionBot is a declarative visual regression testing platform that helps you catch UI changes before they reach production. This SDK provides a fluent, chainable API to define your test scope, run visual tests, and manage baselines programmatically.

[![RegressionBot Docs](https://img.shields.io/badge/docs-regressionbot.com-4be277?style=for-the-badge&labelColor=0b0f14)](https://regressionbot.com/docs)

---


## Why RegressionBot?

Unlike traditional visual diffing libraries, RegressionBot is designed for modern, automated development loops and agentic pipelines:

- **Highly Accurate Regressions (Less Noise)**: Leveraging advanced pixel-matching algorithms and element masking (using CSS selectors or the automatic `data-vr-mask` attribute), RegressionBot minimizes false positives caused by dynamic data, layout shifting, or third-party widgets.
- **Plain-English Summaries**: No more manual screenshot comparisons. RegressionBot translates visual diffs into concise, plain-English descriptions of what changed, so you know exactly what was modified at a glance.
- **Agentic Workflow Ready**: Built from the ground up to support autonomous coding agents (like Gemini or Claude) and automated developer loops. Through standard API endpoints, CLI commands, and Model Context Protocol (MCP) integrations, agents can trigger tests, read plain-English results, and approve baseline changes programmatically without human intervention.


## Features

- **Fluent Manifest Builder**: Chainable methods to define your test scope.
- **Matrix Testing**: Test multiple devices and viewports in a single job.
- **Auto-Discovery**: Scan sitemaps with glob patterns and limits.
- **RegressionBot Summaries**: Plain-English change descriptions for every regression, generated on-demand via the API.
- **Intent-Aware Verdicts**: Describe what a run is meant to change, and every regression comes back judged as intentional, a bug, or noise.
- **Scheduled Checks**: Run a saved project unattended, hourly, daily, or weekly — and at a set UTC hour.
- **Project-Based Baselines**: Save and reuse test configurations; share visual history across environments.
- **Auto-Approval**: Automatically promote screenshots to baselines on jobs that pass your criteria.
- **Zero Infrastructure**: No browser maintenance or server provisioning — RegressionBot handles it all.

## Installation

```bash
npm install @regressionbot/sdk
```

## Migration from 1.x

2.0.0 re-types the SDK against what the API actually returns, taken from the
orchestrator's implementation rather than from a spec that had drifted in both
directions. Most of the breakage is caught by the compiler. One is not:

```typescript
// 1.x — updateProject() returned the raw { message, project } envelope,
// so every field read off it was undefined at runtime
const project = await rb.updateProject('site', { schedule: 'daily' });
project.project.schedule;  // this is where the value actually was

// 2.0 — the envelope is unwrapped for you
const project = await rb.updateProject('site', { schedule: 'daily' });
project.schedule;          // 'daily'
```

The rest surface as type errors:

- **`PageResult.diffCount` is gone.** No endpoint ever returned it — both
  `getJobStatus` and `getJobSummary` strip it. `PageResult` gains the fields they
  do return: `status`, `changed`, `isNewBaseline`, `errorMessage`,
  `elementsChanged`, `domAssistSkipReason` and `verdict`. Image URLs are typed
  nullable, which they always were.
- **`updateProject()` takes `ProjectConfigUpdate`, not `Partial<ProjectConfig>`.**
  The read and write shapes genuinely differ: a gate credential is written as an
  `EnvGate` and read back only as `{ configured: true }`.
- **`ProjectConfig.orgId` is gone** — the API stopped returning it.
- **`summaryStatus` can be `FAILED`**, which the old union omitted. `error`,
  `progress`, `results`, `createdAt` and `intentAssessment` are always returned.
- **`approve()` gains `conflictedUrls`**, returned when another job updated a
  baseline first.

New in 2.0 and requiring a current API: `.customCss()` and `.withContext()` on
the builder, intent-aware verdicts, environment gates, baseline policies, and
scheduling. `scheduleHourUtc` needs API 2.7.0 or later — on an older API the
field is accepted and ignored, and the schedule stays anchored to its first run.

### 2.0.1

- **The builder no longer invents defaults.** It used to send `concurrency: 10`
  on every run, plus an empty `devices` list. The API compares every parameter it
  receives against the saved project config and rejects the run on a mismatch, so
  a project storing any other concurrency — including none, which is every project
  created outside the SDK — failed with *"Params differ from stored config"* and
  there was no way to unset the field. Call `.concurrency(n)` only when you mean
  it; unset now means the API's default of 4, not 10.
- **`PageResult.maskUrl` is gone.** It was never on the public contract: both
  endpoints emit it to internal callers only. It was listed here in 2.0.0 by
  mistake.
- **`PageResult.changed` added**, with `contentChanged` alongside it. This is the
  rule the API uses to split `regressions` from `matches`. Read it instead of
  testing `diffPercentage === 0` — a text edit that moves no pixels is a
  regression at 0.00%.

## Usage

### Basic Example

```typescript
import { RegressionBot } from '@regressionbot/sdk';

const rb = new RegressionBot(); // uses REGRESSIONBOT_API_KEY env var

const job = await rb
  .test('https://preview.myapp.com')
  .forProject('my-app-web')
  .run();

const status = await job.waitForCompletion();
const summary = await job.getSummary();
console.log(`Stability Score: ${summary.overallScore}/100`);

// Download only diff images
await job.downloadResults();

// Download all images (baseline, current, diff)
await job.downloadResults({ full: true });
```

### Full Matrix Example

```typescript
import { RegressionBot } from '@regressionbot/sdk';

const rb = new RegressionBot(process.env.API_KEY);

const job = await rb
  .test(process.env.VERCEL_PREVIEW_URL)   // The Candidate (Test Origin)
  .against('https://production-app.com')    // The Source of Truth (Base Origin)
  .forProject('marketing-site-v2')          // Context: Links to Baselines & History

  // Matrix Configuration: Run all checks on both Desktop and Mobile
  .on(['Desktop Chrome', 'iPhone 13'])

  // Sitemap: Explicitly provide a sitemap location (optional)
  .sitemap('https://production-app.com/sitemap_index.xml')

  // Scope: Explicitly check critical paths
  .check('/', 'Homepage')
  .check('/pricing', 'Pricing Table')

  // Discovery: Auto-discover up to 20 blog posts
  .scan('/blog/**', { limit: 20 })
  
  // Concurrency: pages captured in parallel, 1-20. Omit it to take the default of 4 —
  // the load lands on the site being captured, not on RegressionBot.
  .concurrency(8)

  // Masking: Automatic and manual masking
  .mask(['.ads', '#modal']) // Manual selectors
  // Tip: Adding 'data-vr-mask' to your HTML elements masks them automatically!

  // Custom CSS: Injected before every screenshot (max 4096 chars)
  .customCss('#chat-widget { display: none !important; }')

  // Intent: What this run is testing, so changes can be judged against it
  .withContext({ changeDescription: 'Restyle the pricing table' })

  // Execute: Compiles manifest and triggers the API
  .run();

const result = await job.waitForCompletion();
const summary = await job.getSummary();

console.log(`Job ${job.jobId} finished. Overall Score: ${summary.overallScore}`);
```

### RegressionBot Summaries

RegressionBot can generate plain-English descriptions of what changed for each regression. Summaries are generated asynchronously after job completion.

```typescript
// Wait for the job and its RegressionBot summaries to both finish
const status = await job.waitForCompletion(2000, undefined, { waitForSummaries: true });
const summary = await job.getSummary();

if (summary.regressions.length > 0) {
  console.log(`\n${summary.regressions.length} regressions found:`);
  for (const regression of summary.regressions) {
    for (const item of regression.regressionbotSummary ?? []) {
      // `label` is the region letter (A, B, C…), or '' for a whole-page change
      console.log(`[${item.label}] ${item.text}`);
    }
  }
}

// Or trigger RegressionBot summary generation on-demand for a completed job:
const aiResult = await job.generateAiSummary();
console.log(`Generated summaries for ${aiResult.summaries.length} regressions.`);
```

### Intent-Aware Verdicts

Tell RegressionBot what a run is meant to change, and every regression comes back judged
against that intent — `intentional`, `bug`, `noise`, or `needs_review`.

```typescript
const job = await rb
  .test(process.env.VERCEL_PREVIEW_URL)
  .forProject('marketing-site-v2')
  .withContext({
    changeDescription: 'Restyle the pricing table',
    gitCommitSha: process.env.GITHUB_SHA,
    prTitle: process.env.PR_TITLE,
    expectedChanges: ['Pricing table background is now dark'],
    scope: ['components/PricingTable.tsx'],
  })
  .run();

await job.waitForCompletion(2000, undefined, { waitForSummaries: true });
const summary = await job.getSummary();

// Whole-job roll-up: does everything that changed line up with the stated intent?
console.log(summary.intentAssessment?.summary);
console.log(`Bugs: ${summary.intentAssessment?.bugCount}`);

// Per-result verdict, plus the per-region verdicts behind it
for (const r of summary.regressions) {
  console.log(`${r.url}: ${r.verdict?.decision} (${r.verdict?.avgConfidence})`);
}

// Fail CI only on changes that were not intended
const bugs = summary.regressions.filter(r => r.verdict?.decision === 'bug');
if (bugs.length > 0) process.exit(1);
```

`runProject()` takes the same context, so a run from a saved project can be
intent-aware too:

```typescript
const job = await rb.runProject('marketing-site-v2', {
  testOrigin: process.env.VERCEL_PREVIEW_URL,
  runContext: { changeDescription: 'Restyle the pricing table' },
});
```

### Hiding Dynamic Content

`.mask()` hides elements by selector. `.customCss()` injects arbitrary CSS before each
screenshot when masking isn't enough — collapsing an animation, pinning a carousel, or
neutralising a third-party widget. Max 4096 characters.

```typescript
const job = await rb
  .test('https://preview.myapp.com')
  .forProject('my-app-web')
  .customCss(`
    #chat-widget { display: none !important; }
    * { animation: none !important; transition: none !important; }
  `)
  .run();
```

### Progress Tracking

Pass a callback to `waitForCompletion` to receive status updates while the job runs:

```typescript
const status = await job.waitForCompletion(3000, (s) => {
  console.log(`[${s.status}] ${s.progress?.completed}/${s.progress?.total} pages checked`);
});
```

### Auto-Approval

Set `.autoApprove()` to automatically promote screenshots to baselines when the job completes. Useful for scheduled health checks or first-run baseline seeding.

```typescript
const job = await rb
  .test('https://production-app.com')
  .forProject('health-check')
  .scan('/**', { limit: 50 })
  .autoApprove()
  .run();
```

You can also approve an existing job's results programmatically:

```typescript
const result = await job.approve();
console.log(`Approved ${result.approvedUrlsCount} URLs.`);
```

### Saved Projects

Projects let you save a test configuration in the RegressionBot dashboard and trigger runs against it without re-specifying every option.

```typescript
// List all saved projects for your organization
const projects = await rb.listProjects();
console.log(projects.map(p => p.name));

// Fetch a specific project's configuration
const project = await rb.getProject('marketing-site-v2');
console.log(project);

// Trigger a run from a saved project, optionally overriding fields
const job = await rb.runProject('marketing-site-v2', {
  testOrigin: process.env.VERCEL_PREVIEW_URL,
});

const status = await job.waitForCompletion();
const summary = await job.getSummary();
console.log(`Score: ${summary.overallScore}/100`);
```

### Environment Gates

If an origin sits behind basic auth, a bypass header, or a session cookie, store the
credential on the project. It is encrypted at rest and never returned — reads report
only `{ configured: true }`.

```typescript
await rb.updateProject('marketing-site-v2', {
  testAuth: { basic: { username: 'preview', password: process.env.PREVIEW_PASSWORD! } },
  // or: { headers: { 'x-vercel-protection-bypass': token } }
  // or: { cookies: [{ name: 'session', value: token }] }
});

const project = await rb.getProject('marketing-site-v2');
console.log(project.testAuth); // { configured: true }

// Clear it
await rb.updateProject('marketing-site-v2', { testAuth: null });
```

Setting or clearing a gate credential invalidates the stored baselines, since it changes
what the capture can reach.

### Scheduled Checks

A project can run unattended on a fixed cadence. Scheduling requires
`baselinePolicy: 'rolling'` on a managed project — on the default `approved` policy an
unapproved change would be re-reported on every subsequent run, so the API rejects the
combination. Live-vs-live projects store no baseline and are exempt.

```typescript
// Turn on a daily unattended check
await rb.updateProject('marketing-site-v2', {
  baselinePolicy: 'rolling',
  schedule: 'daily',   // 'hourly' | 'daily' | 'weekly'
});

// Or pin it to a UTC hour — this one runs at 03:00 UTC every day
await rb.updateProject('marketing-site-v2', {
  baselinePolicy: 'rolling',
  schedule: 'daily',
  scheduleHourUtc: 3,  // 0–23, UTC
});

// Turn it back off (this clears scheduleHourUtc too)
await rb.updateProject('marketing-site-v2', { schedule: null });

// Read back when the scheduler last fired — the next run is due one interval after this
const project = await rb.getProject('marketing-site-v2');
console.log(project.schedule, project.scheduleHourUtc, project.lastScheduledRunAt);
```

Without `scheduleHourUtc` the first run starts at the next hourly sweep and the cadence
anchors to it. With it, the first run waits for that hour as well. Hours only, since the
scheduler sweeps once an hour, and UTC only. It is rejected on an `hourly` schedule, and
rejected on a project with no schedule to apply it to. Clearing the schedule clears the
hour with it, and a missed slot waits for the next one rather than catching up.

Setting a schedule, its hour, or a baseline policy does **not** invalidate
baselines — only changes that affect what a capture looks like (`testOrigin`,
`baseOrigin`, `sitemapUrl`, `paths`, `scans`, `devices`, `masks`, `customCss`) do that.
Billing is per comparison, so cost scales with frequency.

### Reconnecting to an Existing Job

If you have a job ID from a previous run (e.g., stored in CI state), you can attach to it without re-running the test:

```typescript
const job = rb.job('job_abc123');
const summary = await job.getSummary();
```

## CLI Usage

The `regressionbot` CLI is the easiest way to interact with the [RegressionBot API](https://regressionbot.com) from your terminal or CI scripts.

### Authentication

The CLI looks for the following environment variables:
- `REGRESSIONBOT_API_KEY`: Your project API key.
- `REGRESSIONBOT_API_URL`: (Optional) Override the default API endpoint.

### Commands

#### 1. Quick Check
Test a single URL against its established baseline.
```bash
npx @regressionbot/sdk https://example.com --project my-site --on "Desktop Chrome, iPhone 12"
```

#### 2. Sitemap Scan
Test an entire site using glob patterns.
```bash
npx @regressionbot/sdk https://example.com --project my-project --scan "/**" --exclude "/admin/**" --concurrency 20
```

Use `--mask` to hide elements by selector, or `--custom-css` to inject CSS before every
screenshot:
```bash
npx @regressionbot/sdk https://example.com --project my-site --custom-css "#chat-widget { display: none !important; }"
```

#### 3. Job Summary
Get detailed results and diff URLs for a completed job.
```bash
npx @regressionbot/sdk summary <jobId>
```

Add the `--download` flag to save the diff images locally:
```bash
npx @regressionbot/sdk summary <jobId> --download
```

Use the `--download-full` flag to save baseline, current, and diff images:
```bash
npx @regressionbot/sdk summary <jobId> --download-full
```

#### 4. Approve Changes
Promote the current screenshots of a job to be the new baselines.
```bash
npx @regressionbot/sdk approve <jobId>
```

## Examples & Integrations

Check out the [examples/](./examples/) directory for real-world integration guides:
- [GitHub Actions](./examples/actions/regressionbot/): Self-contained composite action for CI.
- [Preview vs Production](./examples/workflows/workflow-preview-vs-prod.yml): Compare staging URLs to live sites.
- [AWS Amplify](./examples/workflows/platform-amplify.yml): Wait for builds and test dynamically.
- [Scheduled Health Checks](./examples/workflows/daily-health-check.yml): Monitor production visuals daily.

Visit [RegressionBot.com](https://regressionbot.com) for more documentation, pricing, and to create your account.

---

Made with ❤️ by [RegressionBot](https://regressionbot.com). Report issues on [GitHub](https://github.com/RegressionBot/regressionbot-sdk/issues).
