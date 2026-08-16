// Geometry, fields and ion flight for the orthogonal-acceleration analyser.
//
// Everything is in SI units, so the kilovolts, millimetres and microseconds the
// interface reports are the ones a real instrument would show.
//
// The flight crosses four regions. In the pusher, the accelerator and the drift
// the field is constant across the whole region, so a step taken inside one of
// them is exact no matter how long it is; there the step length only has to be
// short enough to draw a smooth trail. Inside the mirror the solved field varies
// from point to point and velocity Verlet does the work. Steps are never allowed
// to straddle a boundary, because averaging two different accelerations across a
// field discontinuity throws away far more accuracy than any step size buys back.

import {
    ELEMENTARY_CHARGE,
    ATOMIC_MASS_UNIT,
    BOLTZMANN_CONSTANT,
    METRES_PER_MM,
    ACCEL_STEPS_PER_STACK,
    MIRROR_STEPS_PER_LENGTH,
    DRIFT_STEPS_PER_LENGTH,
    MAX_STEPS_PER_FLIGHT,
    BOUNDARY_OVERSHOOT
} from "./constants.js";
import {
    getMirrorSolution,
    combineMirrorField,
    mirrorFieldAt,
    idealMirrorFieldAt
} from "./mirror.js";

export function massPerCharge(mz) {
    return mz * ATOMIC_MASS_UNIT;
}

// Speed along the beam axis, which the analyser never changes: no field in the
// instrument has a component along x, so this velocity survives the whole flight.
// It is what skews the path into a V and decides where an ion lands on the
// detector, and it is also what sets the duty cycle of the source.
export function beamVelocity(mz, beamEnergyEv) {
    return Math.sqrt((2 * ELEMENTARY_CHARGE * beamEnergyEv) / massPerCharge(mz));
}

// One-dimensional thermal velocity spread of the beam leaving the ion guide.
// This is the root of the turn-around time and therefore of the resolution
// ceiling, which is why the beam temperature is a control and not a constant.
export function thermalVelocitySigma(mz, temperatureK) {
    return Math.sqrt((BOLTZMANN_CONSTANT * temperatureK) / massPerCharge(mz));
}

export function buildRuntime(config) {
    const pusherGap = config.pusherGapMm * METRES_PER_MM;
    const accelGap = config.accelGapMm * METRES_PER_MM;
    const stackEnd = pusherGap + accelGap;
    const driftLength = config.driftLengthMm * METRES_PER_MM;
    const mirrorStart = stackEnd + driftLength;
    const stage1Length = config.mirrorStage1Mm * METRES_PER_MM;
    const stage2Length = config.mirrorStage2Mm * METRES_PER_MM;
    const mirrorHalfHeight = config.mirrorHalfHeightMm * METRES_PER_MM;
    const mirrorLength = stage1Length + stage2Length;

    const accelVoltage = config.accelVoltageKv * 1000;
    const pusherField = config.pusherFieldVPerMm * 1000;
    const gridVoltage = accelVoltage - pusherField * pusherGap;

    // Mirror voltages are quoted against the energy an ion actually leaves with
    // rather than against the stack voltage, so moving the beam inside the pusher
    // does not silently detune the mirror.
    const nominalEnergy = accelVoltage - pusherField * config.beamOffsetMm * METRES_PER_MM;
    const stage1Voltage = config.mirrorStage1Fraction * nominalEnergy;
    const backVoltage = config.mirrorBackFraction * nominalEnergy;

    const solution = getMirrorSolution(stage1Length, stage2Length, mirrorHalfHeight);
    const mirrorField = combineMirrorField(solution, stage1Voltage, backVoltage);

    const pushPeriod = 1 / (config.pushFrequencyKhz * 1000);
    const packetWindow = config.mode === "tims" && config.timsSynchronised
        ? Math.min(pushPeriod, config.timsPacketWidthMs * 1e-3)
        : pushPeriod;

    const runtime = {
        pusherGap,
        accelGap,
        stackEnd,
        driftLength,
        mirrorStart,
        mirrorLength,
        stage1Length,
        stage2Length,
        mirrorEnd: mirrorStart + mirrorLength,
        mirrorFieldStart: mirrorStart - solution.preLength,
        mirrorPreLength: solution.preLength,
        mirrorHalfHeight,
        mirrorField,
        mirrorSolution: solution,
        mirrorIdeal: config.mirrorModel === "ideal",

        accelVoltage,
        pusherField,
        gridVoltage,
        accelField: gridVoltage / accelGap,
        nominalEnergy,
        mirrorStage1Voltage: stage1Voltage,
        mirrorBackVoltage: backVoltage,

        pusherLength: config.pusherLengthMm * METRES_PER_MM,
        apertureHalfHeight: config.apertureHalfHeightMm * METRES_PER_MM,
        pushPeriod,
        packetWindow,

        detectorLength: config.detectorLengthMm * METRES_PER_MM,
        detectorHalfHeight: config.detectorHalfHeightMm * METRES_PER_MM,
        detectorShift: config.detectorShiftMm * METRES_PER_MM,

        boundaries: [0, pusherGap, stackEnd, mirrorStart - solution.preLength, mirrorStart + mirrorLength]
    };

    runtime.reference = referenceFlight(config, runtime);
    runtime.detectorCentre = runtime.reference.landingX + runtime.detectorShift;
    return runtime;
}

