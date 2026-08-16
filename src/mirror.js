// Field of a gridless two-stage ion mirror.
//
// The mirror is a stack of rectangular plates, so its potential varies along the
// flight axis z and across the aperture y while staying invariant along the beam
// drift direction x. Rather than assuming the textbook linear ramp, Laplace's
// equation is solved inside the aperture with the plate potentials imposed on the
// wall. The entrance lens and the sag of the on-axis field then appear on their
// own instead of being put in by hand.
//
// Laplace is linear in the applied voltages, so two basis solutions cover every
// tune: one with unit potential at the end of the retarding stage and one with
// unit potential on the back plate. Moving the mirror voltages is therefore free
// and only a change of geometry costs a solve.

import { MIRROR_GRID_TRANSVERSE_NODES, MIRROR_PRE_LENGTH_FACTOR } from "./constants.js";

const RELAXATION_FACTOR = 1.93;
const MAX_SWEEPS = 6000;
const CONVERGENCE_TOLERANCE = 1e-9;

// The solved region reaches upstream of the entrance because a gridless mirror
// leaks field into the drift tube; that leakage is the entrance lens.
function wallPotentialA(z, stage1Length, totalLength) {
    if (z <= 0) return 0;
    if (z < stage1Length) return z / stage1Length;
    return 1 - (z - stage1Length) / (totalLength - stage1Length);
}

function wallPotentialB(z, stage1Length, totalLength) {
    if (z <= stage1Length) return 0;
    return (z - stage1Length) / (totalLength - stage1Length);
}

function relax(potential, nodesZ, nodesY, dz, dy, isFixed) {
    const inverseDzSquared = 1 / (dz * dz);
    const inverseDySquared = 1 / (dy * dy);
    const denominator = 2 * (inverseDzSquared + inverseDySquared);

    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let largestChange = 0;
        for (let i = 1; i < nodesZ - 1; i++) {
            const base = i * nodesY;
            for (let j = 0; j < nodesY - 1; j++) {
                const index = base + j;
                if (isFixed[index]) continue;
                // The mirror is symmetric about the axis, so only half the
                // aperture is solved and y = 0 carries a reflecting boundary.
                const below = j === 0 ? potential[index + 1] : potential[index - 1];
                const updated = (
                    (potential[index + nodesY] + potential[index - nodesY]) * inverseDzSquared +
                    (potential[index + 1] + below) * inverseDySquared
                ) / denominator;
                const change = updated - potential[index];
                potential[index] += RELAXATION_FACTOR * change;
                const magnitude = Math.abs(change);
                if (magnitude > largestChange) largestChange = magnitude;
            }
        }
        if (largestChange < CONVERGENCE_TOLERANCE) return sweep + 1;
    }
    return MAX_SWEEPS;
}

function differentiate(potential, nodesZ, nodesY, dz, dy) {
    const fieldZ = new Float64Array(nodesZ * nodesY);
    const fieldY = new Float64Array(nodesZ * nodesY);

    for (let i = 0; i < nodesZ; i++) {
        for (let j = 0; j < nodesY; j++) {
            const index = i * nodesY + j;
            const forwardZ = i === nodesZ - 1 ? index : index + nodesY;
            const backwardZ = i === 0 ? index : index - nodesY;
            const spanZ = (i === 0 || i === nodesZ - 1 ? 1 : 2) * dz;
            fieldZ[index] = -(potential[forwardZ] - potential[backwardZ]) / spanZ;

            const forwardY = j === nodesY - 1 ? index : index + 1;
            const backwardY = j === 0 ? index + 1 : index - 1;
            const spanY = (j === nodesY - 1 ? 1 : 2) * dy;
            fieldY[index] = -(potential[forwardY] - potential[backwardY]) / spanY;
        }
    }
    return { fieldZ, fieldY };
}

function solveBasis(wallProfile, endPotential, geometry) {
    const { nodesZ, nodesY, dz, dy, startZ, stage1Length, totalLength } = geometry;
    const potential = new Float64Array(nodesZ * nodesY);
    const isFixed = new Uint8Array(nodesZ * nodesY);

    for (let i = 0; i < nodesZ; i++) {
        const z = startZ + i * dz;
        const wall = wallProfile(z, stage1Length, totalLength);
        const wallIndex = i * nodesY + (nodesY - 1);
        potential[wallIndex] = wall;
        isFixed[wallIndex] = 1;
        // A linear guess along y costs nothing and saves a few hundred sweeps.
        for (let j = 0; j < nodesY - 1; j++) {
            potential[i * nodesY + j] = wall * ((j / (nodesY - 1)) ** 2);
        }
    }
    for (let j = 0; j < nodesY; j++) {
        potential[j] = 0;
        isFixed[j] = 1;
        const lastIndex = (nodesZ - 1) * nodesY + j;
        potential[lastIndex] = endPotential;
        isFixed[lastIndex] = 1;
    }

    const sweeps = relax(potential, nodesZ, nodesY, dz, dy, isFixed);
    return { potential, sweeps, ...differentiate(potential, nodesZ, nodesY, dz, dy) };
}

const solutionCache = new Map();

