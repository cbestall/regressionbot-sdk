export interface ProjectPath {
    path: string;
    label?: string;
}

export interface ProjectScan {
    pattern: string;
    options?: {
        limit?: number;
        exclude?: string[];
    };
}

/**
 * Credentials for reaching an origin behind an environment gate — basic auth,
 * a bypass header, or a session cookie. Write-only: the API never returns these,
 * only a `{ configured: true }` presence flag.
 */
export interface EnvGate {
    basic?: { username: string; password: string };
    headers?: Record<string, string>;
    cookies?: Array<{ name: string; value: string }>;
}

/** How a project's baseline advances between runs. Absent means `approved`. */
export type BaselinePolicy = 'approved' | 'rolling';

/** Frequency at which a project runs unattended. */
export type ProjectSchedule = 'hourly' | 'daily' | 'weekly';

/**
 * A saved project as the API returns it.
 *
 * This is a read shape. To change a project, pass {@link ProjectConfigUpdate}
 * to updateProject() — the two differ, because gate credentials are written as
 * an {@link EnvGate} but read back only as a presence flag.
 */
export interface ProjectConfig {
    name: string;
    testOrigin: string;
    baseOrigin?: string;
    sitemapUrl?: string;
    paths?: ProjectPath[];
    scans?: ProjectScan[];
    devices: string[];
    masks?: string[];
    /** CSS injected before screenshotting, to hide dynamic widgets. Max 4096 characters. */
    customCss?: string;
    /** Presence flag only — the stored credential is never returned. */
    testAuth?: { configured: true };
    /** Presence flag only — the stored credential is never returned. */
    baseAuth?: { configured: true };
    concurrency?: number;
    /** Extra instructions handed to the model that writes change summaries. */
    aiPromptInstructions?: string;
    /** Diff percentage below which a regression is skipped by the AI pass. Defaults to 0.01. */
    aiSummaryThreshold?: number;
    /**
     * `approved` (default): a person accepts a run and its captures become the baseline.
     * `rolling`: every completed managed run advances it, and those runs auto-approve.
     */
    baselinePolicy?: BaselinePolicy;
    /** Set when the project runs unattended. Absent means it only runs when triggered. */
    schedule?: ProjectSchedule;
    /**
     * The UTC hour, 0–23, at which a `daily` or `weekly` project runs — `3` is 03:00 UTC.
     * Absent means the slot anchors to whenever the first sweep picked the project up.
     */
    scheduleHourUtc?: number;
    /**
     * The API key recorded when the schedule was set; every scheduled run is attributed
     * to it. Absent if the schedule was set without an API key, in which case AI
     * summaries are skipped for those runs.
     */
    scheduleKeyId?: string;
    /** When the scheduler last started a run. The next run is due one interval after this. */
    lastScheduledRunAt?: string;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    lastJobId?: string;
    baselineVersion?: string;
    baselineInvalidatedAt?: string;
}

/**
 * The fields updateProject() accepts.
 *
 * Changing anything that decides what a capture looks like — testOrigin,
 * baseOrigin, sitemapUrl, paths, scans, devices, masks, customCss, or a gate
 * credential — invalidates the stored baselines, and the next run re-captures
 * them instead of comparing. Everything else leaves baselines alone.
 * Re-sending an identical value is not a change.
 */
export interface ProjectConfigUpdate {
    testOrigin?: string;
    baseOrigin?: string;
    sitemapUrl?: string;
    paths?: ProjectPath[];
    scans?: ProjectScan[];
    devices?: string[];
    masks?: string[];
    /** Max 4096 characters. */
    customCss?: string;
    /** Credentials for the test origin's environment gate. Pass null to clear. */
    testAuth?: EnvGate | null;
    /** Credentials for the base origin's environment gate. Pass null to clear. */
    baseAuth?: EnvGate | null;
    concurrency?: number;
    aiPromptInstructions?: string;
    aiSummaryThreshold?: number;
    baselinePolicy?: BaselinePolicy;
    /**
     * Run this project unattended at this frequency. Requires `baselinePolicy: 'rolling'`
     * on a managed project — the API rejects the combination without it, because on the
     * approved policy an unapproved change is re-reported on every subsequent run.
     * Live-vs-live projects store no baseline and are exempt. Pass null to remove.
     *
     * Without `scheduleHourUtc` the first run starts at the next hourly sweep and the
     * cadence anchors to it.
     */
    schedule?: ProjectSchedule | null;
    /**
     * Pin a `daily` or `weekly` schedule to this UTC hour, 0–23 — `3` means 03:00 UTC.
     * The first run waits for the hour too, rather than firing immediately and settling
     * into the hour from the following day. Hours only, because the scheduler sweeps once
     * an hour; UTC only, because RegressionBot has no timezone to convert from.
     *
     * Rejected on an `hourly` schedule, which already runs every hour, and rejected if the
     * project has no schedule to apply it to — either one already set, or one sent in the
     * same update. Clearing the schedule with
     * `schedule: null` clears this too, so re-enabling later cannot resurrect an hour
     * nobody asked for on that run. Pass null to clear it on its own.
     *
     * A missed slot waits for the next one rather than catching up.
     */
    scheduleHourUtc?: number | null;
}