// Total potential an ion starting at z sees, which fixes the energy it arrives
// with. Ions deeper in the pusher gain more, and that spread is exactly what the
// mirror has to focus away.
export function accelerationPotential(startZ, runtime) {
    const clamped = Math.max(0, Math.min(runtime.pusherGap, startZ));
    return runtime.accelVoltage - runtime.pusherField * clamped;
}

export const REGION_PUSHER = 0;
export const REGION_ACCEL = 1;
export const REGION_DRIFT = 2;
export const REGION_MIRROR = 3;

export function regionOf(z, runtime) {
    if (z < runtime.pusherGap) return REGION_PUSHER;
    if (z < runtime.stackEnd) return REGION_ACCEL;
    if (z < runtime.mirrorFieldStart) return REGION_DRIFT;
    return REGION_MIRROR;
}

// Axial field of the three uniform regions, in V/m.
function uniformFieldAt(z, runtime) {
    if (z < runtime.pusherGap) return runtime.pusherField;
    if (z < runtime.stackEnd) return runtime.accelField;
    return 0;
}

const mirrorScratch = { z: 0, y: 0 };

function mirrorAcceleration(z, y, chargeToMass, runtime, out) {
    const mirrorZ = z - runtime.mirrorStart;
    if (runtime.mirrorIdeal) idealMirrorFieldAt(runtime.mirrorField, mirrorZ, mirrorScratch);
    else mirrorFieldAt(runtime.mirrorField, mirrorZ, y, mirrorScratch);
    out.z = chargeToMass * mirrorScratch.z;
    out.y = chargeToMass * mirrorScratch.y;
    return out;
}

// Electric field in V/m anywhere in the instrument, for the field overlay.
export function fieldAt(z, y, runtime, out) {
    if (z < runtime.mirrorFieldStart) {
        out.y = 0;
        out.z = uniformFieldAt(z, runtime);
        return out;
    }
    const mirrorZ = z - runtime.mirrorStart;
    if (runtime.mirrorIdeal) return idealMirrorFieldAt(runtime.mirrorField, mirrorZ, out);
    return mirrorFieldAt(runtime.mirrorField, mirrorZ, y, out);
}

function apertureHalfHeightAt(z, runtime) {
    return z >= runtime.mirrorStart ? runtime.mirrorHalfHeight : runtime.apertureHalfHeight;
}

// Smallest positive time at which constant acceleration carries the ion from
// `position` onto `plane`. Returns Infinity when it never gets there.
function timeToPlane(position, velocity, acceleration, plane) {
    const distance = plane - position;
    if (Math.abs(acceleration) < 1e-12) {
        if (velocity === 0) return Infinity;
        const time = distance / velocity;
        return time > 0 ? time : Infinity;
    }
    const discriminant = velocity * velocity + 2 * acceleration * distance;
    if (discriminant < 0) return Infinity;
    const root = Math.sqrt(discriminant);
    let best = Infinity;
    for (const candidate of [(-velocity + root) / acceleration, (-velocity - root) / acceleration]) {
        if (candidate > 0 && candidate < best) best = candidate;
    }
    return best;
}

function regionStepLength(z, runtime) {
    if (z < runtime.stackEnd) return runtime.stackEnd / ACCEL_STEPS_PER_STACK;
    if (z < runtime.mirrorFieldStart) return runtime.driftLength / DRIFT_STEPS_PER_LENGTH;
    return runtime.mirrorLength / MIRROR_STEPS_PER_LENGTH;
}

const accelerationNow = { z: 0, y: 0 };
const accelerationNext = { z: 0, y: 0 };

