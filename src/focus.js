// Where the analyser focuses, and what is stopping it focusing better.
//
// Both answers are measured rather than derived. The focus curves launch ions
// that differ in exactly one starting coordinate and record when they arrive;
// the resolution budget switches one source spread on at a time and measures the
// peak each one produces on its own. Nothing here is fitted to a formula.

import { METRES_PER_MM } from "./constants.js";
import {
    buildRuntime,
    createIonState,
    advanceIon,
    fillState,
    flyIon,
    thermalVelocitySigma
} from "./physics.js";

// A single ion released from a stated point in the pusher with a stated
// velocity, everything else held at the centre of the source.
export function launchProbe(mz, config, runtime, probe = {}) {
    const fill = fillState(mz, config, runtime);
    const ion = createIonState(mz, {
        x: probe.x ?? fill.fillLength / 2,
        y: (probe.yMm ?? 0) * METRES_PER_MM,
        z: (probe.zMm ?? config.beamOffsetMm) * METRES_PER_MM,
        vx: fill.velocity,
        vy: probe.vy ?? 0,
        vz: probe.vz ?? 0
    });
    advanceIon(ion, runtime, Infinity);
    return ion;
}

// Arrival time against one starting coordinate, reported as a deviation from the
// ion launched from the centre of the source.
export function focusCurve(mz, config, runtime, axis, sampleCount = 41) {
    const ranges = {
        position: { half: config.beamThicknessMm / 2, unit: "mm", label: "Start position in pusher" },
        velocity: { half: 3, unit: "sigma", label: "Initial velocity along the flight axis" },
        height: { half: Math.max(config.beamHeightMm / 2, 0.5), unit: "mm", label: "Start height" }
    };
    const range = ranges[axis];
    const sigma = thermalVelocitySigma(mz, Math.max(1, config.beamTemperatureK));

    const points = [];
    const centre = launchProbe(mz, config, runtime, {});
    for (let index = 0; index < sampleCount; index++) {
        const offset = -range.half + (2 * range.half * index) / (sampleCount - 1);
        const probe = axis === "position" ? { zMm: config.beamOffsetMm + offset }
            : axis === "velocity" ? { vz: offset * sigma }
                : { yMm: offset };
        const ion = launchProbe(mz, config, runtime, probe);
        points.push({
            offset,
            deltaNs: ion.status === "struck"
                ? null
                : (ion.timeOfFlight - centre.timeOfFlight) * 1e9,
            status: ion.status
        });
    }
    return { axis, ...range, points, centreTimeSeconds: centre.timeOfFlight };
}

const TUNE_PROBE_COUNT = 7;

// Spread of arrival times across the whole beam thickness for one mirror tune.
// This is the quantity the mirror is there to minimise.
function tuneSpreadSeconds(mz, config, runtime) {
    let earliest = Infinity;
    let latest = -Infinity;
    for (let index = 0; index < TUNE_PROBE_COUNT; index++) {
        const fraction = index / (TUNE_PROBE_COUNT - 1) - 0.5;
        const ion = launchProbe(mz, config, runtime, {
            zMm: config.beamOffsetMm + fraction * config.beamThicknessMm
        });
        if (ion.status === "struck") return Infinity;
        earliest = Math.min(earliest, ion.timeOfFlight);
        latest = Math.max(latest, ion.timeOfFlight);
    }
    return latest - earliest;
}

export function mirrorTuneCurve(mz, config, sampleCount = 41, halfWidth = 0.09) {
    const centre = config.mirrorBackFraction;
    const points = [];
    for (let index = 0; index < sampleCount; index++) {
        const fraction = centre - halfWidth + (2 * halfWidth * index) / (sampleCount - 1);
        const tuned = { ...config, mirrorBackFraction: fraction };
        const spread = tuneSpreadSeconds(mz, tuned, buildRuntime(tuned));
        points.push({ fraction, spreadNs: Number.isFinite(spread) ? spread * 1e9 : null });
    }
    return { points, centre };
}

