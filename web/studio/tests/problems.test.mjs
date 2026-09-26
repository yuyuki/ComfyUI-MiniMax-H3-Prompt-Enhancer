import assert from "node:assert/strict";
import test from "node:test";
import {createProblemService, mergeProblems, problemSection} from "../problems.js";
import {selectProblemEntity} from "../problem_highlights.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const controller = () => ({shotDocument: () => ({kind:"blank"}), projectDocument: () => ({kind:"blank"}), basicPrompt: () => "A rope."});

test("preflight is automatic, explanation is explicit, and cached only for the same context", async () => {
    let inputs = {basic_prompt:"A rope."};
    const calls = [];
    const service = createProblemService({readInputs:()=>inputs, controller:controller(), output:()=>({}), changed:()=>{}, delay:0,
        request: async (route, body) => {calls.push([route,body]); return route === "explain" ? {explanation:"Set the target."} : {diagnostics:[]};}});
    service.report(); await tick();
    assert.deepEqual(calls.map(c=>c[0]), ["preflight"]);
    const settings = {endpoint:"http://localhost:1234/v1", model:"loaded"};
    const items = [{message:"Camera conflict"}];
    await service.explain(items,"French",settings);
    await service.explain(items,"French",settings);
    assert.equal(calls.filter(c=>c[0]==="explain").length, 1);
    inputs = {basic_prompt:"Reveal Indy."};
    await service.explain(items,"French",settings);
    assert.equal(calls.filter(c=>c[0]==="explain").length, 2);
});

test("late preflight responses cannot replace the current configuration report", async () => {
    let inputs = {basic_prompt:"old"};
    const pending = [];
    const service = createProblemService({readInputs:()=>inputs, controller:controller(), output:()=>({}), changed:()=>{}, delay:0,
        request: () => new Promise(resolve => pending.push(resolve))});
    service.report(); await tick(); inputs = {basic_prompt:"new"}; service.report(); await tick();
    pending[1]({diagnostics:[{message:"new",severity:"error"}]}); await tick();
    pending[0]({diagnostics:[{message:"old",severity:"error"}]}); await tick();
    assert.deepEqual(service.report().diagnostics.map(d=>d.message), ["new"]);
});

test("stale output remains readable but does not inflate current error counts", () => {
    const report = mergeProblems([{message:"current",severity:"warning"}], {diagnostics:[]}, {stale:true,diagnostics:[{message:"old",severity:"error"}]});
    assert.equal(report.summary.errors,0); assert.equal(report.summary.warnings,1);
    assert.equal(report.diagnostics[1].stale,true);
});

test("navigation selects the named entity and preserves camera/look ownership", () => {
    const c = {...controller(), projectUiState:{}, shotUiState:{}, projectDocument:()=>({value:{subjects:[{id:"indy"}]}}), shotDocument:()=>({value:{shots:[{id:"rope"},{id:"reveal"}]}})};
    selectProblemEntity(c,{field:"media_manifest.subjects[0].description",shotIndex:1});
    assert.equal(c.projectUiState.subjectSelectedId,"indy"); assert.equal(c.shotUiState.selectedId,"reveal");
    assert.equal(problemSection({category:"camera",location:{field:"cinematography_json.cameraMotion"}}),"look");
    assert.equal(problemSection({location:{field:"shot_plan_json.shots[1].cameraPath"}}),"camera");
});

test("provider failure leaves deterministic diagnostics available", async () => {
    const service = createProblemService({readInputs:()=>({}),controller:controller(),output:()=>({diagnostics:[{message:"Known error",severity:"error"}]}),changed:()=>{},delay:0,
        request:async()=>{throw new Error("Offline");}});
    service.report(); await tick();
    assert.match(service.report().preflightError,/Offline/);
    assert.equal(service.report().diagnostics[0].message,"Known error");
    await assert.rejects(()=>service.explain([{message:"Known error"}],"English",{}),/Offline/);
    assert.equal(service.report().diagnostics.length,1);
});

test("field borders follow the correct entity, disappear after repair, and preserve existing validity", async () => {
    const {decorateProblems, findProblemFields} = await import("../problem_highlights.js");
    class Element {
        constructor(tag="div", className="") { this.tagName=tag.toUpperCase(); this.className=className; this.children=[]; this.dataset={}; this.attrs={}; this.classList={contains: name=>this.className.split(" ").includes(name)}; }
        appendChild(el) {this.children.push(el);el.parentElement=this;return el;}
        prepend(el) {this.children.unshift(el);el.parentElement=this;}
        setAttribute(k,v) {this.attrs[k]=v;}
        getAttribute(k) {return this.attrs[k];}
        removeAttribute(k) {delete this.attrs[k];}
        remove() {this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
        querySelector(s) {return this.querySelectorAll(s)[0];}
        querySelectorAll(s) {
            const matches = el => s.split(",").some(part=>{
                part=part.trim();
                if (part.startsWith(".")) return el.classList.contains(part.slice(1));
                if (part.startsWith("[data-")) {const key=part.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return Object.hasOwn(el.dataset,key);}
                return el.tagName.toLowerCase()===part;
            });
            return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(s)]);
        }
    }
    const saved = globalThis.document;
    globalThis.document={createElement:tag=>new Element(tag)};
    try {
        const panel=new Element(); const entity=panel.appendChild(new Element());entity.dataset.problemEntity="true";entity.dataset.shotId="rope";
        const disclosure=entity.appendChild(new Element("details"));
        const field=disclosure.appendChild(new Element("label","minimax-h3-studio-field"));field.dataset.fieldLabel="Action";
        const input=field.appendChild(new Element("textarea"));
        const finding={severity:"error",message:"Action required",suggestions:["Describe the shot."],location:{shotId:"rope",field:"shot_plan_json.shots[0].action"}};
        assert.equal(findProblemFields(panel,finding)[0],field);
        assert.equal(findProblemFields(panel,{...finding,location:{...finding.location,shotId:"indy"}}).length,0);
        decorateProblems(panel,[finding],"shots");
        assert.equal(field.dataset.problemSeverity,"error"); assert.equal(disclosure.dataset.problemSeverity,"error"); assert.equal(input.getAttribute("aria-invalid"),"true");
        decorateProblems(panel,[],"shots");
        assert.equal(field.dataset.problemSeverity,undefined);assert.equal(input.getAttribute("aria-invalid"),undefined);
        input.setAttribute("aria-invalid","true"); decorateProblems(panel,[finding],"shots");decorateProblems(panel,[],"shots");
        assert.equal(input.getAttribute("aria-invalid"),"true");
    } finally {globalThis.document=saved;}
});
