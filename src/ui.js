// DOM wiring: controls, readouts and the presentation refresh loop.

import { METRES_PER_MM, SECONDS_PER_MICROSECOND, SECONDS_PER_NANOSECOND } from "./constants.js";
import { expectedFlightTime, fillState, beamVelocity } from "./physics.js";
import {
    config,
    state,
    analysis,
    SAMPLE_MIXTURES,
    applySample,
    setCustomSpecies,
    rebuildRuntime,
    resetBeam,
    speciesPresence
} from "./state.js";
import {
    acquisition,
    startAcquisition,
    stopAcquisition,
    advanceAcquisition,
    acquisitionProgress,
    rebuildSpectrum,
    massFromTime
} from "./acquire.js";
import {
    focusCurve,
    mirrorTuneCurve,
    createMirrorTuner,
    resolutionBudget
} from "./focus.js";
import { elutionField, elutionFraction, elutionStatus, rampFieldAt } from "./tims.js";
import {
    initPlots,
    resizePlots,
    drawSpectrum,
    drawCalibration,
    drawFocus,
    drawTune,
    drawBudget,
    drawMobility,
    drawPushDial,
    spectrumCanvasToTime,
    spectrumView
} from "./plots.js";
import { invalidateRender, view, advanceFrame } from "./render3d.js";
import { createTourController } from "./tour.js";

const PRESENTATION_INTERVAL_MS = 40;
const ACQUIRE_BUDGET_MS = 14;
const TUNE_BUDGET_MS = 14;
const BUDGET_ION_COUNT = 500;
const DEFERRED_TASK_DELAY_MS = 30;
const PLAN_VIEW = { rotationX: -Math.PI / 2 + 0.001, rotationY: 0 };
const SIDE_VIEW = { rotationX: 0, rotationY: 0 };
const DEFAULT_VIEW = { rotationX: -0.5, rotationY: 0 };

let p5Instance = null;
let customSpecies = [];
let analysisMz = 1000;

function element(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const node = element(id);
    if (node) node.innerText = value;
}

function microseconds(seconds) {
    return `${(seconds / SECONDS_PER_MICROSECOND).toFixed(3)} µs`;
}

// The m/z the focus, tune and budget analyses are run at: whichever species in
// the sample is most abundant, so the numbers describe the peak the user is
// actually looking at.
function analysisMassToCharge() {
    let best = null;
    for (const species of state.species) {
        if (!best || species.abundance > best.abundance) best = species;
    }
    return best ? best.mz : 1000;
}

function refreshModeVisibility() {
    const isTims = config.mode === "tims";
    element("btn-mode-continuous").classList.toggle("active", !isTims);
    element("btn-mode-tims").classList.toggle("active", isTims);
    element("btn-mode-continuous").setAttribute("aria-pressed", String(!isTims));
    element("btn-mode-tims").setAttribute("aria-pressed", String(isTims));
    setText("stat-mode", isTims ? "TIMS ramp" : "Continuous");
}

