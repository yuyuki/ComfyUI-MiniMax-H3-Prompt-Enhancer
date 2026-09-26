import { localPreflight } from "./preflight.js";

export const PREFLIGHT_FIELDS = ["basic_prompt", "mode", "duration_seconds", "frame_count", "aspect_ratio", "reference_context", "media_manifest", "shot_plan_json", "cinematography_json", "creative_treatment_json", "editing_intent"];

export function problemSection(item) {
    const field = String(item.location?.field ?? "").toLowerCase();
    if (field.startsWith("cinematography_json") || field.startsWith("creative_treatment_json")) return "look";
    if (/camera(start|end|path)/.test(field) || item.category === "camera") return "camera";
    if (/staging/.test(field)) return "staging";
    if (item.location?.shotId && field.startsWith("shot_plan_json")) return "shots";
    if (/subject|appearance/.test(field)) return "subjects";
    if (/environment/.test(field)) return "environments";
    if (item.location?.section === "subjects") return "subjects";
    if (/media|binding|activation|reference/.test(field) || item.category === "reference") return "media";
    if (/shot/.test(field) || item.location?.shotId || item.location?.shotIndex !== undefined) return "shots";
    return item.location?.section ?? "overview";
}

export function problemAdvice(item) {
    if (item.suggestions?.length) return item.suggestions;
    const section = problemSection(item);
    if (section === "camera") return ["Configuration: Check Camera Start target, Movement and End target. Movement and viewing direction are independent.", "Prompt alternative: Change the camera direction in the shot Action or Basic prompt to agree with these settings."];
    if (section === "media") return ["Configuration: In Media, select the affected generation. Check reference activation, file-slot assignment and role; remove assignments you do not use."];
    if (section === "shots") return ["Prompt: Give each shot a visible action.", "Configuration: Check this shot’s duration, generation, cast and references against the problem above."];
    if (section === "subjects") return ["Configuration: Select the subject and describe its identity. Include it in the appropriate generation or shot if it should appear."];
    return ["Configuration: Open the indicated section and correct the value described above. Invalid JSON can be repaired in Overview → Import & source tools."];
}

export function localProblem(item, controller) {
    const sourceShots = controller.shotDocument?.()?.value?.shots;
    const shots = Array.isArray(sourceShots) ? sourceShots : [];
    const shot = shots.find(s => s.id === item.location);
    const field = item.field ?? (shot ? `shot_plan_json.shots[${shots.indexOf(shot)}]` : item.section === "media" || item.section === "subjects" ? "media_manifest" : "shot_plan_json");
    const location = {scope: "configuration", section: item.section, field, ...(shot ? {shotId: shot.id} : {})};
    if (item.section === "subjects" && !shot) location.subjectId = item.location;
    const result = {code: item.code ?? `preflight.local.${item.section}`, severity: item.severity, category: item.section === "camera" ? "camera" : "configuration", basis: "configuration", message: item.message, location, stage: "preflight", blocks: {valid: item.severity === "error"}};
    let hash = 2166136261;
    for (const character of JSON.stringify([result.code, result.location, result.message])) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    result.fingerprint = `local-${(hash >>> 0).toString(16)}`;
    result.suggestions = problemAdvice(result);
    return result;
}

export function mergeProblems(local, backend, output, {pending = false, error = ""} = {}) {
    const seen = new Set();
    const diagnostics = [...local, ...(backend?.diagnostics ?? []), ...(output?.diagnostics ?? []).map(d => ({...d, stage: "output", stale: Boolean(output?.stale)}))].filter(item => {
        const key = JSON.stringify([item.stage, item.message, item.location]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    }).map(item => ({...item, suggestions: problemAdvice(item)}));
    const summary = {errors: 0, warnings: 0, advice: 0};
    for (const item of diagnostics) {
        if (item.stale) continue;
        if (item.severity === "error") summary.errors++;
        else if (item.severity === "warning") summary.warnings++;
        else summary.advice++;
    }
    return {...output, schemaVersion: 1, diagnostics, summary, stale: Boolean(output?.stale), preflightPending: pending, preflightError: error, preflightComplete: Boolean(backend), outputChecked: Boolean(output?.schemaVersion || output?.summary)};
}

export function createProblemService({readInputs, controller, request, output, changed, delay = 350}) {
    let snapshot = "", backend = null, pending = false, error = "", timer = null, revision = 0;
    let explanationBusy = false;
    const cache = new Map();
    const run = async () => {
        const current = ++revision;
        const inputs = readInputs();
        const key = JSON.stringify(inputs);
        snapshot = key; pending = true; error = "";
        try {
            const report = await request("preflight", inputs);
            if (current !== revision || JSON.stringify(readInputs()) !== key) return;
            backend = report;
        } catch (exc) {
            if (current === revision) error = `Preflight unavailable: ${exc.message}. Retry before generating.`;
        } finally {
            if (current === revision) { pending = false; changed(); }
        }
    };
    return {
        report() {
            const next = JSON.stringify(readInputs());
            if (snapshot !== next) {
                snapshot = next; backend = null; pending = true; error = ""; revision++;
                clearTimeout(timer); timer = setTimeout(run, delay);
            }
            let local;
            try {
                local = localPreflight({shotDocument: controller.shotDocument(), projectDocument: controller.projectDocument(), basicPrompt: controller.basicPrompt()}).items.map(item => localProblem(item, controller));
            } catch {
                local = [localProblem({severity:"error", section:"overview", message:"The planning document has an invalid structure. Open Import & source tools to correct it; backend preflight provides parser details."}, controller)];
            }
            return mergeProblems(local, backend, output(), {pending, error});
        },
        refresh() { clearTimeout(timer); return run(); },
        async explain(diagnostics, language, settings) {
            if (explanationBusy) throw new Error("An explanation is already running. Please wait.");
            const inputs = readInputs();
            // Include relevant shots plus shared configuration, not unrelated scene text.
            const context = {...inputs};
            const ids = diagnostics.map(d => d.location?.shotId).filter(Boolean);
            if (ids.length) {
                try { const plan = JSON.parse(context.shot_plan_json); context.shot_plan_json = JSON.stringify({...plan, shots: plan.shots.filter(s => ids.includes(s.id))}); } catch { /* malformed source is useful diagnostic context */ }
            }
            const key = JSON.stringify([diagnostics, context, language, settings.endpoint, settings.model]);
            if (cache.has(key)) return cache.get(key);
            explanationBusy = true;
            try {
                const answer = await request("explain", {...settings, diagnostics, context, language});
                if (JSON.stringify(readInputs()) !== JSON.stringify(inputs)) throw new Error("Configuration changed during explanation. Request a fresh explanation.");
                cache.set(key, answer.explanation);
                if (cache.size > 30) cache.delete(cache.keys().next().value);
                return answer.explanation;
            } finally { explanationBusy = false; }
        },
    };
}
