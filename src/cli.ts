#!/usr/bin/env node
import { RegressionBot } from './index';
import { sanitizeFilename } from './security';
import { JobStatus, JobSummary, PageResult, RunContext } from './types';
import * as path from 'path';

function formatSummary(items: PageResult['regressionbotSummary']): string {
    if (!items || items.length === 0) return '';
    return items
        .map(item => (item.label ? `[${item.label}] ${item.text}` : item.text))
        .join('\n           ');
}

function printRegression(r: PageResult) {
    console.log(`- ${r.url} [${r.variantName}] (Score: ${r.visualMatchScore.toFixed(2)})`);
    if (r.diffUrl) console.log(`  Diff: ${r.diffUrl}`);
    if (r.verdict) {
        console.log(`  Verdict: ${r.verdict.decision} (confidence ${r.verdict.minConfidence.toFixed(2)}-${r.verdict.avgConfidence.toFixed(2)})`);
    }
    const summary = formatSummary(r.regressionbotSummary);
    if (summary) console.log(`  Summary: ${summary}`);
}

/**
 * A mistake in how the command was invoked, rather than a run that worked and found
 * something. Exits 2 so CI can tell the two apart — a pipeline that treats "regressions
 * found" as a real result but "bad flag" as a broken job could not distinguish them when
 * both exited 1.
 */
class UsageError extends Error {}

function printIntent(summary: JobSummary) {
    const ia = summary.intentAssessment;
    if (!ia || !ia.intentProvided) return;
    console.log(`\n🧭 Intent: ${ia.summary}`);
    console.log(`   bugs: ${ia.bugCount}, intentional: ${ia.intentionalCount}, noise: ${ia.noiseCount}, needs review: ${ia.needsReviewCount}`);
}

type FailOn = 'any' | 'unintended';

function parseFailOn(raw: unknown): FailOn {
    if (raw === undefined) return 'any';
    if (raw === 'any' || raw === 'unintended') return raw;
    throw new UsageError("--fail-on takes 'any' or 'unintended'.");
}

/**
 * Whether one regression should fail the build under `--fail-on unintended`.
 *
 * A regression with no verdict always blocks. Nothing judged it — the run carried no
 * intent, or the summary pass had not finished — and treating unjudged as wanted would
 * turn a missing verdict into a silent pass, which is the one outcome a regression
 * detector must never produce.
 */
function isBlocking(r: PageResult): boolean {
    if (!r.verdict) return true;
    return r.verdict.decision === 'bug' || r.verdict.decision === 'needs_review';
}

/**
 * Splits regressions into the ones that fail the build and a count of the ones excused.
 *
 * Pure, and exported, because this is the decision that sets the exit code — the whole
 * point of --fail-on. Testing isBlocking alone proves nothing about whether the caller
 * applies it correctly for each mode.
 */
function selectBlocking(regressions: PageResult[], failOn: FailOn): { blocking: PageResult[]; excused: number } {
    const blocking = failOn === 'any' ? regressions : regressions.filter(isBlocking);
    return { blocking, excused: regressions.length - blocking.length };
}

function buildRunContext(options: any): RunContext | undefined {
    const context: RunContext = {};
    if (typeof options['change-description'] === 'string') context.changeDescription = options['change-description'];
    if (typeof options['pr-title'] === 'string') context.prTitle = options['pr-title'];
    if (typeof options.commit === 'string') context.gitCommitSha = options.commit;
    if (typeof options['expected-changes'] === 'string') {
        const expected = options['expected-changes'].split(',').map((s: string) => s.trim()).filter(Boolean);
        if (expected.length > 0) context.expectedChanges = expected;
    }
    return Object.keys(context).length > 0 ? context : undefined;
}

// 🛡️ SECURITY: never let an argument name reach Object.prototype.
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseArgs(args: string[]) {
    const options: any = Object.create(null);
    options._ = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (!arg.startsWith('--')) {
            options._.push(arg);
            continue;
        }

        const body = arg.slice(2);
        const eq = body.indexOf('=');

        // --key=value carries its own value, so the value survives even when it starts
        // with '--'. That is the only way to pass CSS custom properties:
        // `--custom-css="--brand: red"` loses its value in the space-separated form,
        // because a leading '--' is indistinguishable from the next flag.
        if (eq !== -1) {
            const key = body.slice(0, eq);
            if (!BLOCKED_KEYS.has(key)) options[key] = body.slice(eq + 1);
            continue;
        }

        if (BLOCKED_KEYS.has(body)) {
            const value = args[i + 1];
            if (value && !value.startsWith('--')) i++;
            continue;
        }

        const value = args[i + 1];
        if (value && !value.startsWith('--')) {
            options[body] = value;
            i++;
        } else {
            options[body] = true;
        }
    }
    return options;
}

const argv = parseArgs(process.argv.slice(2));
const command = argv._[0];
const param = argv._[1];