function refreshControlLabels() {
    setText("lbl-accel", `${config.accelVoltageKv.toFixed(2)} kV`);
    setText("lbl-pusher-field", `${config.pusherFieldVPerMm} V/mm`);
    setText("lbl-pusher-gap", `${config.pusherGapMm.toFixed(1)} mm`);
    setText("lbl-accel-gap", `${config.accelGapMm} mm`);
    setText("lbl-pusher-length", `${config.pusherLengthMm} mm`);
    setText("lbl-push-frequency", `${config.pushFrequencyKhz.toFixed(1)} kHz`);
    setText("lbl-drift", `${config.driftLengthMm} mm`);
    setText("lbl-aperture", `${config.apertureHalfHeightMm} mm`);
    setText("lbl-stage1", `${config.mirrorStage1Mm} mm`);
    setText("lbl-stage2", `${config.mirrorStage2Mm} mm`);
    setText("lbl-mirror-height", `${config.mirrorHalfHeightMm} mm`);
    setText("lbl-mirror-stage1", `${config.mirrorStage1Fraction.toFixed(4)} × E`);
    setText("lbl-mirror-back", `${config.mirrorBackFraction.toFixed(4)} × E`);
    setText("lbl-beam-energy", `${config.beamEnergyEv.toFixed(1)} eV`);
    setText("lbl-beam-spread", `${config.beamEnergySpreadEv.toFixed(2)} eV`);
    setText("lbl-beam-thickness", `${config.beamThicknessMm.toFixed(2)} mm`);
    setText("lbl-beam-height", `${config.beamHeightMm.toFixed(2)} mm`);
    setText("lbl-beam-offset", `${config.beamOffsetMm.toFixed(1)} mm`);
    setText("lbl-beam-temp", `${config.beamTemperatureK} K`);
    setText("lbl-align", config.detectorAlignMz.toString());
    setText("lbl-detector-length", `${config.detectorLengthMm} mm`);
    setText("lbl-detector-height", `${config.detectorHalfHeightMm} mm`);
    setText("lbl-detector-shift", `${config.detectorShiftMm} mm`);
    setText("lbl-exaggeration", `×${config.transverseExaggeration}`);
    setText("lbl-density", config.liveBeamDensity.toString());
    setText("lbl-opacity", `${config.electrodeOpacity}%`);
    setText("lbl-ions-species", config.ionsPerSpecies.toString());
    setText("lbl-bin", `${config.binWidthPs} ps`);
    setText("lbl-response", `${config.singleIonResponseNs.toFixed(2)} ns`);
    setText("lbl-ions-push", config.ionsPerPush.toString());
    setText("lbl-transients", config.transientCount.toString());
    setText("lbl-saturation", config.saturationPerTransient > 0
        ? `${config.saturationPerTransient.toFixed(1)} ions/bin`
        : "off");
    setText("lbl-delay", `${config.electronicsDelayNs.toFixed(1)} ns`);
    setText("lbl-ramp", `${Math.round(config.timsRampFraction * 100)}%`);
    setText("lbl-gas", `${config.timsGasVelocity} m/s`);
    setText("lbl-ramp-start", `${config.timsRampStartVPerCm} V/cm`);
    setText("lbl-ramp-end", `${config.timsRampEndVPerCm} V/cm`);
    setText("lbl-ramp-time", `${config.timsRampMs} ms`);
    setText("lbl-packet", `${config.timsPacketWidthMs.toFixed(2)} ms`);

    const sliders = {
        "slider-accel": config.accelVoltageKv,
        "slider-pusher-field": config.pusherFieldVPerMm,
        "slider-pusher-gap": config.pusherGapMm,
        "slider-accel-gap": config.accelGapMm,
        "slider-pusher-length": config.pusherLengthMm,
        "slider-push-frequency": config.pushFrequencyKhz,
        "slider-drift": config.driftLengthMm,
        "slider-aperture": config.apertureHalfHeightMm,
        "slider-stage1": config.mirrorStage1Mm,
        "slider-stage2": config.mirrorStage2Mm,
        "slider-mirror-height": config.mirrorHalfHeightMm,
        "slider-mirror-stage1": config.mirrorStage1Fraction,
        "slider-mirror-back": config.mirrorBackFraction,
        "slider-beam-energy": config.beamEnergyEv,
        "slider-beam-spread": config.beamEnergySpreadEv,
        "slider-beam-thickness": config.beamThicknessMm,
        "slider-beam-height": config.beamHeightMm,
        "slider-beam-offset": config.beamOffsetMm,
        "slider-beam-temp": config.beamTemperatureK,
        "slider-align": config.detectorAlignMz,
        "slider-detector-length": config.detectorLengthMm,
        "slider-detector-height": config.detectorHalfHeightMm,
        "slider-detector-shift": config.detectorShiftMm,
        "slider-exaggeration": config.transverseExaggeration,
        "slider-density": config.liveBeamDensity,
        "slider-opacity": config.electrodeOpacity,
        "slider-ions-species": config.ionsPerSpecies,
        "slider-bin": config.binWidthPs,
        "slider-response": config.singleIonResponseNs,
        "slider-ions-push": config.ionsPerPush,
        "slider-transients": config.transientCount,
        "slider-saturation": config.saturationPerTransient,
        "slider-delay": config.electronicsDelayNs,
        "slider-ramp": config.timsRampFraction,
        "slider-gas": config.timsGasVelocity,
        "slider-ramp-start": config.timsRampStartVPerCm,
        "slider-ramp-end": config.timsRampEndVPerCm,
        "slider-ramp-time": config.timsRampMs,
        "slider-packet": config.timsPacketWidthMs
    };
    for (const [id, value] of Object.entries(sliders)) {
        const node = element(id);
        if (node) node.value = value;
    }

    element("input-playback").value = config.playbackMicrosecondsPerSecond;
    element("toggle-calibration-offset").checked = config.calibrationUseOffset;
    element("toggle-tims-sync").checked = config.timsSynchronised;

    document.querySelectorAll(".seg-btn[data-mirror]").forEach((button) => {
        button.classList.toggle("active", button.dataset.mirror === config.mirrorModel);
    });
    document.querySelectorAll(".seg-btn[data-axis]").forEach((button) => {
        button.classList.toggle("active", button.dataset.axis === spectrumView.axis);
    });
    document.querySelectorAll(".seg-btn[data-focus-axis]").forEach((button) => {
        button.classList.toggle("active", button.dataset.focusAxis === analysis.focusAxis);
    });

    element("btn-toggle-field").setAttribute("aria-pressed", String(config.showField));
    element("btn-toggle-field").classList.toggle("btn-primary", config.showField);
    element("electric-field-legend").hidden = !config.showField;
    element("btn-toggle-trails").setAttribute("aria-pressed", String(config.showTrails));
    element("btn-toggle-trails").classList.toggle("btn-primary", config.showTrails);
    element("btn-toggle-grid").classList.toggle("btn-primary", config.showGrid);
    setText("canvas-scale-note", `Transverse scale ×${config.transverseExaggeration}`);
    setText("spectrum-x-label", spectrumView.axis === "mass" ? "m/z" : "Flight time (µs)");
}

