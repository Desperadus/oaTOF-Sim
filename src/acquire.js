// Acquiring a spectrum, digitising it and calibrating the mass scale.
//
// The slow part is flying ions and is done once: every detected ion contributes
// its arrival time to a list. Everything after that - binning, the detector pulse
// width, counting statistics, saturation, peak finding and the mass calibration -
// is rebuilt from those times in a few milliseconds, so the whole detector model
// stays interactive without re-flying a single ion.

import { SECONDS_PER_PICOSECOND, SECONDS_PER_NANOSECOND } from "./constants.js";
import { flyIon, fillState, expectedFlightTime } from "./physics.js";
import { config, state, speciesPresence } from "./state.js";

const TIME_WINDOW_MARGIN = 0.004;
const PEAK_THRESHOLD_FRACTION = 0.02;
const MIN_PEAK_BINS = 3;
const TAIL_REJECT_WIDTHS = 6;
const MAX_PEAKS = 16;
const RESPONSE_KERNEL_SIGMAS = 3.5;
const MAX_DIRECT_DRAWS = 300000;

export const acquisition = {
    running: false,
    completed: false,
    speciesIndex: 0,
    shotIndex: 0,
    flightsFlown: 0,
    startedAt: 0,
    durationMs: 0,
    speciesResults: [],
    spectrum: null,
    peaks: [],
    calibration: null,
    mobilityMap: null
};

export function startAcquisition() {
    acquisition.speciesResults = state.species.map((species) => ({
        mz: species.mz,
        label: species.label,
        color: species.color,
        oneOverK0: species.oneOverK0,
        times: [],
        flown: 0,
        detected: 0,
        missed: 0,
        struck: 0,
        dutyCycle: fillState(species.mz, config, state.runtime).dutyCycle,
        presence: speciesPresence(species)
    }));
    acquisition.speciesIndex = 0;
    acquisition.shotIndex = 0;
    acquisition.flightsFlown = 0;
    acquisition.running = true;
    acquisition.completed = false;
    acquisition.spectrum = null;
    acquisition.peaks = [];
    acquisition.calibration = null;
    acquisition.mobilityMap = null;
    acquisition.startedAt = performance.now();
    acquisition.durationMs = 0;
}

export function stopAcquisition() {
    acquisition.running = false;
}

export function acquisitionProgress() {
    const total = Math.max(1, state.species.length * config.ionsPerSpecies);
    const done = acquisition.speciesIndex * config.ionsPerSpecies + acquisition.shotIndex;
    return Math.min(1, done / total);
}

export function advanceAcquisition(budgetMs) {
    if (!acquisition.running) return false;
    const deadline = performance.now() + budgetMs;
    let progressed = false;

    while (acquisition.speciesIndex < state.species.length && performance.now() < deadline) {
        const species = state.species[acquisition.speciesIndex];
        const result = acquisition.speciesResults[acquisition.speciesIndex];

        const ion = flyIon(species.mz, config, state.runtime, acquisition.shotIndex);
        result.flown++;
        acquisition.flightsFlown++;
        if (ion.status === "detected") {
            result.detected++;
            result.times.push(ion.timeOfFlight);
        } else if (ion.status === "missed") {
            result.missed++;
        } else {
            result.struck++;
        }

        acquisition.shotIndex++;
        if (acquisition.shotIndex >= config.ionsPerSpecies) {
            acquisition.shotIndex = 0;
            acquisition.speciesIndex++;
        }
        progressed = true;
    }

    if (acquisition.speciesIndex >= state.species.length) {
        acquisition.running = false;
        acquisition.completed = true;
        acquisition.durationMs = performance.now() - acquisition.startedAt;
        rebuildSpectrum();
    }
    return progressed;
}

// Poisson deviate: Knuth's product method while the mean is small, and a normal
// approximation once it is large enough for the difference to be invisible.
function poissonSample(mean) {
    if (mean <= 0) return 0;
    if (mean > 40) {
        const u1 = Math.max(1e-12, Math.random());
        const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
        return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal));
    }
    const limit = Math.exp(-mean);
    let count = 0;
    let product = Math.random();
    while (product > limit) {
        count++;
        product *= Math.random();
    }
    return count;
}

