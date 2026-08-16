// Two-dimensional diagnostic plots: the flown spectrum, the mass calibration
// residuals, the focus curves, the mirror tune curve, the resolution budget, the
// mobility map and the pusher cycle indicator.

import {
    PLOT_BACKGROUND,
    PLOT_AXIS,
    PLOT_GRID,
    PLOT_TEXT_DIM,
    COLOR_SIGNAL,
    COLOR_MIRROR,
    COLOR_PUSHER,
    COLOR_DETECTOR,
    COLOR_WARNING,
    SECONDS_PER_MICROSECOND,
    SECONDS_PER_NANOSECOND
} from "./constants.js";
import { config, state, analysis } from "./state.js";
import { acquisition, spectrumProfile, massFromTime, timeFromMass } from "./acquire.js";
import { elutionFraction } from "./tims.js";
import { expectedFlightTime } from "./physics.js";

const CANVAS_IDS = [
    "canvas-spectrum", "canvas-calibration", "canvas-focus",
    "canvas-tune", "canvas-budget", "canvas-mobility"
];

const canvases = {};

export function initPlots() {
    for (const id of [...CANVAS_IDS, "canvas-push-dial"]) {
        const element = document.getElementById(id);
        if (element) canvases[id] = { element, context: element.getContext("2d") };
    }
    resizePlots();
    window.addEventListener("resize", resizePlots);
}

export function resizePlots() {
    const ratio = window.devicePixelRatio || 1;
    for (const id of CANVAS_IDS) {
        const entry = canvases[id];
        if (!entry) continue;
        const bounds = entry.element.parentElement.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) continue;
        entry.element.width = bounds.width * ratio;
        entry.element.height = bounds.height * ratio;
        entry.element.style.width = `${bounds.width}px`;
        entry.element.style.height = `${bounds.height}px`;
        entry.context.resetTransform();
        entry.context.scale(ratio, ratio);
        entry.cssWidth = bounds.width;
        entry.cssHeight = bounds.height;
    }
}

function beginPlot(id) {
    const entry = canvases[id];
    if (!entry) return null;
    const width = entry.cssWidth ?? entry.element.width;
    const height = entry.cssHeight ?? entry.element.height;
    const context = entry.context;
    context.fillStyle = PLOT_BACKGROUND;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = PLOT_GRID;
    context.lineWidth = 1;
    for (let x = 44; x < width; x += 52) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
    }
    for (let y = 26; y < height; y += 38) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
    }
    return { context, width, height };
}

function drawFrame(context, padX, padY, plotWidth, plotHeight) {
    context.strokeStyle = PLOT_AXIS;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(padX, padY);
    context.lineTo(padX, padY + plotHeight);
    context.lineTo(padX + plotWidth, padY + plotHeight);
    context.stroke();
}

function niceTickStep(span, targetCount) {
    const rough = span / targetCount;
    const power = Math.pow(10, Math.floor(Math.log10(Math.abs(rough) || 1)));
    const scaled = rough / power;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * power;
}

function drawAxisTicks(context, min, max, padX, padY, plotWidth, plotHeight) {
    const step = niceTickStep(max - min, 5);
    if (!Number.isFinite(step) || step <= 0) return;
    const decimals = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
    context.fillStyle = PLOT_TEXT_DIM;
    context.strokeStyle = PLOT_AXIS;
    context.lineWidth = 1;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "center";
    for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) {
        const x = padX + ((value - min) / (max - min)) * plotWidth;
        context.fillText(value.toFixed(decimals), x, padY + plotHeight + 13);
        context.beginPath();
        context.moveTo(x, padY + plotHeight);
        context.lineTo(x, padY + plotHeight + 4);
        context.stroke();
    }
}

function placeholder(context, text, padX, padY, plotWidth, plotHeight) {
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "11px 'Inter', sans-serif";
    context.textAlign = "center";
    context.fillText(text, padX + plotWidth / 2, padY + plotHeight / 2);
}

// The spectrum can be read against flight time or against the calibrated mass
// scale; both come from the same recorded trace.
export const spectrumView = { axis: "time", zoom: null };

function spectrumWindow() {
    const spectrum = acquisition.spectrum;
    const full = {
        from: spectrum.start,
        to: spectrum.start + spectrum.binCount * spectrum.binWidth
    };
    if (!spectrumView.zoom) return full;
    return {
        from: Math.max(full.from, spectrumView.zoom.from),
        to: Math.min(full.to, spectrumView.zoom.to)
    };
}