export function stepIon(ion, runtime, dt) {
    if (ion.status !== "flying") return ion.status;

    if (ion.z >= runtime.mirrorFieldStart) {
        mirrorAcceleration(ion.z, ion.y, ion.chargeToMass, runtime, accelerationNow);
        const halfDtSquared = 0.5 * dt * dt;
        ion.z += ion.vz * dt + accelerationNow.z * halfDtSquared;
        ion.y += ion.vy * dt + accelerationNow.y * halfDtSquared;
        ion.x += ion.vx * dt;
        mirrorAcceleration(ion.z, ion.y, ion.chargeToMass, runtime, accelerationNext);
        ion.vz += 0.5 * (accelerationNow.z + accelerationNext.z) * dt;
        ion.vy += 0.5 * (accelerationNow.y + accelerationNext.y) * dt;
    } else {
        // Constant acceleration across the whole step, so this is the exact
        // solution rather than an approximation to it.
        const az = ion.chargeToMass * uniformFieldAt(ion.z, runtime);
        ion.z += ion.vz * dt + 0.5 * az * dt * dt;
        ion.y += ion.vy * dt;
        ion.x += ion.vx * dt;
        ion.vz += az * dt;
    }

    ion.timeOfFlight += dt;
    classify(ion, runtime);
    return ion.status;
}

function classify(ion, runtime) {
    if (!ion.launched && ion.z >= runtime.stackEnd) ion.launched = true;

    if (ion.z < 0) {
        ion.status = "struck";
        ion.lossReason = "pusher plate";
        return;
    }
    if (Math.abs(ion.y) > apertureHalfHeightAt(ion.z, runtime)) {
        ion.status = "struck";
        ion.lossReason = ion.z >= runtime.mirrorStart ? "mirror wall" : "flight tube";
        return;
    }
    if (ion.z > runtime.mirrorEnd) {
        ion.status = "struck";
        ion.lossReason = "through the mirror";
        return;
    }
    if (!ion.launched || ion.z > runtime.stackEnd || ion.vz >= 0) return;

    ion.arrivalX = ion.x;
    ion.arrivalY = ion.y;
    if (Math.abs(ion.x - runtime.detectorCentre) > runtime.detectorLength / 2) {
        ion.status = "missed";
        ion.lossReason = "past the detector";
    } else if (Math.abs(ion.y) > runtime.detectorHalfHeight) {
        ion.status = "missed";
        ion.lossReason = "over the detector";
    } else {
        ion.status = "detected";
    }
}

// Step that respects the local field scale and stops on the next region
// boundary, then steps a hair past it so the ion is never sitting on a boundary
// without belonging to a region.
export function suggestedStep(ion, runtime) {
    let axialAcceleration;
    if (ion.z >= runtime.mirrorFieldStart) {
        mirrorAcceleration(ion.z, ion.y, ion.chargeToMass, runtime, accelerationNow);
        axialAcceleration = accelerationNow.z;
    } else {
        axialAcceleration = ion.chargeToMass * uniformFieldAt(ion.z, runtime);
    }

    const speed = Math.hypot(ion.vx, ion.vy, ion.vz);
    const length = regionStepLength(ion.z, runtime);
    let dt = speed > 0 ? length / speed : length;
    let onBoundary = false;

    for (const plane of runtime.boundaries) {
        const crossing = timeToPlane(ion.z, ion.vz, axialAcceleration, plane);
        if (crossing < dt) {
            dt = crossing;
            onBoundary = true;
        }
    }
    return onBoundary ? dt * (1 + BOUNDARY_OVERSHOOT) : dt;
}

export function advanceIon(ion, runtime, targetTime, maxSteps = MAX_STEPS_PER_FLIGHT) {
    let steps = 0;
    while (ion.status === "flying" && ion.timeOfFlight < targetTime && steps < maxSteps) {
        const remaining = targetTime - ion.timeOfFlight;
        stepIon(ion, runtime, Math.min(suggestedStep(ion, runtime), remaining));
        steps++;
    }
    return steps;
}

export function createIonState(mz, entry) {
    return {
        mz,
        chargeToMass: ELEMENTARY_CHARGE / massPerCharge(mz),
        x: entry.x,
        y: entry.y,
        z: entry.z,
        vx: entry.vx,
        vy: entry.vy,
        vz: entry.vz,
        startZ: entry.z,
        startVz: entry.vz,
        timeOfFlight: 0,
        status: "flying",
        launched: false,
        lossReason: null,
        arrivalX: null,
        arrivalY: null
    };
}