function gaussianKernel(sigmaBins) {
    const radius = Math.max(1, Math.ceil(RESPONSE_KERNEL_SIGMAS * sigmaBins));
    const kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
        const value = Math.exp(-0.5 * (offset / sigmaBins) * (offset / sigmaBins));
        kernel[offset + radius] = value;
        sum += value;
    }
    for (let index = 0; index < kernel.length; index++) kernel[index] /= sum;
    return { kernel, radius };
}

// Turns the flown arrival times into the trace a digitiser would record.
export function rebuildSpectrum() {
    const results = acquisition.speciesResults.filter((result) => result.times.length > 0);
    if (results.length === 0) {
        acquisition.spectrum = null;
        acquisition.peaks = [];
        return;
    }

    // Cables, the amplifier and the trigger all add the same fixed delay to every
    // arrival. It is the reason a time-of-flight scale needs a two-term
    // calibration: the flight itself is exactly proportional to the square root
    // of m/z, and this offset is the only thing that is not.
    const delay = config.electronicsDelayNs * SECONDS_PER_NANOSECOND;

    let earliest = Infinity;
    let latest = -Infinity;
    for (const result of results) {
        for (const time of result.times) {
            if (time < earliest) earliest = time;
            if (time > latest) latest = time;
        }
    }
    earliest += delay;
    latest += delay;
    const margin = Math.max(TIME_WINDOW_MARGIN * (latest - earliest), 40e-9);
    const start = earliest - margin;
    const binWidth = config.binWidthPs * SECONDS_PER_PICOSECOND;
    const binCount = Math.min(2000000, Math.max(64, Math.ceil((latest - start + margin) / binWidth)));

    // Every ion of the most abundant species that reaches the pusher counts once
    // per push, so the height of a peak is a real number of recorded ions.
    let strongestPresence = 0;
    for (const result of results) strongestPresence = Math.max(strongestPresence, result.presence);
    if (strongestPresence <= 0) strongestPresence = 1;

    // Ions are counted one at a time, so the statistics belong to the number of
    // ions that arrive and not to the bins they land in. Each recorded ion is
    // dropped into a bin first and only then given the width of a detector
    // pulse, which is why the noise on a peak is correlated across the pulse
    // instead of appearing as isolated spikes on an empty baseline.
    const bins = new Float64Array(binCount);
    let expectedTotal = 0;
    for (const result of results) {
        const arriving = config.ionsPerPush * config.transientCount *
            (result.presence / strongestPresence) * result.dutyCycle;
        const recorded = arriving * (result.detected / Math.max(1, result.flown));
        expectedTotal += recorded;

        const counted = poissonSample(recorded);
        const draws = Math.min(counted, MAX_DIRECT_DRAWS);
        // Above the draw limit the shot noise is far below a tenth of a percent,
        // so representing many ions by one weighted draw changes nothing visible.
        const weight = draws > 0 ? counted / draws : 0;
        for (let draw = 0; draw < draws; draw++) {
            const time = result.times[Math.floor(Math.random() * result.times.length)];
            const index = Math.floor((time + delay - start) / binWidth);
            if (index >= 0 && index < binCount) bins[index] += weight;
        }
    }

    const sigmaBins = (config.singleIonResponseNs * SECONDS_PER_NANOSECOND / 2.3548) / binWidth;
    let smoothed = bins;
    if (sigmaBins > 0.05) {
        const { kernel, radius } = gaussianKernel(sigmaBins);
        smoothed = new Float64Array(binCount);
        for (let index = 0; index < binCount; index++) {
            const value = bins[index];
            if (value === 0) continue;
            const from = Math.max(0, index - radius);
            const to = Math.min(binCount - 1, index + radius);
            for (let target = from; target <= to; target++) {
                smoothed[target] += value * kernel[target - index + radius];
            }
        }
    }

    // A digitiser can only record so much signal in one transient; anything
    // above that is clipped and the summed peak comes back flat topped.
    const transients = Math.max(1, config.transientCount);
    let maximum = 0;
    const ceiling = config.saturationPerTransient > 0
        ? config.saturationPerTransient * transients
        : Infinity;
    for (let index = 0; index < binCount; index++) {
        const value = Math.min(smoothed[index], ceiling);
        smoothed[index] = value;
        if (value > maximum) maximum = value;
    }

    acquisition.spectrum = {
        start, binWidth, binCount, bins: smoothed, maximum,
        responseBins: sigmaBins, expectedTotal
    };
    acquisition.peaks = detectPeaks();
    acquisition.calibration = fitCalibration();
    acquisition.mobilityMap = config.mode === "tims" ? buildMobilityMap() : null;
}

