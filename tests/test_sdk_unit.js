const assert = require('assert');
const { RegressionBot } = require('../dist/index');

// Mock fetch for testing
const originalFetch = global.fetch;
let mockFetchImpl = null;

function setMockFetch(fn) {
    mockFetchImpl = fn;
    global.fetch = fn;
}

function restoreFetch() {
    global.fetch = originalFetch;
    mockFetchImpl = null;
}

// Helper to create SDK with mock API
function createMockSdk() {
    const sdk = new RegressionBot('test-api-key', 'http://localhost:9999');
    return sdk;
}

async function testJobBuilderMethods() {
    console.log('Testing JobBuilder methods...');
    
    const sdk = createMockSdk();
    
    // Test basic chain
    console.log('  Testing basic chain...');
    const builder = sdk.test('https://preview.example.com')
        .forProject('test-project')
        .against('https://prod.example.com')
        .sitemap('https://prod.example.com/sitemap.xml')
        .on(['Desktop Chrome', 'iPhone 13'])
        .check('/', 'Homepage')
        .check('/about', 'About Page')
        .scan('/blog/**', { limit: 20 })
        .concurrency(5)
        .mask(['.ads', '#modal'])
        .customCss('#chat-widget { display: none !important; }')
        .withContext({ changeDescription: 'restyle the pricing table' })
        .withContext({ gitCommitSha: 'abc123', expectedChanges: ['pricing table colours'] })
        .autoApprove(true);
    
    // Test that methods return 'this' for chaining
    assert.strictEqual(builder instanceof Object, true);
    console.log('  OK: Chaining works');
    
    // Test run() with mock
    console.log('  Testing run()...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(url, 'http://localhost:9999/crawl');
        assert.strictEqual(options.method, 'POST');
        
        const body = JSON.parse(options.body);
        assert.strictEqual(body.project, 'test-project');
        assert.strictEqual(body.testOrigin, 'https://preview.example.com');
        assert.strictEqual(body.baseOrigin, 'https://prod.example.com');
        assert.strictEqual(body.sitemapUrl, 'https://prod.example.com/sitemap.xml');
        assert.deepStrictEqual(body.devices, ['Desktop Chrome', 'iPhone 13']);
        assert.strictEqual(body.paths.length, 2);
        assert.strictEqual(body.paths[0].path, '/');
        assert.strictEqual(body.paths[0].label, 'Homepage');
        assert.strictEqual(body.scans.length, 1);
        assert.strictEqual(body.scans[0].pattern, '/blog/**');
        assert.strictEqual(body.scans[0].options.limit, 20);
        assert.strictEqual(body.concurrency, 5);
        assert.strictEqual(body.autoApprove, true);
        assert.deepStrictEqual(body.masks, ['.ads', '#modal']);
        assert.strictEqual(body.customCss, '#chat-widget { display: none !important; }');
        assert.deepStrictEqual(body.runContext, {
            changeDescription: 'restyle the pricing table',
            gitCommitSha: 'abc123',
            expectedChanges: ['pricing table colours']
        });

        return {
            ok: true,
            json: async () => ({ jobId: 'job-123' })
        };
    });
    
    const job = await builder.run();
    assert.strictEqual(job.jobId, 'job-123');
    console.log('  OK: run() returns JobHandle with correct jobId');

    restoreFetch();

    // A field the caller never set must not reach the wire. The API compares every
    // parameter it receives against the saved project config and fails the run on a
    // mismatch, so a default invented here rejects the job instead of overriding it.
    console.log('  Testing run() omits parameters the caller never set...');
    setMockFetch(async (url, options) => {
        const body = JSON.parse(options.body);
        assert.ok(!('concurrency' in body), 'concurrency must be absent unless concurrency() was called');
        assert.ok(!('devices' in body), 'devices must be absent unless on() was called');
        assert.ok(!('scans' in body), 'scans must be absent unless scan() was called');
        // paths stays: the drift branch does not hydrate it, so an omitted paths would
        // leave the run with nothing to capture.
        assert.deepStrictEqual(body.paths, [{ path: '/', label: 'Home' }]);
        return { ok: true, json: async () => ({ jobId: 'job-bare' }) };
    });
    await sdk.test('https://preview.example.com').forProject('test-project').run();
    console.log('  OK: bare run() sends no invented defaults');
    restoreFetch();

    // The other half of each pair above: set explicitly, and it must reach the wire.
    console.log('  Testing run() sends devices and scans when asked...');
    setMockFetch(async (url, options) => {
        const body = JSON.parse(options.body);
        assert.deepStrictEqual(body.devices, ['iPhone 13']);
        assert.deepStrictEqual(body.scans, [{ pattern: '/blog/**', options: { limit: 5 } }]);
        return { ok: true, json: async () => ({ jobId: 'job-set' }) };
    });
    await sdk.test('https://preview.example.com')
        .forProject('test-project')
        .on(['iPhone 13'])
        .scan('/blog/**', { limit: 5 })
        .run();
    console.log('  OK: on() and scan() are sent when set');
    restoreFetch();

    console.log('  Testing run() sends concurrency when asked...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(JSON.parse(options.body).concurrency, 20);
        return { ok: true, json: async () => ({ jobId: 'job-conc' }) };
    });
    await sdk.test('https://preview.example.com').forProject('test-project').concurrency(20).run();
    console.log('  OK: concurrency() is sent when set');
    restoreFetch();

    // `changes` is optional: absent means the document comparison could not run on that
    // page, not that nothing changed. The SDK does no parsing — it hands back what the API
    // sent — so this locks that it neither strips the field when present nor invents it
    // when absent, and that reading it when absent is safe.
    console.log('  Testing getSummary() passes changes through, present or absent...');
    const withChanges = {
        url: '/a', variantName: 'Desktop Chrome', status: 'SUCCESS', changed: true,
        diffPercentage: 1.2, visualMatchScore: 98.8, isNewBaseline: false,
        baselineUrl: null, currentUrl: null, diffUrl: null,
        changes: [{ type: 'text-edit', element: 'h1', before: 'Old', after: 'New' }]
    };
    const withoutChanges = {
        url: '/b', variantName: 'Desktop Chrome', status: 'SUCCESS', changed: true,
        diffPercentage: 0.4, visualMatchScore: 99.6, isNewBaseline: false,
        baselineUrl: null, currentUrl: null, diffUrl: null,
        domAssistSkipReason: 'dom snapshot unavailable'
    };
    setMockFetch(async () => ({
        ok: true,
        json: async () => ({ jobId: 'job-changes', regressions: [withChanges, withoutChanges], matches: [] })
    }));
    const changesSummary = await sdk.job('job-changes').getSummary();
    assert.deepStrictEqual(changesSummary.regressions[0].changes, withChanges.changes);
    assert.strictEqual('changes' in changesSummary.regressions[1], false, 'absent changes must stay absent');
    assert.strictEqual(changesSummary.regressions[1].domAssistSkipReason, 'dom snapshot unavailable');
    // What a consumer actually does with an absent array — this must not throw.
    assert.deepStrictEqual((changesSummary.regressions[1].changes ?? []).map(c => c.type), []);
    console.log('  OK: changes survives round-trip and is safe to read when absent');
    restoreFetch();

    console.log('All JobBuilder tests passed!\n');
}