export function drawSpectrum() {
    const plot = beginPlot("canvas-spectrum");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 48;
    const padY = 16;
    const plotWidth = width - padX - 14;
    const plotHeight = height - padY - 24;
    drawFrame(context, padX, padY, plotWidth, plotHeight);

    if (!acquisition.spectrum) {
        placeholder(context, "Press Acquire to fly ions and record a spectrum.",
            padX, padY, plotWidth, plotHeight);
        return;
    }

    const window = spectrumWindow();
    const profile = spectrumProfile(Math.max(2, Math.round(plotWidth)), window.from, window.to);
    let maximum = 0;
    for (const value of profile) maximum = Math.max(maximum, value);
    if (maximum <= 0) maximum = 1;

    const calibration = acquisition.calibration;
    const useMass = spectrumView.axis === "mass" && calibration;
    const toAxis = (time) => useMass ? massFromTime(time, calibration) : time / SECONDS_PER_MICROSECOND;
    const axisMin = toAxis(window.from);
    const axisMax = toAxis(window.to);

    // True composition drawn underneath, so the recorded peaks can be compared
    // with where the ions actually are.
    for (const species of state.species) {
        const time = expectedFlightTime(species.mz, state.runtime) +
            config.electronicsDelayNs * SECONDS_PER_NANOSECOND;
        if (time < window.from || time > window.to) continue;
        const x = padX + ((time - window.from) / (window.to - window.from)) * plotWidth;
        context.strokeStyle = "rgba(100, 116, 139, 0.4)";
        context.setLineDash([3, 3]);
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, padY);
        context.lineTo(x, padY + plotHeight);
        context.stroke();
        context.setLineDash([]);
    }

    context.beginPath();
    context.moveTo(padX, padY + plotHeight);
    for (let pixel = 0; pixel < profile.length; pixel++) {
        const x = padX + pixel;
        const y = padY + plotHeight - (profile[pixel] / maximum) * (plotHeight - 10);
        context.lineTo(x, y);
    }
    context.lineTo(padX + profile.length, padY + plotHeight);
    context.closePath();
    context.fillStyle = "rgba(23, 105, 170, 0.18)";
    context.fill();
    context.strokeStyle = COLOR_SIGNAL;
    context.lineWidth = 1.4;
    context.stroke();

    context.fillStyle = "#765000";
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "center";
    for (const peak of acquisition.peaks.slice(0, 8)) {
        if (peak.centreTime < window.from || peak.centreTime > window.to) continue;
        const x = padX + ((peak.centreTime - window.from) / (window.to - window.from)) * plotWidth;
        const y = padY + plotHeight - (peak.intensity / maximum) * (plotHeight - 10);
        const label = useMass
            ? massFromTime(peak.centreTime, calibration).toFixed(3)
            : (peak.centreTime / SECONDS_PER_MICROSECOND).toFixed(3);
        context.fillText(label, x, Math.max(padY + 9, y - 5));
    }

    drawAxisTicks(context, axisMin, axisMax, padX, padY, plotWidth, plotHeight);
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "right";
    context.fillText(Math.round(maximum).toString(), padX - 5, padY + 9);
    context.fillText("0", padX - 5, padY + plotHeight - 1);
}

export function drawCalibration() {
    const plot = beginPlot("canvas-calibration");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 48;
    const padY = 16;
    const plotWidth = width - padX - 14;
    const plotHeight = height - padY - 24;
    drawFrame(context, padX, padY, plotWidth, plotHeight);

    const calibration = acquisition.calibration;
    if (!calibration || calibration.pairs.length === 0) {
        placeholder(context, "Acquire a spectrum with at least two known species.",
            padX, padY, plotWidth, plotHeight);
        return;
    }

    const masses = calibration.pairs.map((pair) => pair.mz);
    const minMz = Math.min(...masses) * 0.92;
    const maxMz = Math.max(...masses) * 1.08;
    const worst = Math.max(1, calibration.worstPpm * 1.3);

    const toX = (mz) => padX + ((mz - minMz) / (maxMz - minMz)) * plotWidth;
    const toY = (ppm) => padY + plotHeight / 2 - (ppm / worst) * (plotHeight / 2 - 8);

    context.strokeStyle = "rgba(40, 122, 69, 0.7)";
    context.setLineDash([4, 4]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padX, toY(0));
    context.lineTo(padX + plotWidth, toY(0));
    context.stroke();
    context.setLineDash([]);

    context.strokeStyle = COLOR_SIGNAL;
    context.lineWidth = 1.4;
    context.beginPath();
    [...calibration.pairs].sort((a, b) => a.mz - b.mz).forEach((pair, index) => {
        const x = toX(pair.mz);
        const y = toY(pair.errorPpm ?? 0);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    });
    context.stroke();

    for (const pair of calibration.pairs) {
        context.fillStyle = Math.abs(pair.errorPpm ?? 0) > 10 ? COLOR_WARNING : COLOR_DETECTOR;
        context.beginPath();
        context.arc(toX(pair.mz), toY(pair.errorPpm ?? 0), 4, 0, 2 * Math.PI);
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 1.2;
        context.stroke();
    }

    drawAxisTicks(context, minMz, maxMz, padX, padY, plotWidth, plotHeight);
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "right";
    context.fillText(`+${worst.toFixed(1)}`, padX - 5, padY + 9);
    context.fillText("0", padX - 5, toY(0) + 3);
    context.fillText(`-${worst.toFixed(1)}`, padX - 5, padY + plotHeight - 1);
}

