// Central mutable simulation state, sample definitions and the live ion beam.

import { METRES_PER_MM, ION_PALETTE } from "./constants.js";
import {
    buildRuntime,
    createIonState,
    advanceIon,
    beamVelocity,
    thermalVelocitySigma
} from "./physics.js";
import { elutionWeight } from "./tims.js";

export const config = {
    mode: "continuous",

    accelVoltageKv: 9.0,
    pusherFieldVPerMm: 600,
    pusherGapMm: 6,
    accelGapMm: 20,
    pusherLengthMm: 30,
    pushFrequencyKhz: 10,

    driftLengthMm: 700,
    apertureHalfHeightMm: 20,

    mirrorStage1Mm: 50,
    mirrorStage2Mm: 150,
    mirrorHalfHeightMm: 25,
    mirrorStage1Fraction: 0.6525,
    mirrorBackFraction: 1.3198,
    mirrorModel: "solved",

    detectorAlignMz: 1000,
    detectorLengthMm: 40,
    detectorHalfHeightMm: 18,
    detectorShiftMm: 0,

    beamEnergyEv: 8,
    beamEnergySpreadEv: 1.0,
    beamThicknessMm: 1.0,
    beamOffsetMm: 3,
    beamHeightMm: 1.0,
    beamTemperatureK: 300,

    timsGasVelocity: 150,
    timsRampStartVPerCm: 60,
    timsRampEndVPerCm: 12,
    timsRampMs: 100,
    timsPacketWidthMs: 1.0,
    timsSynchronised: false,
    timsRampFraction: 0.5,

    ionsPerSpecies: 900,
    binWidthPs: 250,
    singleIonResponseNs: 0.9,
    ionsPerPush: 40,
    transientCount: 400,
    saturationPerTransient: 0,
    electronicsDelayNs: 12,
    calibrationUseOffset: true,

    playbackMicrosecondsPerSecond: 15,
    transverseExaggeration: 4,
    liveBeamDensity: 12,
    maxFlightIons: 90,
    showGrid: true,
    showField: false,
    showTrails: true,
    electrodeOpacity: 55
};

// Reduced mobility is carried as 1/K0 in V*s/cm^2, which is the axis a mobility
// spectrum is plotted against.
export const SAMPLE_MIXTURES = {
    peptides: {
        label: "Tryptic peptides",
        species: [
            { mz: 500, abundance: 70, oneOverK0: 0.62, label: "Peptide A" },
            { mz: 700, abundance: 100, oneOverK0: 0.75, label: "Peptide B" },
            { mz: 900, abundance: 85, oneOverK0: 0.88, label: "Peptide C" },
            { mz: 1200, abundance: 45, oneOverK0: 1.05, label: "Peptide D" }
        ]
    },
    calibrant: {
        label: "ESI tune mix",
        species: [
            { mz: 322.0481, abundance: 60, oneOverK0: 0.50, label: "322" },
            { mz: 622.0290, abundance: 100, oneOverK0: 0.65, label: "622" },
            { mz: 922.0098, abundance: 80, oneOverK0: 0.83, label: "922" },
            { mz: 1221.9906, abundance: 45, oneOverK0: 1.00, label: "1222" },
            { mz: 1521.9715, abundance: 25, oneOverK0: 1.17, label: "1522" }
        ]
    },
    isotopes: {
        label: "Isotope cluster",
        species: [
            { mz: 1000.0, abundance: 100, oneOverK0: 0.92, label: "M" },
            { mz: 1001.0034, abundance: 55, oneOverK0: 0.92, label: "M+1" },
            { mz: 1002.0067, abundance: 17, oneOverK0: 0.92, label: "M+2" },
            { mz: 1003.0101, abundance: 4, oneOverK0: 0.92, label: "M+3" }
        ]
    },
    isomers: {
        label: "Mobility isomers (same m/z)",
        species: [
            { mz: 800, abundance: 100, oneOverK0: 0.78, label: "Compact" },
            { mz: 800, abundance: 80, oneOverK0: 0.89, label: "Extended" }
        ]
    },
    resolving: {
        label: "Resolution challenge",
        species: [
            { mz: 1000.0, abundance: 100, oneOverK0: 0.92, label: "1000.000" },
            { mz: 1000.09, abundance: 100, oneOverK0: 0.92, label: "1000.090" }
        ]
    },
    wideRange: {
        label: "Wide mass range",
        species: [
            { mz: 200, abundance: 100, oneOverK0: 0.40, label: "m/z 200" },
            { mz: 500, abundance: 100, oneOverK0: 0.62, label: "m/z 500" },
            { mz: 1000, abundance: 100, oneOverK0: 0.92, label: "m/z 1000" },
            { mz: 2000, abundance: 100, oneOverK0: 1.35, label: "m/z 2000" },
            { mz: 4000, abundance: 100, oneOverK0: 1.95, label: "m/z 4000" }
        ]
    }
};