function binTime(spectrum, index) {
    return spectrum.start + (index + 0.5) * spectrum.binWidth;
}

function crossingTime(spectrum, indexA, indexB, level) {
    const { bins } = spectrum;
    const span = bins[indexA] - bins[indexB];
    const fraction = span === 0 ? 0 : (bins[indexA] - level) / span;
    return binTime(spectrum, indexA) +
        fraction * (binTime(spectrum, indexB) - binTime(spectrum, indexA));
}

// Contiguous stretches above threshold are treated as one peak, with the half
// maximum crossings interpolated between bins.
function detectPeaks() {
    const spectrum = acquisition.spectrum;
    if (!spectrum || spectrum.maximum <= 0) return [];
    const { bins, binCount, maximum } = spectrum;
    const threshold = maximum * PEAK_THRESHOLD_FRACTION;

    // Regions separated by less than one detector pulse cannot be distinct
    // peaks, so they are joined before anything is measured.
    const gapLimit = Math.max(MIN_PEAK_BINS, Math.ceil(2 * spectrum.responseBins));
    const regions = [];
    let open = null;
    for (let index = 0; index < binCount; index++) {
        if (bins[index] >= threshold) {
            if (open === null) open = { start: index, end: index };
            else open.end = index;
        } else if (open !== null && index - open.end > gapLimit) {
            regions.push(open);
            open = null;
        }
    }
    if (open !== null) regions.push(open);

    const peaks = [];
    let regionStart = null;

    const closeRegion = (regionEnd) => {
        let apexIndex = regionStart;
        let weightSum = 0;
        let weightedTime = 0;
        for (let index = regionStart; index <= regionEnd; index++) {
            if (bins[index] > bins[apexIndex]) apexIndex = index;
            weightSum += bins[index];
            weightedTime += bins[index] * binTime(spectrum, index);
        }
        const half = bins[apexIndex] / 2;

        let leftEdge = binTime(spectrum, regionStart);
        for (let index = apexIndex; index > 0; index--) {
            if (bins[index - 1] > half) continue;
            leftEdge = crossingTime(spectrum, index, index - 1, half);
            break;
        }
        let rightEdge = binTime(spectrum, regionEnd);
        for (let index = apexIndex; index < binCount - 1; index++) {
            if (bins[index + 1] > half) continue;
            rightEdge = crossingTime(spectrum, index, index + 1, half);
            break;
        }

        const width = rightEdge - leftEdge;
        const centreTime = 0.5 * (leftEdge + rightEdge);
        peaks.push({
            centreTime,
            centroidTime: weightSum > 0 ? weightedTime / weightSum : centreTime,
            intensity: bins[apexIndex],
            relativeIntensity: bins[apexIndex] / maximum,
            area: weightSum,
            widthSeconds: width,
            resolution: width > 0 ? centreTime / (2 * width) : null
        });
    };

    for (const region of regions) {
        if (region.end - region.start + 1 < MIN_PEAK_BINS) continue;
        regionStart = region.start;
        closeRegion(region.end);
    }

    // A real oaTOF peak has long tails, and at low ion counts a lump in a tail
    // can rise above threshold on its own. Anything sitting within a few widths
    // of a stronger peak is part of that peak, not a separate one: two genuine
    // species that close could not have been resolved in the first place.
    const ranked = peaks.sort((a, b) => b.intensity - a.intensity);
    const kept = [];
    for (const peak of ranked) {
        const shadowed = kept.some((stronger) =>
            Math.abs(stronger.centreTime - peak.centreTime) <
            TAIL_REJECT_WIDTHS * stronger.widthSeconds);
        if (!shadowed) kept.push(peak);
    }
    return kept.slice(0, MAX_PEAKS);
}