export function drawFocus() {
    const plot = beginPlot("canvas-focus");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 52;
    const padY = 16;
    const plotWidth = width - padX - 14;
    const plotHeight = height - padY - 24;
    drawFrame(context, padX, padY, plotWidth, plotHeight);

    const curve = analysis.focus;
    if (!curve) {
        placeholder(context, "Press Measure Focus to fly a probe series.",
            padX, padY, plotWidth, plotHeight);
        return;
    }

    const values = curve.points.map((point) => point.deltaNs).filter((value) => value !== null);
    if (values.length < 2) {
        placeholder(context, "Every probe ion was lost at this setting.",
            padX, padY, plotWidth, plotHeight);
        return;
    }
    const largest = Math.max(1e-4, ...values.map(Math.abs));
    const toX = (offset) => padX + ((offset + curve.half) / (2 * curve.half)) * plotWidth;
    const toY = (delta) => padY + plotHeight / 2 - (delta / largest) * (plotHeight / 2 - 8);

    context.strokeStyle = "rgba(40, 122, 69, 0.6)";
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(padX, toY(0));
    context.lineTo(padX + plotWidth, toY(0));
    context.stroke();
    context.setLineDash([]);

    context.strokeStyle = COLOR_MIRROR;
    context.lineWidth = 1.8;
    context.beginPath();
    let started = false;
    for (const point of curve.points) {
        if (point.deltaNs === null) { started = false; continue; }
        const x = toX(point.offset);
        const y = toY(point.deltaNs);
        if (!started) { context.moveTo(x, y); started = true; }
        else context.lineTo(x, y);
    }
    context.stroke();

    drawAxisTicks(context, -curve.half, curve.half, padX, padY, plotWidth, plotHeight);
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "right";
    context.fillText(`+${largest.toFixed(largest < 1 ? 3 : 1)}`, padX - 5, padY + 9);
    context.fillText("0", padX - 5, toY(0) + 3);
    context.fillText(`-${largest.toFixed(largest < 1 ? 3 : 1)}`, padX - 5, padY + plotHeight - 1);
}

export function drawTune() {
    const plot = beginPlot("canvas-tune");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 52;
    const padY = 16;
    const plotWidth = width - padX - 14;
    const plotHeight = height - padY - 24;
    drawFrame(context, padX, padY, plotWidth, plotHeight);

    const curve = analysis.tune;
    if (!curve) {
        placeholder(context, "Press Scan Mirror Tune to map the focus.",
            padX, padY, plotWidth, plotHeight);
        return;
    }
    const values = curve.points.map((point) => point.spreadNs).filter((value) => value !== null);
    if (values.length < 2) {
        placeholder(context, "No ion survived across this tune range.",
            padX, padY, plotWidth, plotHeight);
        return;
    }

    // The residual spans orders of magnitude at the optimum, so a log scale is
    // the only way to see how deep the minimum actually goes.
    const floor = Math.max(1e-3, Math.min(...values.filter((value) => value > 0)) * 0.5);
    const ceiling = Math.max(...values);
    const toX = (fraction) => padX +
        ((fraction - curve.points[0].fraction) /
            (curve.points[curve.points.length - 1].fraction - curve.points[0].fraction)) * plotWidth;
    const toY = (value) => {
        const clamped = Math.max(floor, value);
        return padY + plotHeight -
            ((Math.log10(clamped) - Math.log10(floor)) /
                (Math.log10(ceiling) - Math.log10(floor))) * (plotHeight - 8);
    };

    context.strokeStyle = COLOR_MIRROR;
    context.lineWidth = 1.8;
    context.beginPath();
    curve.points.forEach((point, index) => {
        if (point.spreadNs === null) return;
        const x = toX(point.fraction);
        const y = toY(point.spreadNs);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    });
    context.stroke();

    const current = toX(curve.centre);
    context.strokeStyle = COLOR_PUSHER;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(current, padY);
    context.lineTo(current, padY + plotHeight);
    context.stroke();

    drawAxisTicks(context, curve.points[0].fraction,
        curve.points[curve.points.length - 1].fraction, padX, padY, plotWidth, plotHeight);
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "right";
    context.fillText(`${ceiling.toFixed(1)} ns`, padX - 5, padY + 9);
    context.fillText(`${floor.toFixed(3)}`, padX - 5, padY + plotHeight - 1);
}