export const state = {
    runtime: buildRuntime(config),
    sampleKey: "peptides",
    species: [],
    beamIons: [],
    flightIons: [],
    clock: 0,
    nextPushAt: 0,
    pushCount: 0,
    lastPushAt: 0,
    detectedCount: 0,
    lostCount: 0,
    arrivedSinceLastPush: 0,
    capturedAtLastPush: 0,
    arrivedBeforeLastPush: 0,
    inspectedIonIndex: 0,
    isPlaying: true,
    impactMarks: [],
    liveArrivals: []
};

// Results of the analyses the user asks for explicitly, kept apart from the
// simulation state because each one costs a few thousand ion flights.
export const analysis = {
    focus: null,
    focusAxis: "position",
    tune: null,
    budget: null,
    tuner: null
};

export function rebuildRuntime() {
    state.runtime = buildRuntime(config);
}

export function applySample(sampleKey) {
    state.sampleKey = sampleKey;
    setSpecies(SAMPLE_MIXTURES[sampleKey].species);
}

export function setCustomSpecies(species) {
    state.sampleKey = "custom";
    setSpecies(species);
}

function setSpecies(entries) {
    state.species = entries.map((entry, index) => ({
        ...entry,
        color: entry.color || ION_PALETTE[index % ION_PALETTE.length],
        spawnTimer: 0
    }));
    resetBeam();
}

// Relative amount of a species reaching the pusher right now. In continuous mode
// that is just its abundance; under a mobility ramp it is whatever fraction of
// its mobility peak is currently eluting.
export function speciesPresence(species) {
    if (config.mode !== "tims") return species.abundance;
    return species.abundance * elutionWeight(species.oneOverK0, config.timsRampFraction, config);
}

export function resetBeam() {
    state.beamIons = [];
    state.flightIons = [];
    state.clock = 0;
    state.nextPushAt = state.runtime.pushPeriod;
    state.pushCount = 0;
    state.lastPushAt = 0;
    state.detectedCount = 0;
    state.lostCount = 0;
    state.arrivedSinceLastPush = 0;
    state.capturedAtLastPush = 0;
    state.arrivedBeforeLastPush = 0;
    state.impactMarks = [];
    state.liveArrivals = [];
    state.inspectedIonIndex = 0;
    for (const species of state.species) species.spawnTimer = 0;
}

const MAX_TRAIL_POINTS = 150;
const IMPACT_MARK_LIMIT = 50;
const MAX_LIVE_ARRIVALS = 400;
const FINISHED_LINGER_SECONDS_OF_FLIGHT = 6e-6;

function maxAbundance() {
    let largest = 1;
    for (const species of state.species) largest = Math.max(largest, species.abundance);
    return largest;
}

// The beam is injected at the pusher entrance and drifts across it. Nothing
// decides in advance how many ions a push will collect: whatever happens to be
// inside the aperture when the pusher fires is what gets launched, so the duty
// cycle is measured rather than applied.
function injectBeam(dt) {
    const runtime = state.runtime;
    const largest = maxAbundance();

    for (let index = 0; index < state.species.length; index++) {
        const species = state.species[index];
        const presence = speciesPresence(species) / largest;
        if (presence <= 0) continue;

        const velocity = beamVelocity(species.mz, config.beamEnergyEv);
        const interval = runtime.pusherLength / (velocity * config.liveBeamDensity * presence);
        species.spawnTimer += dt;
        while (species.spawnTimer >= interval) {
            species.spawnTimer -= interval;
            state.beamIons.push({
                speciesIndex: index,
                mz: species.mz,
                color: species.color,
                label: species.label,
                x: 0,
                y: (Math.random() - 0.5) * config.beamHeightMm * METRES_PER_MM,
                z: (config.beamOffsetMm + (Math.random() - 0.5) * config.beamThicknessMm) *
                    METRES_PER_MM,
                velocity
            });
            state.arrivedSinceLastPush++;
        }
    }
}