const sdk = new RegressionBot();

async function main() {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        showHelp();
        return;
    }

    try {
        if (command === 'status') {
            if (!param) throw new Error('Job ID is required for status command.');
            await checkStatus(param);
        } else if (command === 'summary') {
            if (!param) throw new Error('Job ID is required for summary command.');
            await showSummary(param, argv);
        } else if (command === 'approve') {
            if (!param) throw new Error('Job ID is required for approve command.');
            await approveJob(param);
        } else if (command.startsWith('http')) {
            // Implicit test command
            await startJob(command, argv);
        } else {
            console.error(`Unknown command: ${command}`);
            showHelp();
            process.exit(1);
        }
    } catch (error: any) {
        console.error(`
Error: ${error.message}`);
        process.exit(error instanceof UsageError ? 2 : 1);
    }
}

function showHelp() {
    console.log(`
RegressionBot CLI

Usage:
  npx regressionbot <url>           Quick test a URL.
  npx regressionbot status <jobId>  Check the status of a specific job.
  npx regressionbot summary <jobId> Get detailed results and diff URLs.
                                     Use --download to save the diff image locally.
                                     Use --download-full to save baseline and current images too.
  npx regressionbot approve <jobId> Approve a job's results as new baselines.

Options for <url>:
  --project <id>       Required project ID.
  --against <url>      Base origin to compare against.
  --sitemap <url>      Explicit sitemap.xml location.
  --on <devices>       Comma-separated device names (e.g. "Desktop Chrome,iPhone 12").
  --scan <pattern>     Glob pattern to scan in sitemap (e.g. "/blog/**").
  --exclude <patterns> Comma-separated glob patterns to exclude.
  --concurrency <n>    Pages captured in parallel, 1-20 (default 4).
  --auto-approve       Automatically approve results as new baselines.
  --mask <selectors>   Comma-separated CSS selectors to hide (e.g. ".ad,#popup").
  --custom-css <css>   CSS injected before each screenshot (max 4096 chars).
                       Use --custom-css="..." if the CSS starts with '--'.
  --skip-summaries     Skip waiting for parallel AI summaries in the CLI.

Describing the change (lets each regression be judged against your intent):
  --change-description <text>   What this run is meant to change.
  --expected-changes <list>     Comma-separated list of expected changes.
  --pr-title <text>             PR title.
  --commit <sha>                Git commit SHA.

  --fail-on <mode>     What counts as a failure. 'any' (default) fails on any
                       regression. 'unintended' fails only on changes judged a
                       bug or needing review, so expected changes keep the build
                       green. Needs --change-description; anything unjudged
                       still fails.

Note: any flag can be written --flag=value, which is required when the value
itself starts with '--'.

Environment Variables:
  REGRESSIONBOT_API_KEY   Override the API Key.
  REGRESSIONBOT_API_URL   Override the API URL.

Exit codes:
  0  Nothing failed (see --fail-on).
  1  Regressions or capture errors found, or the run failed.
  2  The command was used incorrectly (bad flag or missing argument).
`);
}

