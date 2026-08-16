// Trapped ion mobility front end.
//
// In a TIMS tunnel the drift gas pushes ions forward and an electric field
// gradient holds them back, so an ion parks where the two balance: K*E = v_gas.
// Lowering the field releases ions in order of mobility, and because the balance
// is an equality rather than a fit, the elution field of a species is simply the
// gas velocity divided by its mobility. Large ions have low mobility, need a high
// field to be held, and therefore come out first, which is the opposite of a
// drift tube.

import {
    STANDARD_PRESSURE_MBAR,
    STANDARD_TEMPERATURE_K,
    TIMS_PRESSURE_MBAR,
    TIMS_TEMPERATURE_K,
    METRES_PER_CM,
    SECONDS_PER_MILLISECOND
} from "./constants.js";

// Reduced mobility is quoted at standard temperature and pressure. Its
// definition gives the mobility at the conditions inside the tunnel directly.
export function mobilityInTunnel(oneOverK0) {
    const reducedMobilitySI = (1 / oneOverK0) * METRES_PER_CM * METRES_PER_CM;
    return reducedMobilitySI *
        (STANDARD_PRESSURE_MBAR / TIMS_PRESSURE_MBAR) *
        (TIMS_TEMPERATURE_K / STANDARD_TEMPERATURE_K);
}

// Field at which the gas drag and the electric force cancel, in V/cm.
export function elutionField(oneOverK0, gasVelocity) {
    return gasVelocity / mobilityInTunnel(oneOverK0) * METRES_PER_CM;
}

export function rampFieldAt(fraction, config) {
    return config.timsRampStartVPerCm +
        (config.timsRampEndVPerCm - config.timsRampStartVPerCm) * fraction;
}

// Where in the ramp a species comes out, as a fraction from 0 to 1. Values
// outside that range mean the species is never held, or never released.
export function elutionFraction(oneOverK0, config) {
    const field = elutionField(oneOverK0, config.timsGasVelocity);
    const span = config.timsRampStartVPerCm - config.timsRampEndVPerCm;
    if (span === 0) return null;
    return (config.timsRampStartVPerCm - field) / span;
}

export function elutionTimeSeconds(oneOverK0, config) {
    const fraction = elutionFraction(oneOverK0, config);
    return fraction === null ? null : fraction * config.timsRampMs * SECONDS_PER_MILLISECOND;
}

// Fraction of a species that is inside the pusher at a given point in the ramp.
// The mobility peak is treated as a Gaussian of the stated width, which is what
// a measured mobility peak looks like.
export function elutionWeight(oneOverK0, rampFraction, config) {
    const centre = elutionFraction(oneOverK0, config);
    if (centre === null || centre < 0 || centre > 1) return 0;
    const widthFraction = config.timsPacketWidthMs / Math.max(1e-6, config.timsRampMs);
    const sigma = widthFraction / 2.3548;
    if (sigma <= 0) return Math.abs(rampFraction - centre) < 1e-9 ? 1 : 0;
    const offset = (rampFraction - centre) / sigma;
    return Math.exp(-0.5 * offset * offset);
}

// A species is only usable if the ramp actually spans its elution field.
export function elutionStatus(oneOverK0, config) {
    const field = elutionField(oneOverK0, config.timsGasVelocity);
    if (field > config.timsRampStartVPerCm) return "not trapped";
    if (field < config.timsRampEndVPerCm) return "held past ramp";
    return "eluted";
}