function driftBeam(dt) {
    const limit = state.runtime.pusherLength;
    const survivors = [];
    for (const ion of state.beamIons) {
        ion.x += ion.velocity * dt;
        if (ion.x <= limit) survivors.push(ion);
    }
    state.beamIons = survivors;
}

function firePusher() {
    const runtime = state.runtime;
    state.pushCount++;
    state.lastPushAt = state.clock;
    state.arrivedBeforeLastPush = state.arrivedSinceLastPush;
    state.capturedAtLastPush = state.beamIons.length;
    state.arrivedSinceLastPush = 0;

    for (const beamIon of state.beamIons) {
        if (state.flightIons.length >= config.maxFlightIons) break;
        const sigma = thermalVelocitySigma(beamIon.mz, config.beamTemperatureK);
        const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, Math.random())));
        const angle = 2 * Math.PI * Math.random();
        const ion = createIonState(beamIon.mz, {
            x: beamIon.x,
            y: beamIon.y,
            z: beamIon.z,
            vx: beamVelocity(beamIon.mz, config.beamEnergyEv),
            vy: sigma * radius * Math.sin(angle),
            vz: sigma * radius * Math.cos(angle)
        });
        ion.speciesIndex = beamIon.speciesIndex;
        ion.color = beamIon.color;
        ion.label = beamIon.label;
        ion.trail = [];
        ion.finishedAt = null;
        ion.pushIndex = state.pushCount;
        state.flightIons.push(ion);
    }
    state.beamIons = [];
    state.nextPushAt += runtime.pushPeriod;
}

function retireFinished() {
    const survivors = [];
    for (const ion of state.flightIons) {
        if (ion.status === "flying" || ion.finishedAt === null ||
            state.clock - ion.finishedAt < FINISHED_LINGER_SECONDS_OF_FLIGHT) {
            survivors.push(ion);
        }
    }
    state.flightIons = survivors;
}

export function advanceLiveBeam(simulatedSeconds) {
    const runtime = state.runtime;
    injectBeam(simulatedSeconds);
    driftBeam(simulatedSeconds);

    state.clock += simulatedSeconds;
    // A slow playback rate can leave several push periods inside one frame.
    let guard = 0;
    while (state.clock >= state.nextPushAt && guard++ < 8) firePusher();
    if (state.clock >= state.nextPushAt) state.nextPushAt = state.clock + runtime.pushPeriod;

    for (const ion of state.flightIons) {
        if (ion.status !== "flying") continue;
        const target = state.clock - (ion.pushIndex * runtime.pushPeriod);
        advanceIon(ion, runtime, target, 4000);

        ion.trail.push({ x: ion.x, y: ion.y, z: ion.z });
        if (ion.trail.length > MAX_TRAIL_POINTS) ion.trail.shift();

        if (ion.status === "flying") continue;
        ion.finishedAt = state.clock;
        if (ion.status === "detected") {
            state.detectedCount++;
            state.liveArrivals.push({ mz: ion.mz, time: ion.timeOfFlight, color: ion.color });
            if (state.liveArrivals.length > MAX_LIVE_ARRIVALS) state.liveArrivals.shift();
        } else {
            state.lostCount++;
            state.impactMarks.push({
                x: ion.x, y: ion.y, z: ion.z, color: ion.color, reason: ion.lossReason
            });
            if (state.impactMarks.length > IMPACT_MARK_LIMIT) state.impactMarks.shift();
        }
    }
    retireFinished();
    state.inspectedIonIndex = Math.min(
        state.inspectedIonIndex, Math.max(0, state.flightIons.length - 1)
    );
}