function refreshDerivedReadouts() {
    const runtime = state.runtime;
    setText("derived-energy", `${runtime.nominalEnergy.toFixed(0)} eV`);
    setText("derived-grid-voltage", `${runtime.gridVoltage.toFixed(0)} V`);
    setText("derived-period", microseconds(runtime.pushPeriod));
    setText("derived-spread",
        `${(runtime.pusherField * config.beamThicknessMm * METRES_PER_MM).toFixed(0)} eV ` +
        `(${(100 * runtime.pusherField * config.beamThicknessMm * METRES_PER_MM /
            runtime.nominalEnergy).toFixed(2)}%)`);

    const solution = runtime.mirrorSolution;
    setText("derived-solve", `${solution.nodesZ} × ${solution.nodesY} in ${solution.solveMs} ms`);
    setText("derived-leak", `${(runtime.mirrorPreLength * 1000).toFixed(0)} mm upstream`);
    setText("derived-detector", `${(runtime.detectorCentre * 1000).toFixed(1)} mm`);
    setText("derived-reference",
        `${microseconds(runtime.reference.flightTimeSeconds)} at m/z ${runtime.reference.mz}`);

    setText("stat-accel", `${runtime.accelVoltage.toFixed(0)} V`);
    setText("stat-mirror",
        `${runtime.mirrorStage1Voltage.toFixed(0)} / ${runtime.mirrorBackVoltage.toFixed(0)} V`);
    setText("stat-flight", microseconds(runtime.reference.flightTimeSeconds));

    const field = rampFieldAt(config.timsRampFraction, config);
    setText("tims-field", `${field.toFixed(1)} V/cm`);
    const eluting = config.timsGasVelocity > 0 && field > 0
        ? (config.timsGasVelocity / (field / 100)) : null;
    setText("tims-eluting", eluting === null ? "—" : elutingMobilityLabel(field));
    const packetMicroseconds = config.timsPacketWidthMs * 1000;
    const periodMicroseconds = state.runtime.pushPeriod * 1e6;
    setText("tims-sync-note", !config.timsSynchronised
        ? "Free running. The mobility ramp changes how many ions arrive, not how they fly, so the pusher duty cycle is exactly what it was."
        : packetMicroseconds >= periodMicroseconds
            ? `Synchronised, but the mobility peak lasts ${packetMicroseconds.toFixed(0)} µs and the ` +
            `pusher fires every ${periodMicroseconds.toFixed(0)} µs. The release is already longer than ` +
            `the push period, so there is nothing to gain: the duty cycle is unchanged.`
            : `Synchronised. The release lasts ${packetMicroseconds.toFixed(1)} µs instead of the full ` +
            `${periodMicroseconds.toFixed(0)} µs push period, so the pusher fills from a shorter window ` +
            `and the duty cycle rises accordingly.`);
}

// The 1/K0 whose elution field matches the ramp right now.
function elutingMobilityLabel(fieldVPerCm) {
    let closest = null;
    let bestDistance = Infinity;
    for (const species of state.species) {
        const distance = Math.abs(elutionField(species.oneOverK0, config.timsGasVelocity) - fieldVPerCm);
        if (distance < bestDistance) {
            bestDistance = distance;
            closest = species;
        }
    }
    if (!closest) return "—";
    const target = elutionField(closest.oneOverK0, config.timsGasVelocity);
    return `${closest.oneOverK0.toFixed(3)} at ${target.toFixed(1)} V/cm`;
}

function refreshStats() {
    const finished = state.detectedCount + state.lostCount;
    setText("stat-counts", `${state.detectedCount} / ${state.lostCount}`);
    const duty = state.arrivedBeforeLastPush > 0
        ? (100 * state.capturedAtLastPush) / state.arrivedBeforeLastPush
        : null;
    setText("stat-duty", duty === null
        ? `waiting (${finished} finished)`
        : `${duty.toFixed(0)}% of the beam`);
}