async function testJobHandleMethods() {
    console.log('Testing JobHandle methods...');
    
    const sdk = createMockSdk();
    const job = sdk.job('test-job-456');
    
    // Test getStatus()
    console.log('  Testing getStatus()...');
    setMockFetch(async (url) => {
        assert.strictEqual(url, 'http://localhost:9999/job/test-job-456');
        return {
            ok: true,
            json: async () => ({ 
                jobId: 'test-job-456', 
                status: 'COMPLETED',
                progress: { total: 10, completed: 10, percent: '100' }
            })
        };
    });
    
    const status = await job.getStatus();
    assert.strictEqual(status.jobId, 'test-job-456');
    assert.strictEqual(status.status, 'COMPLETED');
    console.log('  OK: getStatus() works');
    restoreFetch();
    
    // Test getSummary()
    console.log('  Testing getSummary()...');
    setMockFetch(async (url) => {
        assert.strictEqual(url, 'http://localhost:9999/job/test-job-456/summary');
        return {
            ok: true,
            json: async () => ({ 
                jobId: 'test-job-456',
                status: 'COMPLETED',
                overallScore: 95,
                regressionCount: 1,
                matchCount: 9
            })
        };
    });
    
    const summary = await job.getSummary();
    assert.strictEqual(summary.jobId, 'test-job-456');
    assert.strictEqual(summary.overallScore, 95);
    console.log('  OK: getSummary() works');
    restoreFetch();
    
    // Test approve()
    console.log('  Testing approve()...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(url, 'http://localhost:9999/approve');
        assert.strictEqual(options.method, 'POST');
        const body = JSON.parse(options.body);
        assert.strictEqual(body.jobId, 'test-job-456');
        return {
            ok: true,
            json: async () => ({ 
                message: 'Approved',
                jobId: 'test-job-456',
                approvedUrlsCount: 5
            })
        };
    });
    
    const approveResult = await job.approve();
    assert.strictEqual(approveResult.approvedUrlsCount, 5);
    console.log('  OK: approve() works');
    restoreFetch();

    // Test generateAiSummary()
    console.log('  Testing generateAiSummary()...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(url, 'http://localhost:9999/job/test-job-456/ai-summary');
        assert.strictEqual(options.method, 'POST');
        return {
            ok: true,
            json: async () => ({ 
                message: 'AI summary generated successfully',
                jobId: 'test-job-456',
                summaries: [{ url: 'https://example.com', variantName: 'desktop', regressionbotSummary: 'Header changed color' }]
            })
        };
    });
    const aiSummary = await job.generateAiSummary();
    assert.strictEqual(aiSummary.summaries[0].regressionbotSummary, 'Header changed color');
    console.log('  OK: generateAiSummary() works');
    restoreFetch();

    console.log('All JobHandle tests passed!\n');
}