export interface VRConfig {
    apiKey?: string;
    apiUrl?: string;
}

export interface Viewport {
    width: number;
    height: number;
}

export const Viewports = {
    DESKTOP: { width: 1920, height: 1080 },
    LAPTOP: { width: 1366, height: 768 },
    TABLET: { width: 768, height: 1024 },
    MOBILE: { width: 375, height: 667 }
} as const;

export type VerdictDecision = 'intentional' | 'bug' | 'noise' | 'needs_review';

/** How one labelled region of a diff was judged against the run's stated intent. */
export interface RegionVerdict {
    decision: VerdictDecision;
    /** 0–1. */
    confidence: number;
    reasoning: string;
}

/** The rolled-up verdict for one result, plus the per-region verdicts behind it. */
export interface ResultVerdict {
    decision: VerdictDecision;
    minConfidence: number;
    avgConfidence: number;
    /** Keyed by region label (A, B, C…). Empty when the verdict came from the text-only pass. */
    regions: Record<string, RegionVerdict>;
    /**
     * What the judgement was made from.
     *
     * `measured` — the exact edits from the document diff were in front of the model.
     * `described` — only a generated sentence about the change was, because the DOM engine
     * could not run on that page. Absent on the vision path, which reads the images.
     *
     * Worth more than the confidence numbers when deciding how much weight to give a
     * verdict: a `described` one was reached without seeing what actually changed.
     */
    basis?: 'measured' | 'described';
}

/**
 * One change on a page, computed by diffing the two documents rather than described by a
 * model. This is the exact answer to "what changed" — read it before the prose summary.
 */
export interface Change {
    /** text-edit, insert, delete, move-with-edit, style-only. */
    type: string;
    /** Tag name of the element that changed. */
    element: string;
    /** The text before the edit. Absent on an insert. */
    before?: string;
    /** The text after the edit. Absent on a delete. */
    after?: string;
    /** Changed computed styles, as property -> [from, to]. */
    style?: Record<string, [string, string]>;
    /** Where it sits in the current capture, in capture pixels. Absent on a delete. */
    box?: { x: number; y: number; w: number; h: number };
    /** Where it was in the baseline, present only when it differs from `box`. */
    boxBefore?: { x: number; y: number; w: number; h: number };
}

export interface RegressionbotSummaryItem {
    /** Region letter (A, B, C…), or an empty string for a whole-page change. */
    label: string;
    /** Single-sentence description of what changed in that region. */
    text: string;
    verdict?: RegionVerdict;
}

/**
 * Result for a single URL + device comparison.
 *
 * Returned by getStatus() and, split across `regressions`/`matches`, by
 * getSummary(). Both endpoints pre-sign the image URLs; a URL is null when
 * that image does not exist for this result (no baseline yet, no diff, …).
 */