function refreshSpeciesPanels() {
    const legend = element("species-legend");
    legend.innerHTML = "";
    for (const species of state.species) {
        const fill = fillState(species.mz, config, state.runtime);
        const velocity = beamVelocity(species.mz, config.beamEnergyEv);
        const row = document.createElement("div");
        row.className = "species-row";
        row.innerHTML =
            `<span class="species-dot" style="background:${species.color}"></span>` +
            `<span class="species-name">${species.label} &middot; m/z ${species.mz}</span>` +
            `<span class="species-metric">${(velocity).toFixed(0)} m/s &nbsp; ` +
            `${microseconds(expectedFlightTime(species.mz, state.runtime))}</span>` +
            `<span class="species-verdict ${fill.dutyCycle > 0.2 ? "pass" : "block"}">` +
            `${(fill.dutyCycle * 100).toFixed(0)}% duty</span>`;
        legend.appendChild(row);
    }

    const mobility = element("mobility-legend");
    mobility.innerHTML = "";
    for (const species of state.species) {
        const status = elutionStatus(species.oneOverK0, config);
        const fraction = elutionFraction(species.oneOverK0, config);
        const presence = speciesPresence(species);
        const row = document.createElement("div");
        row.className = "species-row";
        row.innerHTML =
            `<span class="species-dot" style="background:${species.color}"></span>` +
            `<span class="species-name">${species.label} &middot; 1/K&#8320; ${species.oneOverK0.toFixed(3)}</span>` +
            `<span class="species-metric">${elutionField(species.oneOverK0, config.timsGasVelocity).toFixed(1)} V/cm` +
            `${fraction === null ? "" : ` &nbsp; at ${(fraction * 100).toFixed(0)}%`}</span>` +
            `<span class="species-verdict ${status === "eluted" ? "pass" : "block"}">` +
            `${status === "eluted" ? `${Math.round((presence / Math.max(1, species.abundance)) * 100)}% now` : status}</span>`;
        mobility.appendChild(row);
    }

    const editor = element("species-editor");
    editor.innerHTML = "";
    if (customSpecies.length === 0) {
        editor.innerHTML = `<div class="peak-empty">Add ions to build a custom mixture, ` +
            `or pick a preset from the Sample menu.</div>`;
        return;
    }
    customSpecies.forEach((species, index) => {
        const row = document.createElement("div");
        row.className = "species-row";
        row.innerHTML =
            `<span class="species-name">${species.label} &middot; m/z ${species.mz}</span>` +
            `<span class="species-metric">1/K&#8320; ${species.oneOverK0.toFixed(2)} &nbsp; ` +
            `abundance ${species.abundance}</span>`;
        const remove = document.createElement("button");
        remove.className = "species-remove";
        remove.type = "button";
        remove.innerText = "Remove";
        remove.addEventListener("click", () => {
            customSpecies.splice(index, 1);
            if (customSpecies.length === 0) {
                applySample("peptides");
                element("select-sample").value = "peptides";
            } else {
                setCustomSpecies(customSpecies);
            }
            refreshEverything();
        });
        row.appendChild(remove);
        editor.appendChild(row);
    });
}

function refreshSampleSummary() {
    const names = state.species.map((species) => `${species.label} (m/z ${species.mz})`);
    setText("injection-summary", `${state.species.length} species • ${names.join(" • ")}`);
}

function refreshPeakTable() {
    const table = element("peak-table");
    table.innerHTML = "";
    if (acquisition.peaks.length === 0) {
        table.innerHTML = `<div class="peak-empty">No peaks detected yet.</div>`;
        return;
    }
    const header = document.createElement("div");
    header.className = "peak-row head";
    header.innerHTML = `<span>Time / m/z</span><span>FWHM (ns)</span><span>R = m/&Delta;m</span><span>Rel.</span>`;
    table.appendChild(header);
    for (const peak of acquisition.peaks) {
        const mass = massFromTime(peak.centreTime, acquisition.calibration);
        const row = document.createElement("div");
        row.className = "peak-row";
        row.innerHTML =
            `<span>${(peak.centreTime / SECONDS_PER_MICROSECOND).toFixed(4)}` +
            `${mass === null ? "" : ` / ${mass.toFixed(3)}`}</span>` +
            `<span>${(peak.widthSeconds / SECONDS_PER_NANOSECOND).toFixed(3)}</span>` +
            `<span>${peak.resolution === null ? "—" : Math.round(peak.resolution)}</span>` +
            `<span>${Math.round(peak.relativeIntensity * 100)}%</span>`;
        table.appendChild(row);
    }
}

function refreshCalibrationPanel() {
    const calibration = acquisition.calibration;
    const table = element("calibration-table");
    table.innerHTML = "";
    if (!calibration) {
        setText("cal-slope", "—");
        setText("cal-intercept", "—");
        setText("cal-count", "—");
        setText("cal-worst", "—");
        setText("calibration-note", "");
        table.innerHTML = `<div class="peak-empty">Acquire a spectrum to fit the mass scale.</div>`;
        return;
    }
    setText("cal-slope", `${(calibration.slope / SECONDS_PER_NANOSECOND).toFixed(3)} ns`);
    setText("cal-intercept", `${(calibration.intercept / SECONDS_PER_NANOSECOND).toFixed(3)} ns`);
    setText("cal-count", calibration.pairs.length.toString());
    setText("cal-worst", `${calibration.worstPpm.toFixed(2)} ppm`);
    setText("calibration-note", calibration.usedOffset ? "two-term fit" : "one-term fit");

    const header = document.createElement("div");
    header.className = "peak-row head";
    header.innerHTML = `<span>Species</span><span>True m/z</span><span>Measured</span><span>Error</span>`;
    table.appendChild(header);
    for (const pair of [...calibration.pairs].sort((a, b) => a.mz - b.mz)) {
        const row = document.createElement("div");
        row.className = "peak-row";
        row.innerHTML =
            `<span>${pair.label}</span>` +
            `<span>${pair.mz.toFixed(4)}</span>` +
            `<span>${pair.measuredMz === null ? "—" : pair.measuredMz.toFixed(4)}</span>` +
            `<span style="color:${Math.abs(pair.errorPpm) > 10 ? "var(--accent-red)" : "var(--accent-green)"}">` +
            `${pair.errorPpm.toFixed(2)} ppm</span>`;
        table.appendChild(row);
    }
}