export function drawBudget() {
    const plot = beginPlot("canvas-budget");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 128;
    const padY = 14;
    const plotWidth = width - padX - 46;
    const plotHeight = height - padY - 22;

    const budget = analysis.budget;
    if (!budget) {
        placeholder(context, "Press Measure Budget to break the peak apart.",
            padX - 100, padY, plotWidth + 100, plotHeight);
        return;
    }

    const terms = [...budget.terms].sort((a, b) => b.sigmaNs - a.sigmaNs);
    const largest = Math.max(budget.totalSigmaNs, ...terms.map((term) => term.sigmaNs), 1e-4);
    const rowHeight = plotHeight / (terms.length + 1);

    context.font = "10px 'Inter', sans-serif";
    terms.forEach((term, index) => {
        const y = padY + index * rowHeight + rowHeight * 0.18;
        const barHeight = rowHeight * 0.55;
        const barWidth = Math.max(1, (term.sigmaNs / largest) * plotWidth);
        context.fillStyle = index === 0 ? COLOR_WARNING : COLOR_SIGNAL;
        context.fillRect(padX, y, barWidth, barHeight);
        context.fillStyle = PLOT_AXIS;
        context.textAlign = "right";
        context.fillText(term.label, padX - 8, y + barHeight * 0.75);
        context.textAlign = "left";
        context.fillStyle = PLOT_TEXT_DIM;
        context.fillText(`${term.sigmaNs.toFixed(3)} ns`, padX + barWidth + 5, y + barHeight * 0.75);
    });

    const totalY = padY + terms.length * rowHeight + rowHeight * 0.18;
    const totalHeight = rowHeight * 0.55;
    context.fillStyle = COLOR_DETECTOR;
    context.fillRect(padX, totalY, (budget.totalSigmaNs / largest) * plotWidth, totalHeight);
    context.fillStyle = PLOT_AXIS;
    context.textAlign = "right";
    context.fillText("Measured peak", padX - 8, totalY + totalHeight * 0.75);
    context.textAlign = "left";
    context.fillStyle = PLOT_TEXT_DIM;
    context.fillText(
        `${budget.totalSigmaNs.toFixed(3)} ns`,
        padX + (budget.totalSigmaNs / largest) * plotWidth + 5,
        totalY + totalHeight * 0.75
    );

    const quadratureX = padX + (budget.quadratureSigmaNs / largest) * plotWidth;
    context.strokeStyle = COLOR_MIRROR;
    context.setLineDash([3, 3]);
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(quadratureX, padY);
    context.lineTo(quadratureX, padY + plotHeight);
    context.stroke();
    context.setLineDash([]);
}

const MOBILITY_COLUMNS = 150;
const MOBILITY_ROWS = 96;

