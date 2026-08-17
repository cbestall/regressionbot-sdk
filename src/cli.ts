#!/usr/bin/env node
import { RegressionBot } from './index';
import { sanitizeFilename } from './security';
import { JobStatus, PageResult } from './types';
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

function parseArgs(args: string[]) {
    const options: any = Object.create(null);
    options._ = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);

            // Prevent prototype pollution
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                const value = args[i + 1];
                if (value && !value.startsWith('--')) i++;
                continue;
            }

            const value = args[i + 1];
            if (value && !value.startsWith('--')) {
                options[key] = value;
                i++;
            } else {
                options[key] = true;
            }
        } else {
            options._.push(arg);
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
        process.exit(1);
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
  --skip-summaries     Skip waiting for parallel AI summaries in the CLI.

Environment Variables:
  REGRESSIONBOT_API_KEY   Override the API Key.
  REGRESSIONBOT_API_URL   Override the API URL.
`);
}

async function startJob(url: string, options: any) {
    console.log(`🚀 Initializing visual test...`);
    
    const projectId = options.project;

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
            throw new Error('--concurrency takes a whole number from 1 to 20.');
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

    if (summary.regressionCount > 0) {
        console.log('\n❌ Regressions found:');
        summary.regressions.forEach(printRegression);
        console.log(`\nTo approve these changes, run:\n  npx regressionbot approve ${job.jobId}`);
        process.exit(1); 
    } else if (summary.errorCount > 0) {
        console.log('\n⚠️ Errors encountered:');
        summary.errors.forEach((e: any) => {
            console.log(`- ${e.url}: ${e.errorMessage}`);
        });
        process.exit(1);
    } else {
        console.log('\n✨ No regressions found. All good!');
    }
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

    if (summary.intentAssessment) {
        const ia = summary.intentAssessment;
        console.log(`\n🧭 Intent: ${ia.summary}`);
        console.log(`   bugs: ${ia.bugCount}, intentional: ${ia.intentionalCount}, noise: ${ia.noiseCount}, needs review: ${ia.needsReviewCount}`);
    }

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

main();