function refreshAnalysisPanels() {
    const budget = analysis.budget;
    if (budget) {
        setText("budget-fwhm", budget.fwhmNs === null ? "—" : `${budget.fwhmNs.toFixed(3)} ns`);
        setText("budget-resolution", budget.resolution === null
            ? "—" : Math.round(budget.resolution).toString());
        setText("budget-quadrature", `${budget.quadratureSigmaNs.toFixed(3)} ns`);
        setText("budget-lost", `${budget.lost} of ${budget.lost + budget.detected}`);
        setText("budget-shape", budget.tailFactor === null
            ? "—" : `${budget.tailFactor.toFixed(2)} × Gaussian`);
        setText("budget-note", `at m/z ${budget.mz}`);
    }
    if (analysis.focus) {
        const spread = analysis.focus.points
            .map((point) => point.deltaNs)
            .filter((value) => value !== null);
        const span = spread.length > 1 ? Math.max(...spread) - Math.min(...spread) : 0;
        setText("focus-summary",
            `${analysis.focus.label}: ${span.toFixed(span < 1 ? 4 : 2)} ns across the probe range`);
        setText("focus-x-label", analysis.focus.unit === "sigma"
            ? "Offset (thermal sigma)" : "Offset (mm)");
    }
    if (analysis.tune) {
        const values = analysis.tune.points
            .map((point) => point.spreadNs)
            .filter((value) => value !== null && value > 0);
        setText("tune-note", values.length > 0
            ? `best on this scan ${Math.min(...values).toFixed(4)} ns` : "");
    }
}

export function refreshEverything() {
    refreshModeVisibility();
    refreshControlLabels();
    refreshDerivedReadouts();
    refreshSpeciesPanels();
    refreshSampleSummary();
    refreshPeakTable();
    refreshCalibrationPanel();
    refreshAnalysisPanels();
    refreshStats();
    drawActiveTabPlots();
    invalidateRender();
}

function activeTabId() {
    return document.querySelector(".tab-content.active")?.id;
}

function drawActiveTabPlots() {
    switch (activeTabId()) {
        case "tab-spectrum": drawSpectrum(); break;
        case "tab-calibrate": drawCalibration(); break;
        case "tab-focus": drawFocus(); drawTune(); break;
        case "tab-budget": drawBudget(); break;
        case "tab-mobility": drawMobility(); break;
        default: break;
    }
}

function updateConfig(patch, { resetLiveBeam = false } = {}) {
    Object.assign(config, patch);
    rebuildRuntime();
    if (resetLiveBeam) resetBeam();
    refreshEverything();
}

function bindSlider(id, key, { parse = parseFloat, resetLiveBeam = false } = {}) {
    const node = element(id);
    if (!node) return;
    node.addEventListener("input", (event) => {
        updateConfig({ [key]: parse(event.target.value) }, { resetLiveBeam });
    });
}

// Mirror dimensions trigger a fresh Laplace solve, so they are applied when the
// user lets go of the slider rather than on every pixel of a drag.
function bindGeometrySlider(id, key, labelId, format, { parse = parseFloat } = {}) {
    const node = element(id);
    if (!node) return;
    node.addEventListener("input", (event) => {
        setText(labelId, format(parse(event.target.value)));
    });
    node.addEventListener("change", (event) => {
        updateConfig({ [key]: parse(event.target.value) }, { resetLiveBeam: true });
    });
}

// Detector settings only re-bin ions that have already been flown.
function bindDetectorSlider(id, key, { parse = parseFloat } = {}) {
    const node = element(id);
    if (!node) return;
    node.addEventListener("input", (event) => {
        config[key] = parse(event.target.value);
        if (acquisition.completed) rebuildSpectrum();
        refreshControlLabels();
        refreshPeakTable();
        refreshCalibrationPanel();
        drawActiveTabPlots();
    });
}

function setupTabs() {
    const tabs = document.querySelectorAll(".tab-btn");
    const contents = document.querySelectorAll(".tab-content");
    tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
            tabs.forEach((other) => other.classList.remove("active"));
            contents.forEach((content) => content.classList.remove("active"));
            tab.classList.add("active");
            element(tab.dataset.tab).classList.add("active");
            resizePlots();
            drawActiveTabPlots();
        });
    });
}

function selectTab(tabId) {
    const tab = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    if (tab) tab.click();
}