// Six-dimensional low-discrepancy sequence for the ion source. Pure random
// sampling leaves shot noise on every peak; spreading the entry conditions
// evenly resolves a peak profile from far fewer flights.
const SOURCE_DIMENSIONS = 6;
const R_SEQUENCE_ALPHAS = (() => {
    let root = 1.5;
    for (let iteration = 0; iteration < 60; iteration++) {
        const power = Math.pow(root, SOURCE_DIMENSIONS + 1);
        root -= (power - root - 1) / ((SOURCE_DIMENSIONS + 1) * power / root - 1);
    }
    return Array.from({ length: SOURCE_DIMENSIONS }, (_, k) => 1 / Math.pow(root, k + 1));
})();

function quasiRandom(sampleIndex, dimension) {
    return (0.5 + (sampleIndex + 1) * R_SEQUENCE_ALPHAS[dimension]) % 1;
}

// How far along the pusher the continuous beam has refilled since the last push,
// and what fraction of the arriving beam that represents. Nothing here is
// imposed: the beam streams in at its own speed and the pusher fires on its own
// schedule, so the mass discrimination of an orthogonal source falls out of the
// ratio of the two.
export function fillState(mz, config, runtime) {
    const velocity = beamVelocity(mz, config.beamEnergyEv);
    const travelled = velocity * runtime.packetWindow;
    const fillLength = Math.min(travelled, runtime.pusherLength);
    return {
        velocity,
        fillLength,
        dutyCycle: travelled > 0 ? fillLength / travelled : 0
    };
}

export function sampleEntryConditions(mz, config, runtime, sampleIndex = null) {
    const draw = sampleIndex === null
        ? () => Math.random()
        : (dimension) => quasiRandom(sampleIndex, dimension);

    const fill = fillState(mz, config, runtime);
    const sigma = thermalVelocitySigma(mz, config.beamTemperatureK);

    // Box-Muller turns two uniforms into the two thermal velocity components.
    const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, draw(3))));
    const angle = 2 * Math.PI * draw(4);
    const beamEnergy = Math.max(
        0.01, config.beamEnergyEv + config.beamEnergySpreadEv * (draw(5) - 0.5)
    );

    // The two thermal components are scaled separately so the resolution budget
    // can switch one off at a time. Both are 1 everywhere else: the beam has one
    // temperature, and these are a measurement tool rather than a physical knob.
    return {
        x: fill.fillLength * draw(0),
        y: (draw(1) - 0.5) * config.beamHeightMm * METRES_PER_MM,
        z: (config.beamOffsetMm + (draw(2) - 0.5) * config.beamThicknessMm) * METRES_PER_MM,
        vx: beamVelocity(mz, beamEnergy),
        vy: (config.thermalTransverseScale ?? 1) * sigma * radius * Math.sin(angle),
        vz: (config.thermalAxialScale ?? 1) * sigma * radius * Math.cos(angle)
    };
}

export function flyIon(mz, config, runtime, sampleIndex = null) {
    const ion = createIonState(mz, sampleEntryConditions(mz, config, runtime, sampleIndex));
    advanceIon(ion, runtime, Infinity);
    return ion;
}

// One ion launched from the centre of the fill window with no thermal spread. It
// fixes where the detector has to sit and supplies the reference flight time the
// readouts quote, and it is cheap enough to redo on every configuration change.
function referenceFlight(config, runtime) {
    const mz = config.detectorAlignMz;
    const fill = fillState(mz, config, runtime);
    const ion = createIonState(mz, {
        x: fill.fillLength / 2,
        y: 0,
        z: config.beamOffsetMm * METRES_PER_MM,
        vx: fill.velocity,
        vy: 0,
        vz: 0
    });
    // The detector position is not known yet, so the flight is stopped at the
    // plane rather than judged against a window that does not exist.
    const stub = { ...runtime, detectorCentre: 0, detectorLength: Infinity };
    advanceIon(ion, stub, Infinity);
    return {
        mz,
        landingX: ion.x,
        flightTimeSeconds: ion.timeOfFlight,
        status: ion.status
    };
}

// Flight time an ion of this m/z would need, scaled from the reference flight.
// Once the geometry and voltages are fixed the time of flight goes as the square
// root of m/z, so one flight calibrates the whole mass range.
export function expectedFlightTime(mz, runtime) {
    return runtime.reference.flightTimeSeconds * Math.sqrt(mz / runtime.reference.mz);
}
