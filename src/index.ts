import {
    VRConfig,
    Viewport,
    Viewports,
    JobStatus,
    JobSummary,
    JobProgress,
    PageResult,
    ProjectConfig,
    ProjectPath,
    ProjectScan,
    JobAiSummary,
    RegionVerdict,
    ResultVerdict,
    VerdictDecision,
    RegressionbotSummaryItem,
    RunContext,
    IntentAssessment,
    BaselinePolicy,
    ProjectSchedule,
    ProjectConfigUpdate,
    EnvGate,
    SummaryStatus,
    ApproveResult
} from './types';
import {
    sanitizeFilename,
    sanitizeUrlToPath,
    warnIfInsecure,
    validateProtocol,
    handleApiError,
    fetchWithTimeout
} from './security';

export { sanitizeFilename, sanitizeUrlToPath, Viewports };
export type {
    PageResult,
    JobProgress,
    JobStatus,
    JobSummary,
    Viewport,
    VRConfig,
    ProjectConfig,
    ProjectPath,
    ProjectScan,
    JobAiSummary,
    RegionVerdict,
    ResultVerdict,
    VerdictDecision,
    RegressionbotSummaryItem,
    RunContext,
    IntentAssessment,
    BaselinePolicy,
    ProjectSchedule,
    ProjectConfigUpdate,
    EnvGate,
    SummaryStatus,
    ApproveResult
};

export class RegressionBot {
    private apiKey: string;
    private apiUrl: string;

    constructor(apiKey?: string, apiUrl?: string) {
        this.apiKey = apiKey || process.env.REGRESSIONBOT_API_KEY || "";
        this.apiUrl = apiUrl || process.env.REGRESSIONBOT_API_URL || "https://api.regressionbot.com";
        
        if (!this.apiKey) {
            console.warn("Warning: No API Key provided. Set REGRESSIONBOT_API_KEY environment variable or pass it to the constructor.");
        }
        
        if (this.apiUrl.endsWith('/')) {
            this.apiUrl = this.apiUrl.slice(0, -1);
        }

        // 🛡️ SECURITY: Warn about unencrypted data transmission
        warnIfInsecure(this.apiUrl);
        validateProtocol(this.apiUrl, 'API URL');
    }

    /**
     * Set the candidate URL/Origin to test.
     */
    public test(origin: string): JobBuilder {
        return new JobBuilder(this, origin);
    }

    /**
     * Get a handle to an existing job.
     */
    public job(jobId: string): JobHandle {
        return new JobHandle(this, jobId);
    }

    /**
     * Get configuration details for a saved project.
     */
    public async getProject(projectName: string): Promise<ProjectConfig> {
        return this._request(`/project/${encodeURIComponent(projectName)}`);
    }

    /**
     * List all saved projects for the authenticated organization.
     */
    public async listProjects(): Promise<ProjectConfig[]> {
        return this._request<ProjectConfig[]>('/projects');
    }

    /**
     * Trigger a new job run using a saved project configuration.
     */
    public async runProject(
        projectName: string,
        options: {
            testOrigin?: string;
            url?: string;
            sitemapUrl?: string;
            baseOrigin?: string;
            devices?: string[];
            paths?: Array<{ path: string; label?: string }>;
            scans?: Array<{ pattern: string; options?: any }>;
            masks?: string[];
            /** CSS injected before screenshotting. Max 4096 characters. */
            customCss?: string;
            concurrency?: number;
            autoApprove?: boolean;
        } = {}
    ): Promise<JobHandle> {
        const res = await this._request<{ jobId: string }>(
            `/project/${encodeURIComponent(projectName)}/run`,
            'POST',
            options
        );
        return new JobHandle(this, res.jobId);
    }

    /**
     * Update the configuration settings for a named project.
     *
     * Changing anything that decides what a capture looks like invalidates the
     * stored baselines — see {@link ProjectConfigUpdate}.
     */
    public async updateProject(
        projectName: string,
        config: ProjectConfigUpdate
    ): Promise<ProjectConfig> {
        // The API wraps the updated project in { message, project }.
        const res = await this._request<{ message: string; project: ProjectConfig }>(
            `/project/${encodeURIComponent(projectName)}`,
            'PUT',
            config
        );
        return res.project;
    }