export function drawMobility() {
    const plot = beginPlot("canvas-mobility");
    if (!plot) return;
    const { context, width, height } = plot;
    const padX = 50;
    const padY = 14;
    const plotWidth = width - padX - 14;
    const plotHeight = height - padY - 24;
    drawFrame(context, padX, padY, plotWidth, plotHeight);

    const map = acquisition.mobilityMap;
    if (!map || map.entries.length === 0) {
        placeholder(context, "Switch to TIMS mode and acquire to build a mobility map.",
            padX, padY, plotWidth, plotHeight);
        return;
    }

    const masses = map.entries.map((entry) => entry.mz);
    const minMz = Math.min(...masses) * 0.9;
    const maxMz = Math.max(...masses) * 1.1;
    const mobilities = map.entries.map((entry) => entry.oneOverK0);
    const minK = Math.min(...mobilities) * 0.85;
    const maxK = Math.max(...mobilities) * 1.15;

    const cellWidth = plotWidth / MOBILITY_COLUMNS;
    const cellHeight = plotHeight / MOBILITY_ROWS;
    const grid = new Float64Array(MOBILITY_COLUMNS * MOBILITY_ROWS);

    // The ramp only changes how many ions of a species reach the pusher, so each
    // species contributes a mobility peak multiplied by its measured intensity.
    for (const entry of map.entries) {
        const column = Math.floor(((entry.mz - minMz) / (maxMz - minMz)) * MOBILITY_COLUMNS);
        const fraction = elutionFraction(entry.oneOverK0, config);
        if (fraction === null || fraction < 0 || fraction > 1) continue;
        const centreRow = ((entry.oneOverK0 - minK) / (maxK - minK)) * MOBILITY_ROWS;
        const widthRows = Math.max(
            1.2,
            (config.timsPacketWidthMs / config.timsRampMs) * MOBILITY_ROWS /
            Math.max(1e-6, (maxK - minK) / (config.timsRampStartVPerCm - config.timsRampEndVPerCm))
        );
        for (let row = 0; row < MOBILITY_ROWS; row++) {
            const offset = (row - centreRow) / (widthRows / 2.3548);
            const value = entry.weight * Math.exp(-0.5 * offset * offset);
            for (let spread = -1; spread <= 1; spread++) {
                const target = column + spread;
                if (target < 0 || target >= MOBILITY_COLUMNS) continue;
                grid[row * MOBILITY_COLUMNS + target] += value * (spread === 0 ? 1 : 0.45);
            }
        }
    }

    let peak = 0;
    for (const value of grid) peak = Math.max(peak, value);
    if (peak <= 0) peak = 1;

    for (let row = 0; row < MOBILITY_ROWS; row++) {
        for (let column = 0; column < MOBILITY_COLUMNS; column++) {
            const value = grid[row * MOBILITY_COLUMNS + column] / peak;
            if (value < 0.01) continue;
            const shade = Math.pow(value, 0.55);
            context.fillStyle = `rgba(23, 105, 170, ${shade.toFixed(3)})`;
            context.fillRect(
                padX + column * cellWidth,
                padY + plotHeight - (row + 1) * cellHeight,
                cellWidth + 0.5, cellHeight + 0.5
            );
        }
    }

    const rampRow = padY + plotHeight - (config.timsRampFraction * plotHeight);
    context.strokeStyle = COLOR_PUSHER;
    context.setLineDash([4, 3]);
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(padX, rampRow);
    context.lineTo(padX + plotWidth, rampRow);
    context.stroke();
    context.setLineDash([]);

    drawAxisTicks(context, minMz, maxMz, padX, padY, plotWidth, plotHeight);
    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "right";
    context.fillText(maxK.toFixed(2), padX - 5, padY + 9);
    context.fillText(minK.toFixed(2), padX - 5, padY + plotHeight - 1);
}

// A small dial showing where the pusher is in its cycle and how much of the
// continuous beam has flowed past since the last shot.
export function drawPushDial() {
    const entry = canvases["canvas-push-dial"];
    if (!entry) return;
    const context = entry.context;
    const width = entry.element.width;
    const height = entry.element.height;

    context.clearRect(0, 0, width, height);
    const runtime = state.runtime;
    const sinceLast = runtime.pushPeriod > 0
        ? ((state.clock % runtime.pushPeriod) + runtime.pushPeriod) % runtime.pushPeriod
        : 0;
    const fraction = sinceLast / runtime.pushPeriod;

    context.fillStyle = "rgba(100, 116, 139, 0.2)";
    context.fillRect(0, height / 2 - 5, width, 10);
    context.fillStyle = COLOR_PUSHER;
    context.fillRect(0, height / 2 - 5, width * fraction, 10);

    context.strokeStyle = COLOR_DETECTOR;
    context.lineWidth = 2;
    for (const mark of [0, 1]) {
        const x = mark * width;
        context.beginPath();
        context.moveTo(x === 0 ? 1 : x - 1, 2);
        context.lineTo(x === 0 ? 1 : x - 1, height - 2);
        context.stroke();
    }

    context.fillStyle = PLOT_TEXT_DIM;
    context.font = "9px 'Inter', sans-serif";
    context.textAlign = "center";
    context.fillText(
        `${(sinceLast / SECONDS_PER_MICROSECOND).toFixed(1)} / ` +
        `${(runtime.pushPeriod / SECONDS_PER_MICROSECOND).toFixed(0)} us`,
        width / 2, height - 3
    );
}

export function spectrumCanvasToTime(offsetX) {
    const entry = canvases["canvas-spectrum"];
    if (!entry || !acquisition.spectrum) return null;
    const padX = 48;
    const plotWidth = (entry.cssWidth ?? entry.element.width) - padX - 14;
    const window = spectrumWindow();
    const fraction = (offsetX - padX) / plotWidth;
    if (fraction < 0 || fraction > 1) return null;
    return window.from + fraction * (window.to - window.from);
}

export { timeFromMass };