async function startJob(url: string, options: any) {
    console.log(`🚀 Initializing visual test...`);
    
    const projectId = options.project;
    const failOn = parseFailOn(options['fail-on']);

    const builder = sdk.test(url);

    // Only set what the caller actually asked for. Anything sent here is compared against
    // the saved project config, so a default invented by the CLI fails the run instead of
    // being overridden by it.
    if (typeof options.on === 'string') {
        builder.on(options.on.split(',').map((s: string) => s.trim()).filter(Boolean));
    }

    if (options.concurrency !== undefined) {
        const n = typeof options.concurrency === 'string' ? Number(options.concurrency) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 20) {
            throw new UsageError('--concurrency takes a whole number from 1 to 20.');
        }
        builder.concurrency(n);
    }

    if (projectId) {
        builder.forProject(projectId);
    }

    if (options.against) {
        builder.against(options.against);
    }

    if (options.sitemap) {
        builder.sitemap(options.sitemap);
    }

    if (options.scan) {
        const exclude = options.exclude ? options.exclude.split(',').map((s: string) => s.trim()) : [];
        builder.scan(options.scan, { exclude });
    }

    if (options.check) {
        const paths = options.check.split(',').map((s: string) => s.trim());
        paths.forEach((p: string) => builder.check(p));
    }

    if (options['auto-approve']) {
        builder.autoApprove(true);
    }

    if (options.mask) {
        const selectors = options.mask.split(',').map((s: string) => s.trim());
        builder.mask(selectors);
    }

    if (typeof options['custom-css'] === 'string') {
        builder.customCss(options['custom-css']);
    }

    const runContext = buildRunContext(options);
    if (runContext) {
        builder.withContext(runContext);
    }

    if (failOn === 'unintended' && !runContext) {
        console.log('⚠️  --fail-on unintended needs intent to judge against. Pass --change-description (see --help).');
    }
    if (failOn === 'unintended' && options['skip-summaries']) {
        console.log('⚠️  --skip-summaries leaves every change unjudged, so --fail-on unintended cannot excuse any of them.');
    }

    const job = await builder.run();

    console.log(`✅ Job started! ID: ${job.jobId}`);
    console.log(`📊 Project: ${projectId}`);
    console.log(`📱 Matrix: ${typeof options.on === 'string' ? options.on : 'Desktop Chrome (default)'}`);
    if (options.scan) {
        console.log(`🔍 Scan: ${options.scan} (Exclude: ${options.exclude || 'none'})`);
    }
    console.log(`
Waiting for completion...
`);

    const result = await job.waitForCompletion(2000, (status: JobStatus) => {
        const progress = status.progress || { percent: '0' };
        const aiStatusDetail = status.summaryStatus ? ` [RegressionBot Summary: ${status.summaryStatus}]` : '';
        process.stdout.write(`\r   Status: ${status.status} (${progress.percent}%)${aiStatusDetail}`);
    }, { waitForSummaries: !options['skip-summaries'] });

    console.log('\n\n✅ Job Completed.');
    
    const summary = await job.getSummary();
    console.log(`Overall Stability Score: ${summary.overallScore}/100`);
    console.log(`Total Tasks: ${summary.totalUrls}`);
    console.log(`Regressions: ${summary.regressionCount}`);
    console.log(`New Baselines: ${summary.newBaselineCount}`);
    console.log(`Errors: ${summary.errorCount}`);

    if (summary.newBaselineCount > 0) {
        console.log('\n✨ New Baselines Created:');
        summary.newBaselines.forEach((nb: any) => {
            console.log(`- ${nb.url} [${nb.variantName}]`);
        });
    }

    let exitCode = 0;

    if (summary.regressionCount > 0) {
        console.log('\n❌ Regressions found:');
        summary.regressions.forEach(printRegression);

        const { blocking, excused } = selectBlocking(summary.regressions, failOn);

        if (excused > 0) {
            console.log(`\n✅ ${excused} of ${summary.regressionCount} matched the stated intent and did not fail the build.`);
        }

        if (blocking.length > 0) {
            console.log(`\nTo approve these changes, run:\n  npx regressionbot approve ${job.jobId}`);
            exitCode = 1;
        }
    }

    printIntent(summary);

    // Reported even when there are regressions. These used to be hidden behind an
    // else-if, so a run with both showed only the regressions and exited 1 for what
    // looked like the wrong reason.
    if (summary.errorCount > 0) {
        console.log('\n⚠️ Errors encountered:');
        summary.errors.forEach((e: any) => {
            console.log(`- ${e.url}: ${e.errorMessage}`);
        });
        exitCode = 1;
    }

    if (exitCode !== 0) {
        process.exit(exitCode);
    }

    console.log(summary.regressionCount > 0
        ? '\n✨ Every change was intended. All good!'
        : '\n✨ No regressions found. All good!');
}

async function checkStatus(jobId: string) {
    const job = sdk.job(jobId);
    const status = await job.getStatus();
    console.log(JSON.stringify(status, null, 2));
}

async function showSummary(jobId: string, options: any = {}) {
    const job = sdk.job(jobId);
    const summary = await job.getSummary();
    console.log(`
Job Summary: ${jobId}
Status: ${summary.status}
Overall Score: ${summary.overallScore}/100
Execution Time: ${summary.executionTime}s
Total Tasks: ${summary.totalUrls}
Regressions: ${summary.regressionCount}
Matches: ${summary.matchCount}
Errors: ${summary.errorCount}
`);

    if (summary.regressionCount > 0) {
        console.log('❌ Regressions found:');
        summary.regressions.forEach(printRegression);
    }

    printIntent(summary);

    const doDownload = options.download || options['download-full'];
    if (doDownload) {
        console.log(`\n💾 Downloading results...`);
        await job.downloadResults({
            full: options['download-full']
        });
        console.log(`✅ Download complete. Saved to: ${path.join(process.cwd(), 'regressions', sanitizeFilename(jobId))}`);
    }

    if (summary.errorCount > 0) {
        console.log('\n⚠️ Errors encountered:');
        summary.errors.forEach((e: any) => {
            console.log(`- ${e.url}: ${e.errorMessage}`);
        });
    }
}

async function approveJob(jobId: string) {
    console.log(`Approving baselines for job: ${jobId}...`);
    const job = sdk.job(jobId);
    const res = await job.approve();
    console.log(`Success! ${res.message}`);
}

// Only run when invoked as a command, so the pure helpers below can be imported and
// tested without the CLI executing on require.
if (require.main === module) {
    main();
}

export { parseArgs, parseFailOn, isBlocking, selectBlocking, buildRunContext };