    // Internal fetch wrapper
    public async _request<T>(path: string, method: string = 'GET', body?: any): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'x-api-key': this.apiKey
        };

        const response = await fetchWithTimeout(`${this.apiUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'error'
        });

        if (!response.ok) {
            await handleApiError(response, this.apiKey);
        }

        return await response.json() as T;
    }
}

export class JobBuilder {
    private sdk: RegressionBot;
    private manifest: {
        testOrigin: string;
        sitemapUrl?: string;
        baseOrigin?: string;
        projectId?: string;
        variants: string[];
        checks: Array<{ path: string, label?: string }>;
        scans: Array<{ pattern: string, options?: any }>;
        concurrency: number;
        masks?: string[];
        customCss?: string;
        autoApprove?: boolean;
        runContext?: RunContext;
    };

    constructor(sdk: RegressionBot, testOrigin: string) {
        validateProtocol(testOrigin, 'testOrigin');
        this.sdk = sdk;
        this.manifest = {
            testOrigin: testOrigin.replace(/\/$/, ''),
            variants: [],
            checks: [],
            scans: [],
            concurrency: 10
        };
    }

    public against(origin: string): this {
        validateProtocol(origin, 'baseOrigin');
        this.manifest.baseOrigin = origin.replace(/\/$/, '');
        return this;
    }

    public sitemap(url: string): this {
        validateProtocol(url, 'sitemapUrl');
        this.manifest.sitemapUrl = url;
        return this;
    }

    public forProject(id: string): this {
        this.manifest.projectId = id;
        return this;
    }

    /**
     * Define the matrix: list of Playwright devices or viewport names.
     */
    public on(variants: string[]): this {
        this.manifest.variants.push(...variants);
        return this;
    }

    /**
     * Add a specific page to the test scope.
     */
    public check(path: string, label?: string): this {
        this.manifest.checks.push({ path, label });
        return this;
    }

    /**
     * Add a discovery rule to scan the sitemap.
     */
    public scan(pattern: string, options?: { limit?: number, exclude?: string[] }): this {
        this.manifest.scans.push({ pattern, options });
        return this;
    }

    public concurrency(n: number): this {
        this.manifest.concurrency = n;
        return this;
    }

    public autoApprove(val: boolean = true): this {
        this.manifest.autoApprove = val;
        return this;
    }

    public mask(selectors: string[]): this {
        this.manifest.masks = selectors;
        return this;
    }

    /**
     * Inject custom CSS before each screenshot, e.g. to hide a dynamic widget:
     * `'#chat-widget { display: none !important; }'`. Max 4096 characters.
     */
    public customCss(css: string): this {
        this.manifest.customCss = css;
        return this;
    }

    /**
     * Describe what this run is testing — commit, PR, expected changes — so
     * RegressionBot can judge whether each change was intentional.
     * Merges with anything set by an earlier call.
     */
    public withContext(context: RunContext): this {
        this.manifest.runContext = { ...this.manifest.runContext, ...context };
        return this;
    }

    /**
     * Compiles the manifest and triggers the API.
     */
    public async run(): Promise<JobHandle> {
        if (!this.manifest.projectId && !this.manifest.baseOrigin) {
            throw new Error('Project ID is required. Use .forProject("id") or provide an origin to compare against using .against()');
        }

        // If no checks/scans provided, default to root
        if (this.manifest.checks.length === 0 && this.manifest.scans.length === 0) {
            this.manifest.checks.push({ path: '/', label: 'Home' });
        }

        const payload = {
            project: this.manifest.projectId,
            testOrigin: this.manifest.testOrigin,
            sitemapUrl: this.manifest.sitemapUrl,
            baseOrigin: this.manifest.baseOrigin,
            devices: this.manifest.variants,
            paths: this.manifest.checks,
            scans: this.manifest.scans,
            concurrency: this.manifest.concurrency,
            autoApprove: this.manifest.autoApprove,
            masks: this.manifest.masks,
            customCss: this.manifest.customCss,
            runContext: this.manifest.runContext
        };

        const res = await this.sdk._request<{ jobId: string }>('/crawl', 'POST', payload);
        return new JobHandle(this.sdk, res.jobId);
    }
}

export class JobHandle {
    private sdk: RegressionBot;
    public jobId: string;

    constructor(sdk: RegressionBot, jobId: string) {
        this.sdk = sdk;
        this.jobId = jobId;
    }

    public async getStatus(): Promise<JobStatus> {
        return this.sdk._request<JobStatus>(`/job/${encodeURIComponent(this.jobId)}`);
    }

    public async getSummary(): Promise<JobSummary> {
        return this.sdk._request<JobSummary>(`/job/${encodeURIComponent(this.jobId)}/summary`);
    }

    public async approve(): Promise<ApproveResult> {
        return this.sdk._request<ApproveResult>('/approve', 'POST', { jobId: this.jobId });
    }

    /**
     * Generate AI summaries on-demand for all regressions in a completed job.
     */
    public async generateAiSummary(): Promise<JobAiSummary> {
        return this.sdk._request<JobAiSummary>(`/job/${encodeURIComponent(this.jobId)}/ai-summary`, 'POST');
    }


    /**
     * Download images for the job locally.
     * @param options Download options.
     */
    public async downloadResults(options: { 
        full?: boolean, 
        baseDir?: string 
    } = {}): Promise<void> {
        const summary = await this.getSummary();
        const fs = require('fs');
        const path = require('path');
        const baseDir = options.baseDir || path.join(process.cwd(), 'regressions');
        const safeJobId = sanitizeFilename(this.jobId);
        const jobDir = path.join(baseDir, safeJobId);

        if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

        const download = async (url: string, baseName: string) => {
            try {
                // 🛡️ SECURITY: Prevent SSRF and local file reads by enforcing HTTP(S) protocol
                validateProtocol(url, 'download URL');

                // 🛡️ SECURITY: Fetch with timeout
                const res = await fetchWithTimeout(url);
                
                if (!res.ok) {
                    console.warn(`Warning: Failed to download ${baseName} from ${url} (Status: ${res.status})`);
                    return;
                }
                
                // Determine file extension from Content-Type header
                const contentType = res.headers.get('content-type') || '';
                let ext = '.png'; // default fallback
                if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
                    ext = '.jpg';
                }

                const finalName = `${baseName}${ext}`;
                const buffer = Buffer.from(await res.arrayBuffer());
                const filePath = path.join(jobDir, finalName);
                fs.writeFileSync(filePath, buffer);
            } catch (err: any) {
                console.warn(`Warning: Failed to download ${baseName}: ${err.message}`);
            }
        };

        // Regressions
        for (const r of summary.regressions) {
            const nameBase = sanitizeUrlToPath(r.url);
            const safeVariant = sanitizeFilename(r.variantName);

            if (r.diffUrl) await download(r.diffUrl, `${nameBase}_diff_${safeVariant}`);
            if (options.full) {
                if (r.baselineUrl) await download(r.baselineUrl, `${nameBase}_baseline_${safeVariant}`);
                if (r.currentUrl) await download(r.currentUrl, `${nameBase}_current_${safeVariant}`);
            }
        }

        // Matches (Full only)
        if (options.full && summary.matches) {
            for (const m of summary.matches) {
                const nameBase = sanitizeUrlToPath(m.url);
                const safeVariant = sanitizeFilename(m.variantName);

                if (m.baselineUrl) await download(m.baselineUrl, `${nameBase}_baseline_${safeVariant}`);
                if (m.currentUrl) await download(m.currentUrl, `${nameBase}_current_${safeVariant}`);
            }
        }
    }

    /**
     * Poll until the job reaches a terminal state (COMPLETED, APPROVED, or FAILED).
     * @param intervalMs Polling interval in milliseconds. Defaults to 2000.
     * @param callback Optional callback invoked on each status poll.
     * @param options.waitForSummaries If true, keeps polling until AI summaries are fully populated before returning.
     */
    public async waitForCompletion(
        intervalMs: number = 2000,
        callback?: (status: JobStatus) => void,
        options?: { waitForSummaries?: boolean }
    ): Promise<JobStatus> {
        while (true) {
            const status = await this.getStatus();
            if (callback) callback(status);
            if (status.status === 'COMPLETED' || status.status === 'APPROVED') {
                if (options?.waitForSummaries) {
                    if (status.summaryStatus !== 'PENDING' && status.summaryStatus !== 'PROCESSING') {
                        return status;
                    }
                } else {
                    return status;
                }
            }
            if (status.status === 'FAILED') throw new Error(`Job Failed: ${status.error}`);
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }
}