async function testDownloadResults() {
    console.log('Testing downloadResults extension resolution...');
    
    const fs = require('fs');
    const path = require('path');
    
    const sdk = createMockSdk();
    const job = sdk.job('test-job-download');
    
    // Set up mock fetches
    setMockFetch(async (url) => {
        if (url === 'http://localhost:9999/job/test-job-download/summary') {
            return {
                ok: true,
                json: async () => ({
                    jobId: 'test-job-download',
                    status: 'COMPLETED',
                    totalUrls: 1,
                    completedCount: 1,
                    overallScore: 90,
                    executionTime: 10,
                    regressionCount: 1,
                    matchCount: 0,
                    newBaselineCount: 0,
                    errorCount: 0,
                    regressions: [
                        {
                            url: 'https://example.com/login',
                            variantName: 'desktop_chrome',
                            diffPercentage: 5.2,
                            diffCount: 1000,
                            visualMatchScore: 94.8,
                            diffUrl: 'http://localhost:9999/images/diff-url',
                            baselineUrl: 'http://localhost:9999/images/baseline-url',
                            currentUrl: 'http://localhost:9999/images/current-url'
                        }
                    ],
                    matches: [],
                    newBaselines: [],
                    errors: []
                })
            };
        }
        
        if (url === 'http://localhost:9999/images/diff-url') {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : null
                },
                arrayBuffer: async () => new ArrayBuffer(4)
            };
        }

        if (url === 'http://localhost:9999/images/baseline-url') {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null
                },
                arrayBuffer: async () => new ArrayBuffer(4)
            };
        }

        if (url === 'http://localhost:9999/images/current-url') {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'image/gif' : null
                },
                arrayBuffer: async () => new ArrayBuffer(4)
            };
        }

        throw new Error(`Unexpected mock URL: ${url}`);
    });

    const testDir = path.join(__dirname, 'temp_test_downloads');
    if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
    }

    try {
        await job.downloadResults({
            full: true,
            baseDir: testDir
        });

        // The job folder under baseDir should be 'test_job_download' (sanitized test-job-download)
        const jobFolder = path.join(testDir, 'test_job_download');
        assert.ok(fs.existsSync(jobFolder), 'Job folder should exist');

        const diffFile = path.join(jobFolder, 'login_diff_desktop_chrome.jpg');
        const baselineFile = path.join(jobFolder, 'login_baseline_desktop_chrome.png');
        const currentFile = path.join(jobFolder, 'login_current_desktop_chrome.png');

        assert.ok(fs.existsSync(diffFile), 'Diff file should be saved as .jpg');
        assert.ok(fs.existsSync(baselineFile), 'Baseline file should be saved as .png');
        assert.ok(fs.existsSync(currentFile), 'Current file should be saved as .png (fallback from GIF)');

        console.log('  OK: Diffs/images resolved to correct extensions (.jpg, .png, fallback to .png)');
    } finally {
        restoreFetch();
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    }
    
    console.log('All downloadResults tests passed!\n');
}