const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
const BACK_SEARCH_ITERATIONS = 26;
const BACK_SEARCH_LOW = 1.005;
const BACK_SEARCH_HIGH = 2.4;
const STAGE1_SEARCH_RANGE = [0.42, 0.86];
const STAGE1_COARSE_STEPS = 12;
const STAGE1_REFINE_ITERATIONS = 22;
const STAGE1_BRACKET_HALF_WIDTH = 0.05;

// Golden-section search for the back-plate voltage that flattens the arrival
// time across the beam. The back plate decides where the focus falls, so at a
// given stage-1 voltage there is one best value and it is easy to find.
export function autoTuneBackFraction(mz, config) {
    let low = BACK_SEARCH_LOW;
    let high = BACK_SEARCH_HIGH;
    const evaluate = (fraction) => {
        const tuned = { ...config, mirrorBackFraction: fraction };
        return tuneSpreadSeconds(mz, tuned, buildRuntime(tuned));
    };

    let probeLow = high - GOLDEN_RATIO * (high - low);
    let probeHigh = low + GOLDEN_RATIO * (high - low);
    let valueLow = evaluate(probeLow);
    let valueHigh = evaluate(probeHigh);

    for (let iteration = 0; iteration < BACK_SEARCH_ITERATIONS; iteration++) {
        if (valueLow < valueHigh) {
            high = probeHigh;
            probeHigh = probeLow;
            valueHigh = valueLow;
            probeLow = high - GOLDEN_RATIO * (high - low);
            valueLow = evaluate(probeLow);
        } else {
            low = probeLow;
            probeLow = probeHigh;
            valueLow = valueHigh;
            probeHigh = low + GOLDEN_RATIO * (high - low);
            valueHigh = evaluate(probeHigh);
        }
    }
    const backFraction = 0.5 * (low + high);
    const spread = evaluate(backFraction);
    return { backFraction, spreadNs: Number.isFinite(spread) ? spread * 1e9 : null };
}

// The full tune needs both mirror voltages: the stage-1 field shapes the
// second-order term and the back plate places the focus. The search is handed
// back as a stateful object so the interface can spend a few milliseconds on it
// per frame instead of freezing while it runs.
export function createMirrorTuner(mz, config) {
    const [rangeLow, rangeHigh] = STAGE1_SEARCH_RANGE;
    const coarse = [];
    for (let index = 0; index < STAGE1_COARSE_STEPS; index++) {
        coarse.push(rangeLow + ((rangeHigh - rangeLow) * index) / (STAGE1_COARSE_STEPS - 1));
    }

    const evaluate = (stage1Fraction) => {
        const result = autoTuneBackFraction(mz, { ...config, mirrorStage1Fraction: stage1Fraction });
        return {
            stage1Fraction,
            backFraction: result.backFraction,
            spreadNs: result.spreadNs === null ? Infinity : result.spreadNs
        };
    };

    const tuner = {
        done: false,
        completed: 0,
        total: STAGE1_COARSE_STEPS + 2 + STAGE1_REFINE_ITERATIONS,
        best: null
    };

    // The coarse pass brackets the second-order tune, then golden section closes
    // on it. A grid alone is not enough: the residual collapses over a stage-1
    // window a few thousandths wide, so anything coarser walks straight past it.
    let bracket = null;
    let refineStep = 0;

    const consider = (candidate) => {
        if (tuner.best === null || candidate.spreadNs < tuner.best.spreadNs) tuner.best = candidate;
    };

    tuner.advance = (budgetMs) => {
        const deadline = Date.now() + budgetMs;
        let progressed = false;

        while (!tuner.done && Date.now() < deadline) {
            if (coarse.length > 0) {
                consider(evaluate(coarse.shift()));
            } else if (bracket === null) {
                const centre = tuner.best.stage1Fraction;
                const low = Math.max(rangeLow, centre - STAGE1_BRACKET_HALF_WIDTH);
                const high = Math.min(rangeHigh, centre + STAGE1_BRACKET_HALF_WIDTH);
                const probeLow = high - GOLDEN_RATIO * (high - low);
                const probeHigh = low + GOLDEN_RATIO * (high - low);
                bracket = {
                    low, high, probeLow, probeHigh,
                    valueLow: evaluate(probeLow),
                    valueHigh: evaluate(probeHigh)
                };
                consider(bracket.valueLow);
                consider(bracket.valueHigh);
                tuner.completed++;
            } else if (refineStep < STAGE1_REFINE_ITERATIONS) {
                if (bracket.valueLow.spreadNs < bracket.valueHigh.spreadNs) {
                    bracket.high = bracket.probeHigh;
                    bracket.probeHigh = bracket.probeLow;
                    bracket.valueHigh = bracket.valueLow;
                    bracket.probeLow = bracket.high - GOLDEN_RATIO * (bracket.high - bracket.low);
                    bracket.valueLow = evaluate(bracket.probeLow);
                    consider(bracket.valueLow);
                } else {
                    bracket.low = bracket.probeLow;
                    bracket.probeLow = bracket.probeHigh;
                    bracket.valueLow = bracket.valueHigh;
                    bracket.probeHigh = bracket.low + GOLDEN_RATIO * (bracket.high - bracket.low);
                    bracket.valueHigh = evaluate(bracket.probeHigh);
                    consider(bracket.valueHigh);
                }
                refineStep++;
            } else {
                tuner.done = true;
                break;
            }
            tuner.completed++;
            progressed = true;
        }
        return progressed;
    };
    return tuner;
}