function setupPlayback() {
    const playButton = element("btn-play");
    playButton.addEventListener("click", () => {
        state.isPlaying = !state.isPlaying;
        playButton.innerText = state.isPlaying ? "Pause" : "Play";
        playButton.classList.toggle("btn-primary", state.isPlaying);
        invalidateRender();
    });

    element("btn-step").addEventListener("click", () => {
        if (state.isPlaying) return;
        advanceFrame();
        refreshStats();
        invalidateRender();
    });

    element("btn-reset").addEventListener("click", () => {
        resetBeam();
        refreshEverything();
    });

    const playbackInput = element("input-playback");
    playbackInput.addEventListener("input", () => {
        const value = Number(playbackInput.value);
        if (Number.isFinite(value) && value > 0) {
            config.playbackMicrosecondsPerSecond = value;
            playbackInput.setCustomValidity("");
        } else {
            playbackInput.setCustomValidity("Enter a playback rate greater than 0.");
        }
    });
}

function setupModeSwitch() {
    document.querySelectorAll(".mode-btn").forEach((button) => {
        button.addEventListener("click", () => {
            updateConfig({ mode: button.dataset.mode }, { resetLiveBeam: true });
        });
    });
}

function setupSampleSelect() {
    const select = element("select-sample");
    for (const [key, mixture] of Object.entries(SAMPLE_MIXTURES)) {
        const option = document.createElement("option");
        option.value = key;
        option.innerText = mixture.label;
        select.appendChild(option);
    }
    select.value = state.sampleKey;
    select.addEventListener("change", () => {
        applySample(select.value);
        analysisMz = analysisMassToCharge();
        refreshEverything();
    });
}

function setupAcquisition() {
    const acquireButton = element("btn-acquire");
    const stopButton = element("btn-acquire-stop");

    acquireButton.addEventListener("click", () => {
        startAcquisition();
        acquireButton.disabled = true;
        stopButton.disabled = false;
        refreshPeakTable();
    });
    stopButton.addEventListener("click", () => {
        stopAcquisition();
        acquireButton.disabled = false;
        stopButton.disabled = true;
    });

    element("slider-ions-species").addEventListener("input", (event) => {
        config.ionsPerSpecies = parseInt(event.target.value, 10);
        refreshControlLabels();
    });

    document.querySelectorAll(".seg-btn[data-axis]").forEach((button) => {
        button.addEventListener("click", () => {
            spectrumView.axis = button.dataset.axis;
            refreshControlLabels();
            drawActiveTabPlots();
        });
    });

    element("btn-zoom-reset").addEventListener("click", () => {
        spectrumView.zoom = null;
        drawActiveTabPlots();
    });
    element("btn-zoom-peak").addEventListener("click", () => {
        const peak = acquisition.peaks[0];
        if (!peak) return;
        const half = Math.max(peak.widthSeconds * 6, 4e-9);
        spectrumView.zoom = { from: peak.centreTime - half, to: peak.centreTime + half };
        drawActiveTabPlots();
    });

    const canvas = element("canvas-spectrum");
    let dragStart = null;
    canvas.addEventListener("mousedown", (event) => {
        const bounds = canvas.getBoundingClientRect();
        dragStart = spectrumCanvasToTime(event.clientX - bounds.left);
    });
    canvas.addEventListener("mouseup", (event) => {
        if (dragStart === null) return;
        const bounds = canvas.getBoundingClientRect();
        const dragEnd = spectrumCanvasToTime(event.clientX - bounds.left);
        dragStart = (() => {
            if (dragEnd !== null && Math.abs(dragEnd - dragStart) > 1e-10) {
                spectrumView.zoom = {
                    from: Math.min(dragStart, dragEnd),
                    to: Math.max(dragStart, dragEnd)
                };
                drawActiveTabPlots();
            }
            return null;
        })();
    });
}

function setupDetectorControls() {
    bindDetectorSlider("slider-bin", "binWidthPs", { parse: (value) => parseInt(value, 10) });
    bindDetectorSlider("slider-response", "singleIonResponseNs");
    bindDetectorSlider("slider-ions-push", "ionsPerPush", { parse: (value) => parseInt(value, 10) });
    bindDetectorSlider("slider-transients", "transientCount", { parse: (value) => parseInt(value, 10) });
    bindDetectorSlider("slider-saturation", "saturationPerTransient");
    bindDetectorSlider("slider-delay", "electronicsDelayNs");
    element("toggle-calibration-offset").addEventListener("change", (event) => {
        config.calibrationUseOffset = event.target.checked;
        if (acquisition.completed) rebuildSpectrum();
        refreshEverything();
    });
}

// Analyses that take longer than a frame are started after the label has been
// painted, so the interface never appears to have ignored the click.
function runDeferred(labelId, message, task) {
    setText(labelId, message);
    setTimeout(() => {
        task();
        refreshEverything();
    }, DEFERRED_TASK_DELAY_MS);
}