async function testDownloadSkipsDiffOfDiffLessChange() {
    console.log('Testing downloadResults on a change with no diff image...');
    const fs = require('fs');
    const path = require('path');
    const sdk = createMockSdk();
    const job = sdk.job('job-no-diff');
    const image = () => ({
        ok: true, status: 200,
        headers: { get: (n) => n.toLowerCase() === 'content-type' ? 'image/png' : null },
        arrayBuffer: async () => new ArrayBuffer(4),
    });
    setMockFetch(async (url) => {
        if (url === 'http://localhost:9999/job/job-no-diff/summary') {
            return { ok: true, json: async () => ({
                jobId: 'job-no-diff', status: 'COMPLETED', totalUrls: 1, completedCount: 1,
                overallScore: 100, executionTime: 1, regressionCount: 1, matchCount: 0, newBaselineCount: 0, errorCount: 0,
                // A text edit inside a collapsed section: zero changed pixels, no diff image,
                // so the API hands back the current capture's link as diffUrl.
                regressions: [{
                    url: 'https://usecite.ai/compare/peec-alternative/', variantName: 'desktop_chrome',
                    diffPercentage: 0, visualMatchScore: 100, changed: true, contentChanged: true,
                    changes: [{ type: 'text-edit', element: 'p', before: '… 20-prompt …', after: '… 30-prompt …', collapsed: true }],
                    diffUrl: 'http://localhost:9999/images/current-peec',
                    currentUrl: 'http://localhost:9999/images/current-peec',
                    baselineUrl: 'http://localhost:9999/images/baseline-peec',
                }],
                matches: [], newBaselines: [], errors: [],
            }) };
        }
        if (url.startsWith('http://localhost:9999/images/')) return image();
        throw new Error(`Unexpected mock URL: ${url}`);
    });
    const testDir = path.join(__dirname, 'temp_test_downloads_nodiff');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    try {
        await job.downloadResults({ full: true, baseDir: testDir });
        const folder = path.join(testDir, 'job_no_diff');
        const files = fs.readdirSync(folder);
        assert.ok(!files.some(f => f.includes('_diff_')), `must not file the current capture as a diff: ${files}`);
        assert.ok(files.some(f => f.includes('_current_')), `--full still saves the current capture: ${files}`);
        console.log('  OK: a diff-less change saves no _diff_ file');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
}

async function testValidation() {
    console.log('Testing validation...');
    
    const sdk = createMockSdk();
    
    // Test that run() requires project or against
    console.log('  Testing validation: project/against required...');
    try {
        const builder = sdk.test('https://example.com');
        await builder.run();
        assert.fail('Should have thrown an error');
    } catch (e) {
        assert.ok(e.message.includes('Project ID is required'));
        console.log('  OK: Throws error when project/against missing');
    }
    
    // Test that default check is added when no checks/scans
    console.log('  Testing default check added...');
    setMockFetch(async (url, options) => {
        const body = JSON.parse(options.body);
        assert.strictEqual(body.paths.length, 1);
        assert.strictEqual(body.paths[0].path, '/');
        assert.strictEqual(body.paths[0].label, 'Home');
        return {
            ok: true,
            json: async () => ({ jobId: 'job-default' })
        };
    });
    
    const job = await sdk.test('https://example.com').forProject('test').run();
    assert.strictEqual(job.jobId, 'job-default');
    console.log('  OK: Default check added when no checks/scans');
    restoreFetch();
    
    console.log('All validation tests passed!\n');
}

async function testViewports() {
    console.log('Testing Viewports constant...');
    
    const { Viewports } = require('../dist/index');
    
    assert.strictEqual(Viewports.DESKTOP.width, 1920);
    assert.strictEqual(Viewports.DESKTOP.height, 1080);
    assert.strictEqual(Viewports.LAPTOP.width, 1366);
    assert.strictEqual(Viewports.LAPTOP.height, 768);
    assert.strictEqual(Viewports.TABLET.width, 768);
    assert.strictEqual(Viewports.TABLET.height, 1024);
    assert.strictEqual(Viewports.MOBILE.width, 375);
    assert.strictEqual(Viewports.MOBILE.height, 667);
    
    console.log('All Viewports tests passed!\n');
}

async function testProjectMethods() {
    console.log('Testing Project methods...');

    const sdk = createMockSdk();

    // Test getProject()
    console.log('  Testing getProject()...');
    setMockFetch(async (url) => {
        assert.strictEqual(url, 'http://localhost:9999/project/my-project');
        return {
            ok: true,
            json: async () => ({ name: 'my-project', testOrigin: 'https://example.com' })
        };
    });
    const project = await sdk.getProject('my-project');
    assert.strictEqual(project.name, 'my-project');
    console.log('  OK: getProject() works');
    restoreFetch();

    // Test listProjects()
    console.log('  Testing listProjects()...');
    setMockFetch(async (url) => {
        assert.strictEqual(url, 'http://localhost:9999/projects');
        return {
            ok: true,
            json: async () => ([{ name: 'my-project' }])
        };
    });
    const projectList = await sdk.listProjects();
    assert.strictEqual(projectList[0].name, 'my-project');
    console.log('  OK: listProjects() works');
    restoreFetch();

    // Test runProject()
    console.log('  Testing runProject()...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(url, 'http://localhost:9999/project/my-project/run');
        assert.strictEqual(options.method, 'POST');
        assert.deepStrictEqual(JSON.parse(options.body), {
            autoApprove: true,
            concurrency: 5,
            customCss: '.banner { display: none; }',
            runContext: { prTitle: 'Refresh the pricing page' }
        });
        return {
            ok: true,
            json: async () => ({ jobId: 'job-project-123' })
        };
    });
    const job = await sdk.runProject('my-project', {
        autoApprove: true,
        concurrency: 5,
        customCss: '.banner { display: none; }',
        runContext: { prTitle: 'Refresh the pricing page' }
    });
    assert.strictEqual(job.jobId, 'job-project-123');
    console.log('  OK: runProject() works');
    restoreFetch();

    // Test updateProject() carries scheduling fields, including a null to clear a schedule
    console.log('  Testing updateProject() scheduling fields...');
    setMockFetch(async (url, options) => {
        assert.strictEqual(url, 'http://localhost:9999/project/my-project');
        assert.strictEqual(options.method, 'PUT');
        assert.deepStrictEqual(JSON.parse(options.body), {
            baselinePolicy: 'rolling',
            schedule: 'daily'
        });
        // The API wraps the project in { message, project }
        return {
            ok: true,
            json: async () => ({
                message: 'Project configuration updated and baselines invalidated successfully',
                project: { name: 'my-project', baselinePolicy: 'rolling', schedule: 'daily' }
            })
        };
    });
    const updated = await sdk.updateProject('my-project', { baselinePolicy: 'rolling', schedule: 'daily' });
    assert.strictEqual(updated.schedule, 'daily', 'updateProject must unwrap the { message, project } envelope');
    assert.strictEqual(updated.message, undefined, 'updateProject must not return the envelope itself');
    restoreFetch();

    setMockFetch(async (url, options) => {
        assert.deepStrictEqual(JSON.parse(options.body), { schedule: null });
        return {
            ok: true,
            json: async () => ({ message: 'ok', project: { name: 'my-project' } })
        };
    });
    await sdk.updateProject('my-project', { schedule: null });
    console.log('  OK: updateProject() sends schedule and baselinePolicy, and unwraps the response');
    restoreFetch();

    // scheduleHourUtc pins the slot, and a 0 must survive the wire — it is 00:00 UTC, not absent
    setMockFetch(async (url, options) => {
        assert.deepStrictEqual(JSON.parse(options.body), { schedule: 'daily', scheduleHourUtc: 0 });
        return {
            ok: true,
            json: async () => ({
                message: 'ok',
                project: { name: 'my-project', schedule: 'daily', scheduleHourUtc: 0 }
            })
        };
    });
    const pinned = await sdk.updateProject('my-project', { schedule: 'daily', scheduleHourUtc: 0 });
    assert.strictEqual(pinned.scheduleHourUtc, 0, 'updateProject must read back the pinned hour');
    restoreFetch();

    setMockFetch(async (url, options) => {
        assert.deepStrictEqual(JSON.parse(options.body), { scheduleHourUtc: null });
        return {
            ok: true,
            json: async () => ({ message: 'ok', project: { name: 'my-project', schedule: 'daily' } })
        };
    });
    await sdk.updateProject('my-project', { scheduleHourUtc: null });
    console.log('  OK: updateProject() sends scheduleHourUtc, including hour 0 and a null to clear it');
    restoreFetch();

    console.log('All Project tests passed!\n');
}

