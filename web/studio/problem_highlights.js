import { problemSection } from "./problems.js";

const ALIASES = {
    action: ["Action", "Action / reaction"], description: ["Identity description", "Description", "Stable identity"],
    durationSeconds: ["Duration (seconds)", "Duration"], motionType: ["Movement", "Motion", "Camera motion"],
    primaryTarget: ["Primary target", "Target"], secondaryTarget: ["Secondary target"],
    framing: ["Framing"], angle: ["Angle"], viewpoint: ["Viewpoint"], composition: ["Composition"],
    speed: ["Speed", "Pace"], amplitude: ["Amplitude", "Travel"], text: ["Spoken words"],
    bindings: ["File slot", "Reference"], activation: ["Include in prompt"],
    cameraMotion: ["Camera motion"], dialogue: ["Spoken words", "Dialogue at this beat"],
};

export function selectProblemEntity(controller, location = {}) {
    const shots = controller.shotDocument?.()?.value?.shots ?? [];
    const project = controller.projectDocument?.()?.value ?? {};
    const normalized = String(location.field ?? "").replace(/\[(\d+)\]/g, ".$1");
    const indexed = (collection) => {
        const match = normalized.match(new RegExp(`(?:^|\\.)${collection}\\.(\\+?\\d+)(?:\\.|$)`));
        return match ? project[collection]?.[Number(match[1])]?.id : undefined;
    };
    const shotId = location.shotId ?? shots[location.shotIndex]?.id;
    if (shotId && controller.shotUiState) controller.shotUiState.selectedId = shotId;
    if (controller.projectUiState) {
        const mappings = {subjectSelectedId: location.subjectId ?? indexed("subjects"), environmentSelectedId: location.environmentId ?? indexed("environments"), selectedAssetId: location.assetId ?? indexed("assets"), selectedGenerationId: location.generationId ?? indexed("generations")};
        for (const [key, value] of Object.entries(mappings)) if (value) controller.projectUiState[key] = value;
    }
}

export function findProblemFields(panel, item) {
    let root = panel;
    const location = item.location ?? {};
    if (location.assetId && /bindings/.test(location.field ?? "")) {
        return [...(panel.querySelectorAll?.("[data-binding-asset]") ?? [])].filter(el => el.dataset.bindingAsset === location.assetId && (!location.generationId || el.dataset.generationId === location.generationId));
    }
    // Never decorate a different shot's inspector simply because its labels match.
    for (const [attribute, id] of [["shotId", location.shotId], ["subjectId", location.subjectId], ["environmentId", location.environmentId], ["assetId", location.assetId]]) {
        if (!id) continue;
        const regions = [...(root.querySelectorAll?.("[data-problem-entity]") ?? [])];
        const region = regions.find(el => el.dataset[attribute] === id);
        if (!region) return [];
        root = region;
    }
    const path = String(location.field ?? "");
    const frame = path.includes("cameraStart") ? "cameraStart" : path.includes("cameraEnd") ? "cameraEnd" : "";
    if (frame) {
        const region = [...(root.querySelectorAll?.("[data-camera-phase]") ?? [])].find(el => el.dataset.cameraPhase === frame);
        if (region) root = region;
    }
    if (path.includes("cameraPath")) {
        const planner = root.querySelector?.(".minimax-h3-camera-planner");
        if (planner) return [planner];
    }
    const leaf = path.split(/[.\[\]]/).filter(Boolean).at(-1) ?? "";
    const labels = new Set((ALIASES[leaf] ?? [leaf.replace(/([a-z])([A-Z])/g, "$1 $2")]).map(s => s.toLowerCase()));
    const exact = [...(root.querySelectorAll?.("[data-diagnostic-field]") ?? [])].filter(el => el.dataset.diagnosticField === path);
    if (exact.length) return exact;
    const targets = [...(root.querySelectorAll?.(".minimax-h3-target-editor") ?? [])].filter(el => labels.has((el.firstElementChild?.textContent ?? "").trim().toLowerCase()));
    if (targets.length === 1) return targets;
    const fields = [...(root.querySelectorAll?.(".minimax-h3-studio-field") ?? [])].filter(el => labels.has((el.dataset.fieldLabel ?? el.firstElementChild?.textContent ?? "").trim().toLowerCase()));
    // Repeated fields need an explicit diagnostic path; do not guess the wrong beat/reference.
    if (fields.length === 1) return fields;
    // Unknown children still belong to their declared camera phase.
    if (frame && root !== panel) return [root];
    return [];
}

export function decorateProblems(panel, diagnostics, section) {
    for (const note of panel.querySelectorAll?.("[data-problem-note]") ?? []) note.remove();
    for (const el of panel.querySelectorAll?.("[data-problem-severity]") ?? []) {
        delete el.dataset.problemSeverity;
        if (el.dataset.problemAria === "true") { el.removeAttribute("aria-invalid"); delete el.dataset.problemAria; }
    }
    const items = diagnostics.filter(item => !item.stale && ["error", "warning"].includes(item.severity) && problemSection(item) === section);
    if (!items.length) return;
    const mark = (element, severity) => {
        if (element.dataset.problemSeverity !== "error") element.dataset.problemSeverity = severity;
    };
    for (const item of items) {
        for (const wrapper of findProblemFields(panel, item)) {
            mark(wrapper, item.severity);
            const control = wrapper.querySelector?.("input, select, textarea");
            if (control && item.severity === "error" && control.getAttribute?.("aria-invalid") !== "true") { control.setAttribute("aria-invalid", "true"); control.dataset.problemAria = "true"; mark(control, item.severity); }
            const note = document.createElement("small");
            note.dataset.problemNote = "true"; note.className = "minimax-h3-problem-inline";
            note.textContent = `${item.severity === "error" ? "⚠ Error" : "△ Warning"}: ${item.message} ${item.suggestions?.[0] ?? ""}`;
            wrapper.appendChild(note);
            for (let ancestor = wrapper.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
                if (ancestor.tagName === "DETAILS" || ancestor.classList?.contains("minimax-h3-inspector-section")) mark(ancestor, item.severity);
            }
        }
    }
    const summary = document.createElement("div"); summary.dataset.problemNote = "true";
    summary.className = "minimax-h3-section-problems"; summary.setAttribute("role", "status");
    const errors = items.filter(item => item.severity === "error").length;
    summary.textContent = `⚠ ${errors} errors · ${items.length - errors} warnings in this section. Open Problems for all findings and practical fixes.`;
    mark(summary, errors ? "error" : "warning"); panel.prepend(summary);
}