// Mean and standard deviation of a set of arrival times.
export function timeStatistics(times) {
    if (times.length === 0) return { count: 0, mean: 0, sigma: 0 };
    let sum = 0;
    for (const time of times) sum += time;
    const mean = sum / times.length;
    let variance = 0;
    for (const time of times) variance += (time - mean) * (time - mean);
    return { count: times.length, mean, sigma: Math.sqrt(variance / times.length) };
}

// Full width at half maximum read off a histogram of the arrival times, with the
// half-height crossings interpolated between bins.
//
// Two details matter. The histogram is smoothed over three bins first, because
// counting noise on a single bin can otherwise set the apex or trigger a
// crossing early and report a peak narrower than it is. And the edges are taken
// as the outermost bins still above half maximum rather than the first bin below
// it, so a noise dip inside the peak cannot cut the measurement short.
// Bin count and smoothing width were chosen by measuring known Gaussians: this
// pair holds the estimator within a couple of tenths of a percent of the exact
// 2.3548 sigma from a few hundred ions up to tens of thousands.
const FWHM_TAIL_QUANTILE = 0.004;
const FWHM_BIN_FACTOR = 0.8;
const FWHM_SMOOTH_THRESHOLD = 1500;

export function measureFwhm(times, binCount = null) {
    if (times.length < 8) return null;
    const sorted = [...times].sort((a, b) => a - b);
    // A single stray arrival must not stretch the histogram over the peak.
    const tail = Math.floor(FWHM_TAIL_QUANTILE * sorted.length);
    const low = sorted[tail];
    const high = sorted[sorted.length - 1 - tail];
    if (high <= low) return 0;

    const bins = binCount ??
        Math.max(12, Math.min(80, Math.round(Math.sqrt(times.length) * FWHM_BIN_FACTOR)));
    const width = (high - low) / bins;
    const raw = new Float64Array(bins);
    for (const time of sorted) {
        const index = Math.floor((time - low) / width);
        if (index >= 0 && index < bins) raw[index]++;
    }

    const smoothRadius = times.length < FWHM_SMOOTH_THRESHOLD ? 1 : 2;
    const counts = new Float64Array(bins);
    for (let index = 0; index < bins; index++) {
        let sum = 0;
        for (let offset = -smoothRadius; offset <= smoothRadius; offset++) {
            sum += raw[Math.min(bins - 1, Math.max(0, index + offset))];
        }
        counts[index] = sum / (2 * smoothRadius + 1);
    }

    let peak = 0;
    for (const value of counts) peak = Math.max(peak, value);
    const half = peak / 2;

    let first = -1;
    let last = -1;
    for (let index = 0; index < bins; index++) {
        if (counts[index] < half) continue;
        if (first < 0) first = index;
        last = index;
    }
    if (first < 0) return 0;

    const edge = (index, direction) => {
        const outside = index + direction;
        if (outside < 0 || outside >= bins) return low + (index + 0.5) * width;
        const span = counts[index] - counts[outside];
        const fraction = span <= 0 ? 0.5 : (counts[index] - half) / span;
        return low + (index + 0.5 + direction * fraction) * width;
    };
    return edge(last, 1) - edge(first, -1);
}