// Time of flight goes as the square root of m/z with an offset for the time the
// ion spends being accelerated and for the delay in the electronics, so the
// standard calibration is a straight line in sqrt(m/z).
function fitCalibration() {
    const peaks = acquisition.peaks;
    if (peaks.length === 0) return null;

    // Each peak is matched to whichever species it should have come from, and a
    // species that matches more than one peak keeps only its strongest, so a
    // partly resolved shoulder cannot be used as a second calibration point.
    const delay = config.electronicsDelayNs * SECONDS_PER_NANOSECOND;
    const byMz = new Map();
    for (const peak of peaks) {
        let best = null;
        let bestDistance = Infinity;
        for (const result of acquisition.speciesResults) {
            const expected = expectedFlightTime(result.mz, state.runtime) + delay;
            const distance = Math.abs(expected - peak.centreTime);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = result;
            }
        }
        if (!best || bestDistance > 0.02 * peak.centreTime) continue;
        const existing = byMz.get(best.mz);
        if (!existing || peak.intensity > existing.peak.intensity) {
            byMz.set(best.mz, { mz: best.mz, label: best.label, peak });
        }
    }
    const pairs = [...byMz.values()];
    if (pairs.length < (config.calibrationUseOffset ? 2 : 1)) return null;

    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    for (const pair of pairs) {
        const x = Math.sqrt(pair.mz);
        const y = pair.peak.centreTime;
        sumX += x; sumY += y; sumXX += x * x; sumXY += x * y;
    }
    const count = pairs.length;
    let slope;
    let intercept;
    if (config.calibrationUseOffset) {
        const denominator = count * sumXX - sumX * sumX;
        slope = denominator === 0 ? 0 : (count * sumXY - sumX * sumY) / denominator;
        intercept = (sumY - slope * sumX) / count;
    } else {
        slope = sumXX === 0 ? 0 : sumXY / sumXX;
        intercept = 0;
    }

    const residuals = pairs.map((pair) => {
        const measured = massFromTime(pair.peak.centreTime, { slope, intercept });
        return {
            mz: pair.mz,
            label: pair.label,
            measuredMz: measured,
            errorPpm: measured === null ? null : ((measured - pair.mz) / pair.mz) * 1e6,
            peak: pair.peak
        };
    });
    const worst = residuals.reduce(
        (largest, entry) => Math.max(largest, Math.abs(entry.errorPpm ?? 0)), 0
    );
    return { slope, intercept, pairs: residuals, worstPpm: worst, usedOffset: config.calibrationUseOffset };
}

export function massFromTime(time, calibration) {
    if (!calibration || calibration.slope === 0) return null;
    const root = (time - calibration.intercept) / calibration.slope;
    return root > 0 ? root * root : null;
}

export function timeFromMass(mz, calibration) {
    if (!calibration) return null;
    return calibration.slope * Math.sqrt(mz) + calibration.intercept;
}

// A mobility map is the outer product of what the TIMS releases and what the
// analyser measures: the ramp only changes how many ions of a species reach the
// pusher, never how they fly, so the flown peak is reused at every ramp step.
const MOBILITY_STEPS = 96;

function buildMobilityMap() {
    const results = acquisition.speciesResults.filter((result) => result.times.length > 0);
    if (results.length === 0) return null;

    const entries = results.map((result) => {
        const total = result.times.reduce((sum, time) => sum + time, 0);
        return {
            mz: result.mz,
            label: result.label,
            color: result.color,
            oneOverK0: result.oneOverK0,
            meanTime: total / result.times.length,
            weight: (result.detected / Math.max(1, result.flown)) * result.dutyCycle *
                (result.presence > 0 ? 1 : 0)
        };
    });
    return { steps: MOBILITY_STEPS, entries };
}

// Compresses the spectrum onto a pixel grid, keeping the tallest bin in each
// column so narrow peaks survive the downsampling.
export function spectrumProfile(pixelCount, fromTime, toTime) {
    const spectrum = acquisition.spectrum;
    if (!spectrum) return null;
    const profile = new Float64Array(pixelCount);
    const span = toTime - fromTime;
    if (span <= 0) return profile;

    for (let index = 0; index < spectrum.binCount; index++) {
        const value = spectrum.bins[index];
        if (value === 0) continue;
        const pixel = Math.floor(((binTime(spectrum, index) - fromTime) / span) * pixelCount);
        if (pixel < 0 || pixel >= pixelCount) continue;
        if (value > profile[pixel]) profile[pixel] = value;
    }
    return profile;
}
