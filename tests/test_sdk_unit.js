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

    console.log('All Project tests passed!\n');
}

async function runAllTests() {
    try {
        await testJobBuilderMethods();
        await testJobHandleMethods();
        await testDownloadResults();
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