// Solves the mirror for a geometry in metres and returns the two basis fields.
export function getMirrorSolution(stage1Length, stage2Length, halfHeight) {
    const key = [stage1Length, stage2Length, halfHeight]
        .map((value) => value.toFixed(6)).join("|");
    const cached = solutionCache.get(key);
    if (cached) return cached;

    const totalLength = stage1Length + stage2Length;
    const preLength = MIRROR_PRE_LENGTH_FACTOR * halfHeight;
    const nodesY = MIRROR_GRID_TRANSVERSE_NODES;
    const dy = halfHeight / (nodesY - 1);
    const spanZ = preLength + totalLength;
    const nodesZ = Math.max(64, Math.round(spanZ / dy) + 1);
    const dz = spanZ / (nodesZ - 1);

    const geometry = {
        nodesZ, nodesY, dz, dy,
        startZ: -preLength,
        stage1Length, totalLength, preLength, halfHeight
    };
    const started = Date.now();
    const basisA = solveBasis(wallPotentialA, 0, geometry);
    const basisB = solveBasis(wallPotentialB, 1, geometry);

    const solution = {
        ...geometry,
        basisA, basisB,
        solveMs: Date.now() - started,
        sweeps: Math.max(basisA.sweeps, basisB.sweeps)
    };
    solutionCache.set(key, solution);
    return solution;
}

// Collapses the two basis solutions onto one tune. Doing this once per
// configuration rather than once per force evaluation halves the work in the
// inner loop of every flight, which is where the whole simulation lives.
export function combineMirrorField(solution, stage1Voltage, backVoltage) {
    const size = solution.nodesZ * solution.nodesY;
    const potential = new Float64Array(size);
    const fieldZ = new Float64Array(size);
    const fieldY = new Float64Array(size);
    const { basisA, basisB } = solution;
    for (let index = 0; index < size; index++) {
        potential[index] = stage1Voltage * basisA.potential[index] +
            backVoltage * basisB.potential[index];
        fieldZ[index] = stage1Voltage * basisA.fieldZ[index] + backVoltage * basisB.fieldZ[index];
        fieldY[index] = stage1Voltage * basisA.fieldY[index] + backVoltage * basisB.fieldY[index];
    }
    return {
        potential, fieldZ, fieldY,
        nodesZ: solution.nodesZ, nodesY: solution.nodesY,
        dz: solution.dz, dy: solution.dy, startZ: solution.startZ,
        stage1Length: solution.stage1Length, totalLength: solution.totalLength,
        halfHeight: solution.halfHeight, preLength: solution.preLength,
        stage1Voltage, backVoltage
    };
}

// Bilinear weights for a point given in mirror-entrance coordinates.
function locate(field, z, absY, weights) {
    const columnReal = (z - field.startZ) / field.dz;
    const rowReal = absY / field.dy;
    const column = Math.max(0, Math.min(field.nodesZ - 2, Math.floor(columnReal)));
    const row = Math.max(0, Math.min(field.nodesY - 2, Math.floor(rowReal)));
    const fractionZ = Math.max(0, Math.min(1, columnReal - column));
    const fractionY = Math.max(0, Math.min(1, rowReal - row));
    weights.index = column * field.nodesY + row;
    weights.w00 = (1 - fractionZ) * (1 - fractionY);
    weights.w01 = (1 - fractionZ) * fractionY;
    weights.w10 = fractionZ * (1 - fractionY);
    weights.w11 = fractionZ * fractionY;
    return weights;
}

function interpolate(values, field, weights) {
    const { index, w00, w01, w10, w11 } = weights;
    return values[index] * w00 + values[index + 1] * w01 +
        values[index + field.nodesY] * w10 + values[index + field.nodesY + 1] * w11;
}

const weightScratch = { index: 0, w00: 0, w01: 0, w10: 0, w11: 0 };

// Electric field in V/m at a point measured from the mirror entrance plane.
export function mirrorFieldAt(field, z, y, out) {
    locate(field, z, Math.abs(y), weightScratch);
    out.z = interpolate(field.fieldZ, field, weightScratch);
    out.y = (y < 0 ? -1 : 1) * interpolate(field.fieldY, field, weightScratch);
    return out;
}

// Potential in volts, used for the equipotential overlay in the 3D view.
export function mirrorPotentialAt(field, z, y) {
    locate(field, z, Math.abs(y), weightScratch);
    return interpolate(field.potential, field, weightScratch);
}

// The wall potential the plates impose, for comparison with the solved axis.
export function idealWallPotential(field, z) {
    return field.stage1Voltage * wallPotentialA(z, field.stage1Length, field.totalLength) +
        field.backVoltage * wallPotentialB(z, field.stage1Length, field.totalLength);
}

// Field an ideal mirror would have: the plate ramp with no transverse component
// and no leakage past the entrance. Kept as a comparison, not as the default.
export function idealMirrorFieldAt(field, z, out) {
    const { stage1Length, totalLength } = field;
    out.y = 0;
    if (z <= 0 || z > totalLength) {
        out.z = 0;
    } else if (z < stage1Length) {
        out.z = -field.stage1Voltage / stage1Length;
    } else {
        out.z = -(field.backVoltage - field.stage1Voltage) / (totalLength - stage1Length);
    }
    return out;
}