async function testCliHelpers() {
    console.log('Testing CLI helpers...');
    const { parseArgs, parseFailOn, isBlocking, selectBlocking, buildRunContext, printRegression } = require('../dist/cli');

    // A CSS custom property starts with '--', so the space-separated form cannot carry it:
    // the value is indistinguishable from the next flag. --key=value is the escape hatch.
    console.log('  Testing --key=value parsing...');
    const eq = parseArgs(['--custom-css=--brand: red; color: blue', '--project', 'p']);
    assert.strictEqual(eq['custom-css'], '--brand: red; color: blue');
    assert.strictEqual(eq.project, 'p');

    // The old behaviour, kept: a space-separated value that starts with '--' is lost.
    const spaced = parseArgs(['--custom-css', '--brand: red']);
    assert.strictEqual(spaced['custom-css'], true, 'space-separated form still cannot carry a -- value');

    assert.strictEqual(parseArgs(['--a=1=2']).a, '1=2', 'splits on the first = only');
    assert.deepStrictEqual(parseArgs(['run', '--x']), Object.assign(Object.create(null), { _: ['run'], x: true }));
    console.log('  OK: --key=value parses, including values starting with --');

    console.log('  Testing prototype pollution guards...');
    assert.strictEqual(parseArgs(['--__proto__=polluted']).polluted, undefined);
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype must be untouched');
    assert.strictEqual(parseArgs(['--constructor=x']).constructor, undefined, 'constructor must not be set');
    assert.strictEqual(parseArgs(['--__proto__', 'v', '--project', 'p']).project, 'p', 'blocked key still consumes its value');
    console.log('  OK: blocked keys are dropped in both forms');

    console.log('  Testing --fail-on...');
    assert.strictEqual(parseFailOn(undefined), 'any');
    assert.strictEqual(parseFailOn('unintended'), 'unintended');
    assert.throws(() => parseFailOn('sometimes'), /--fail-on takes/);
    assert.throws(() => parseFailOn(true), /--fail-on takes/);

    // An unjudged regression must block: nothing decided it was wanted, and passing it
    // would turn a missing verdict into a silent green build.
    assert.strictEqual(isBlocking({}), true, 'no verdict blocks');
    assert.strictEqual(isBlocking({ verdict: { decision: 'bug' } }), true);
    assert.strictEqual(isBlocking({ verdict: { decision: 'needs_review' } }), true);
    assert.strictEqual(isBlocking({ verdict: { decision: 'intentional' } }), false);
    assert.strictEqual(isBlocking({ verdict: { decision: 'noise' } }), false);
    console.log('  OK: only bugs, needs-review and unjudged changes block');

    // The exit-code decision itself, not just the per-result predicate feeding it.
    console.log('  Testing which regressions fail the build...');
    const intentional = { url: '/a', verdict: { decision: 'intentional' } };
    const noise = { url: '/b', verdict: { decision: 'noise' } };
    const bug = { url: '/c', verdict: { decision: 'bug' } };
    const unjudged = { url: '/d' };

    // 'any' ignores verdicts entirely — an intentional change still fails the build.
    assert.deepStrictEqual(
        selectBlocking([intentional, noise], 'any'),
        { blocking: [intentional, noise], excused: 0 }
    );
    // 'unintended' excuses everything the verdict accounted for.
    assert.deepStrictEqual(
        selectBlocking([intentional, noise], 'unintended'),
        { blocking: [], excused: 2 }
    );
    // One bug among expected changes still fails.
    assert.deepStrictEqual(
        selectBlocking([intentional, bug, noise], 'unintended'),
        { blocking: [bug], excused: 2 }
    );
    // The silent-pass hazard: nothing judged this, so it must not be excused.
    assert.deepStrictEqual(
        selectBlocking([intentional, unjudged], 'unintended'),
        { blocking: [unjudged], excused: 1 }
    );
    assert.deepStrictEqual(selectBlocking([], 'unintended'), { blocking: [], excused: 0 });
    console.log('  OK: exit-code decision honours each mode, and never excuses an unjudged change');

    console.log('  Testing intent flags...');
    assert.strictEqual(buildRunContext({}), undefined, 'no intent flags means no runContext');
    assert.deepStrictEqual(
        buildRunContext({ 'change-description': 'restyle pricing', 'expected-changes': 'darker table, new font ', commit: 'abc123' }),
        { changeDescription: 'restyle pricing', gitCommitSha: 'abc123', expectedChanges: ['darker table', 'new font'] }
    );
    console.log('  OK: intent flags build a runContext');

    // Every optional field on PageResult can be absent on a real result: no diff image,
    // no verdict when the run carried no intent, no summary below the AI threshold.
    // Printing must survive all of that rather than throw mid-report.
    console.log('  Testing printRegression tolerates absent optional fields...');
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    try {
        printRegression({ url: '/bare', variantName: 'Desktop Chrome', visualMatchScore: 99.5, diffUrl: null });
        printRegression({
            url: '/full', variantName: 'iPhone 13', visualMatchScore: 88.25,
            diffUrl: 'https://example.com/d.png',
            verdict: { decision: 'bug', minConfidence: 0.7, avgConfidence: 0.85 },
            regressionbotSummary: [{ label: 'A', text: 'Header moved' }]
        });
    } finally {
        console.log = realLog;
    }
    assert.ok(logged.some(l => l.includes('/bare') && l.includes('99.50')), 'bare result still prints its score');
    assert.ok(!logged.some(l => l.includes('Diff: null')), 'a null diffUrl must not print as the string null');
    assert.ok(logged.some(l => l.includes('Verdict: bug')), 'verdict prints when present');
    assert.ok(logged.some(l => l.includes('[A] Header moved')), 'summary prints when present');
    console.log('  OK: printRegression handles minimal and full results');

    console.log('All CLI helper tests passed!\n');
}

async function runAllTests() {
    try {
        await testCliHelpers();
        await testJobBuilderMethods();
        await testJobHandleMethods();
        await testDownloadResults();
        await testDownloadSkipsDiffOfDiffLessChange();
        await testProjectMethods();
        await testValidation();
        await testViewports();
        console.log('✅ ALL SDK UNIT TESTS PASSED');
    } catch (err) {
        console.error('❌ SDK UNIT TESTS FAILED');
        console.error(err);
        process.exit(1);
    }
}

runAllTests();