function setupFocusControls() {
    document.querySelectorAll(".seg-btn[data-focus-axis]").forEach((button) => {
        button.addEventListener("click", () => {
            analysis.focusAxis = button.dataset.focusAxis;
            refreshControlLabels();
            measureFocus();
        });
    });

    element("btn-measure-focus").addEventListener("click", measureFocus);

    element("btn-scan-tune").addEventListener("click", () => {
        runDeferred("tune-progress", "Scanning the mirror tune…", () => {
            analysis.tune = mirrorTuneCurve(analysisMz, config);
            setText("tune-progress", "Scan complete");
        });
    });

    element("btn-auto-tune").addEventListener("click", () => {
        analysis.tuner = createMirrorTuner(analysisMz, config);
        setText("tune-progress", "Searching both mirror voltages…");
        element("btn-auto-tune").disabled = true;
    });

    bindSlider("slider-mirror-stage1", "mirrorStage1Fraction");
    bindSlider("slider-mirror-back", "mirrorBackFraction");
}

function measureFocus() {
    analysis.focus = focusCurve(analysisMz, config, state.runtime, analysis.focusAxis);
    refreshEverything();
}

function setupBudgetControls() {
    element("btn-measure-budget").addEventListener("click", () => {
        runDeferred("budget-note", "Measuring…", () => {
            analysis.budget = resolutionBudget(analysisMz, config, BUDGET_ION_COUNT);
        });
    });
}

function setupMobilityControls() {
    bindSlider("slider-ramp", "timsRampFraction", { resetLiveBeam: true });
    bindSlider("slider-gas", "timsGasVelocity");
    bindSlider("slider-ramp-start", "timsRampStartVPerCm");
    bindSlider("slider-ramp-end", "timsRampEndVPerCm");
    bindSlider("slider-ramp-time", "timsRampMs");
    bindSlider("slider-packet", "timsPacketWidthMs");
    element("toggle-tims-sync").addEventListener("change", (event) => {
        updateConfig({ timsSynchronised: event.target.checked });
    });
}