// Each source spread switched on by itself, so the peak it produces alone can be
// measured. The terms are not strictly independent, which is why the quadrature
// sum is reported next to the real peak instead of in place of it.
const SILENT_SOURCE = {
    beamThicknessMm: 0,
    beamHeightMm: 0,
    beamEnergySpreadEv: 0,
    thermalAxialScale: 0,
    thermalTransverseScale: 0
};

// The beam has one temperature but it acts through two quite different
// mechanisms, so they are separated here. Thermal motion along the flight axis
// is turn-around time. Thermal motion across it carries the ion off the axis,
// where a gridless mirror's potential is not the same as it is on the axis, and
// the ion turns around at a different depth.
const BUDGET_TERMS = [
    {
        key: "turnaround",
        label: "Turn-around time",
        note: "thermal velocity along the flight axis",
        only: { thermalAxialScale: 1 }
    },
    {
        key: "transverse",
        label: "Transverse velocity",
        note: "thermal motion across the mirror lens",
        only: { thermalTransverseScale: 1 }
    },
    {
        key: "space",
        label: "Position in pusher",
        note: "beam thickness, and the energy spread it causes",
        only: { beamThicknessMm: null }
    },
    {
        key: "height",
        label: "Beam height",
        note: "starting position across the mirror lens",
        only: { beamHeightMm: null }
    },
    {
        key: "beamEnergy",
        label: "Beam energy spread",
        note: "spread in drift velocity from the ion guide",
        only: { beamEnergySpreadEv: null }
    }
];

export function resolutionBudget(mz, config, ionCount = 900) {
    const collect = (variantConfig) => {
        const runtime = buildRuntime(variantConfig);
        const times = [];
        let lost = 0;
        for (let index = 0; index < ionCount; index++) {
            const ion = flyIon(mz, variantConfig, runtime, index);
            if (ion.status === "detected") times.push(ion.timeOfFlight);
            else lost++;
        }
        return { ...timeStatistics(times), fwhm: measureFwhm(times), lost };
    };

    const full = collect({ ...config, thermalAxialScale: 1, thermalTransverseScale: 1 });
    const terms = BUDGET_TERMS.map((term) => {
        // A term is measured by silencing the whole source and restoring one
        // spread; `null` means take the value the user actually configured.
        const restored = {};
        for (const [key, value] of Object.entries(term.only)) {
            restored[key] = value === null ? config[key] : value;
        }
        const measured = collect({ ...config, ...SILENT_SOURCE, ...restored });
        return { ...term, sigmaNs: measured.sigma * 1e9, lost: measured.lost };
    });

    const quadrature = Math.sqrt(
        terms.reduce((sum, term) => sum + term.sigmaNs * term.sigmaNs, 0)
    );
    return {
        mz,
        terms,
        totalSigmaNs: full.sigma * 1e9,
        quadratureSigmaNs: quadrature,
        fwhmNs: full.fwhm === null ? null : full.fwhm * 1e9,
        // A Gaussian peak has a width of 2.3548 sigma. Anything below that means
        // a sharp core with tails, which is what the mirror lens produces.
        tailFactor: full.fwhm > 0 && full.sigma > 0
            ? full.fwhm / (2.3548 * full.sigma) : null,
        meanTimeSeconds: full.mean,
        resolution: full.fwhm > 0 ? full.mean / (2 * full.fwhm) : null,
        detected: full.count,
        lost: full.lost
    };
}