export interface PageResult {
    url: string;
    /** Whether the capture and comparison succeeded. */
    status: 'SUCCESS' | 'ERROR';
    /** Device variant tested (e.g. "Desktop Chrome", "iPhone 12"). */
    variantName: string;
    /** Percentage of pixels that differed from the baseline (0 = identical). */
    diffPercentage: number;
    /** Perceptual similarity 0-100 (SSIM). */
    visualMatchScore: number;
    /** True when this capture became a baseline because none existed to compare against. */
    isNewBaseline: boolean;
    /** Why the capture or comparison failed. Present when status is ERROR. */
    errorMessage?: string;
    /** Plain-English description of what visually changed, generated by RegressionBot. */
    regressionbotSummary?: RegressionbotSummaryItem[];
    /**
     * Whether the change was judged intentional, a bug, or noise. Only produced when
     * the run carried a {@link RunContext}, and only once summaryStatus is COMPLETE.
     */
    verdict?: ResultVerdict;
    /**
     * The exact edits the engine computed from the two documents — element, text before,
     * text after, changed styles. Absent when the DOM comparison could not run on the page,
     * which is not the same as nothing having changed.
     *
     * Prefer this over `regressionbotSummary`: it is measured rather than described, so it
     * carries no confidence and can be quoted directly.
     */
    changes?: Change[];
    /** Selectors of the elements that changed, when the DOM comparison could identify them. */
    elementsChanged?: string[];
    /**
     * Set when the DOM comparison could not run. The result is a plain pixel diff with
     * no semantic change types, so treat its classifications as absent rather than as
     * "nothing structural changed".
     */
    domAssistSkipReason?: string;
    /** Pre-signed URL for the stored baseline screenshot. */
    baselineUrl: string | null;
    /** Pre-signed URL for the newly captured screenshot. */
    currentUrl: string | null;
    /** Pre-signed URL for the side-by-side annotated diff image. */
    diffUrl: string | null;
    /**
     * Pre-signed URL for the diff mask. getStatus() always sends the key, null when
     * there is no mask; getSummary() omits it entirely in that case.
     */
    maskUrl?: string | null;
}

export interface JobProgress {
    total: number;
    completed: number;
    percent: string;
}

/** Progress of the asynchronous AI summary pass. */
export type SummaryStatus = 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';

export interface JobStatus {
    jobId: string;
    status: 'INITIALIZING' | 'PROCESSING' | 'FINISHING' | 'SUMMARIZING' | 'COMPLETED' | 'APPROVED' | 'FAILED';
    /**
     * PENDING means not yet started, COMPLETE that regressionbotSummary is populated
     * (or that nothing needed one). Poll until COMPLETE before reading summaries.
     */
    summaryStatus: SummaryStatus;
    error: string | null;
    progress: JobProgress;
    executionTime: number;
    createdAt: string;
    /** Partial or complete results. Fills in as workers finish. */
    results: PageResult[];
}

export interface JobSummary {
    jobId: string;
    /** getSummary() throws until the job reaches one of these. */
    status: 'COMPLETED' | 'APPROVED' | 'FAILED';
    summaryStatus: SummaryStatus;
    error: string | null;
    totalUrls: number;
    completedCount: number;
    /** Overall quality score 0–100 across all tested pages. */
    overallScore: number;
    executionTime: number;
    regressionCount: number;
    matchCount: number;
    newBaselineCount: number;
    errorCount: number;
    /** Pages where a visual regression was detected. */
    regressions: PageResult[];
    /** Pages that matched the baseline. */
    matches: PageResult[];
    /** Pages captured for the first time — no baseline existed to compare against. */
    newBaselines: Array<{ url: string; variantName: string }>;
    /** Pages that failed to capture or compare. */
    errors: Array<{ url: string; variantName: string; errorMessage: string }>;
    /** Whole-job roll-up of how the changes line up with the run's stated intent. */
    intentAssessment: IntentAssessment;
    /** The intent this run was given, echoed back. */
    runContext?: RunContext;
}

/**
 * What a run is testing. Supplying it lets RegressionBot judge each change as
 * intentional, a bug, or noise, rather than just reporting that pixels moved.
 */
export interface RunContext {
    /** Short description of what this run is testing. */
    changeDescription?: string;
    gitCommitSha?: string;
    /** Git commit subject line. */
    gitCommitMessage?: string;
    prTitle?: string;
    /** Markdown. Truncated to 2000 characters by the API. */
    prDescription?: string;
    /** Explicit list of expected visual changes. */
    expectedChanges?: string[];
    /** Files or component names changed. */
    scope?: string[];
}

export interface IntentAssessment {
    /** False when the run carried no RunContext, in which case the counts are all zero. */
    intentProvided: boolean;
    bugCount: number;
    intentionalCount: number;
    noiseCount: number;
    needsReviewCount: number;
    /** True when every regression is accounted for by the stated intent. */
    allAccountedFor: boolean;
    /** One line summarising the job, safe to print straight into CI output. */
    summary: string;
}

export interface ApproveResult {
    message: string;
    jobId: string;
    approvedUrlsCount: number;
    /** Present when some captures could not be promoted. */
    failedCount?: number;
    /** Pages skipped because another job updated their baseline first. */
    conflictedUrls?: string[];
}

export interface JobAiSummary {
    message: string;
    jobId: string;
    summaries: Array<{
        url: string;
        variantName: string;
        regressionbotSummary: RegressionbotSummaryItem[];
    }>;
}