function setupSetupControls() {
    bindSlider("slider-accel", "accelVoltageKv", { resetLiveBeam: true });
    bindSlider("slider-pusher-field", "pusherFieldVPerMm", { resetLiveBeam: true });
    bindSlider("slider-pusher-gap", "pusherGapMm", { resetLiveBeam: true });
    bindSlider("slider-accel-gap", "accelGapMm", { resetLiveBeam: true });
    bindSlider("slider-pusher-length", "pusherLengthMm", { resetLiveBeam: true });
    bindSlider("slider-push-frequency", "pushFrequencyKhz", { resetLiveBeam: true });
    bindSlider("slider-drift", "driftLengthMm", { resetLiveBeam: true });
    bindSlider("slider-aperture", "apertureHalfHeightMm", { resetLiveBeam: true });
    bindSlider("slider-beam-energy", "beamEnergyEv", { resetLiveBeam: true });
    bindSlider("slider-beam-spread", "beamEnergySpreadEv");
    bindSlider("slider-beam-thickness", "beamThicknessMm");
    bindSlider("slider-beam-height", "beamHeightMm");
    bindSlider("slider-beam-offset", "beamOffsetMm", { resetLiveBeam: true });
    bindSlider("slider-beam-temp", "beamTemperatureK", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-align", "detectorAlignMz", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-detector-length", "detectorLengthMm", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-detector-height", "detectorHalfHeightMm", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-detector-shift", "detectorShiftMm", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-exaggeration", "transverseExaggeration");
    bindSlider("slider-density", "liveBeamDensity", { parse: (value) => parseInt(value, 10) });
    bindSlider("slider-opacity", "electrodeOpacity", { parse: (value) => parseInt(value, 10) });

    bindGeometrySlider("slider-stage1", "mirrorStage1Mm", "lbl-stage1",
        (value) => `${value} mm`, { parse: (value) => parseInt(value, 10) });
    bindGeometrySlider("slider-stage2", "mirrorStage2Mm", "lbl-stage2",
        (value) => `${value} mm`, { parse: (value) => parseInt(value, 10) });
    bindGeometrySlider("slider-mirror-height", "mirrorHalfHeightMm", "lbl-mirror-height",
        (value) => `${value} mm`, { parse: (value) => parseInt(value, 10) });

    document.querySelectorAll(".seg-btn[data-mirror]").forEach((button) => {
        button.addEventListener("click", () => {
            updateConfig({ mirrorModel: button.dataset.mirror }, { resetLiveBeam: true });
        });
    });
}

function setupViewControls() {
    element("btn-camera-reset").addEventListener("click", () => {
        if (p5Instance) p5Instance.camera();
        Object.assign(view, DEFAULT_VIEW);
        invalidateRender();
    });
    element("btn-view-plan").addEventListener("click", () => {
        if (p5Instance) p5Instance.camera();
        Object.assign(view, PLAN_VIEW);
        invalidateRender();
    });
    element("btn-view-side").addEventListener("click", () => {
        if (p5Instance) p5Instance.camera();
        Object.assign(view, SIDE_VIEW);
        invalidateRender();
    });
    element("btn-toggle-grid").addEventListener("click", () => {
        updateConfig({ showGrid: !config.showGrid });
    });
    element("btn-toggle-field").addEventListener("click", () => {
        updateConfig({ showField: !config.showField });
    });
    element("btn-toggle-trails").addEventListener("click", () => {
        updateConfig({ showTrails: !config.showTrails });
    });
}

function setupCustomMixture() {
    element("btn-add-species").addEventListener("click", () => {
        const mz = parseFloat(element("input-add-mz").value);
        const abundance = parseFloat(element("input-add-abundance").value);
        const oneOverK0 = parseFloat(element("input-add-k0").value);
        if (!Number.isFinite(mz) || mz <= 0) return;
        customSpecies.push({
            mz,
            abundance: Number.isFinite(abundance) && abundance > 0 ? abundance : 100,
            oneOverK0: Number.isFinite(oneOverK0) && oneOverK0 > 0 ? oneOverK0 : 0.9,
            label: element("input-add-label").value.trim() || `m/z ${mz}`
        });
        setCustomSpecies(customSpecies);
        element("select-sample").value = "";
        element("input-add-label").value = "";
        analysisMz = analysisMassToCharge();
        refreshEverything();
    });

    element("btn-clear-species").addEventListener("click", () => {
        customSpecies = [];
        applySample("peptides");
        element("select-sample").value = "peptides";
        analysisMz = analysisMassToCharge();
        refreshEverything();
    });
}

function buildTourApi() {
    return {
        setConfig: (patch) => updateConfig(patch),
        setMode: (mode) => updateConfig({ mode }, { resetLiveBeam: true }),
        setSample: (key) => {
            applySample(key);
            element("select-sample").value = key;
            analysisMz = analysisMassToCharge();
            refreshEverything();
        },
        setTab: selectTab,
        setFocusAxis: (axis) => {
            analysis.focusAxis = axis;
            refreshControlLabels();
        },
        measureFocus,
        measureBudget: () => {
            analysis.budget = resolutionBudget(analysisMz, config, BUDGET_ION_COUNT);
            refreshEverything();
        },
        autoTune: () => {
            analysis.tuner = createMirrorTuner(analysisMz, config);
            setText("tune-progress", "Searching both mirror voltages…");
            element("btn-auto-tune").disabled = true;
        },
        acquire: () => element("btn-acquire").click(),
        rebuild: () => {
            if (acquisition.completed) rebuildSpectrum();
            refreshEverything();
        }
    };
}

function advanceTuner() {
    const tuner = analysis.tuner;
    if (!tuner) return;
    tuner.advance(TUNE_BUDGET_MS);
    setText("tune-progress",
        `Auto-tuning • ${tuner.completed}/${tuner.total} probes` +
        `${tuner.best ? ` • best ${tuner.best.spreadNs.toFixed(4)} ns` : ""}`);
    if (!tuner.done) return;

    analysis.tuner = null;
    element("btn-auto-tune").disabled = false;
    if (!tuner.best) {
        setText("tune-progress", "No tune found in range");
        return;
    }
    setText("tune-progress",
        `Applied • residual ${tuner.best.spreadNs.toFixed(4)} ns across the beam`);
    updateConfig({
        mirrorStage1Fraction: tuner.best.stage1Fraction,
        mirrorBackFraction: tuner.best.backFraction
    });
    measureFocus();
}

function startPresentationLoop() {
    setInterval(() => {
        if (acquisition.running) {
            advanceAcquisition(ACQUIRE_BUDGET_MS);
            setText("acquire-progress",
                `Flying ions • ${Math.round(acquisitionProgress() * 100)}% • ` +
                `${acquisition.flightsFlown} flights`);
            if (activeTabId() === "tab-spectrum") drawSpectrum();
            if (!acquisition.running) {
                element("btn-acquire").disabled = false;
                element("btn-acquire-stop").disabled = true;
                setText("acquire-progress",
                    `Complete • ${acquisition.flightsFlown} flights in ` +
                    `${(acquisition.durationMs / 1000).toFixed(1)} s`);
                refreshEverything();
            }
        }

        if (analysis.tuner) advanceTuner();

        if (document.hidden) return;
        drawPushDial();
        refreshStats();
        if (!state.isPlaying) return;
        if (activeTabId() === "tab-spectrum" && !acquisition.running) return;
    }, PRESENTATION_INTERVAL_MS);
}

export function setupUI(instance) {
    p5Instance = instance;
    analysisMz = analysisMassToCharge();

    setupTabs();
    setupPlayback();
    setupModeSwitch();
    setupSampleSelect();
    setupAcquisition();
    setupDetectorControls();
    setupFocusControls();
    setupBudgetControls();
    setupMobilityControls();
    setupSetupControls();
    setupViewControls();
    setupCustomMixture();
    initPlots();

    const tour = createTourController(buildTourApi());
    element("btn-tour").addEventListener("click", tour.open);

    refreshEverything();
    startPresentationLoop();
}
