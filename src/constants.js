// Physical constants (SI) and simulation-wide defaults.

export const ELEMENTARY_CHARGE = 1.602176634e-19;   // C
export const ATOMIC_MASS_UNIT = 1.66053906660e-27;  // kg
export const BOLTZMANN_CONSTANT = 1.380649e-23;     // J/K

export const METRES_PER_MM = 1e-3;
export const METRES_PER_CM = 1e-2;
export const SECONDS_PER_MICROSECOND = 1e-6;
export const SECONDS_PER_NANOSECOND = 1e-9;
export const SECONDS_PER_MILLISECOND = 1e-3;
export const SECONDS_PER_PICOSECOND = 1e-12;

// Reduced mobility K0 is quoted at standard temperature and pressure, so the
// mobility at the conditions inside the TIMS tunnel follows from its definition.
export const STANDARD_PRESSURE_MBAR = 1013.25;
export const STANDARD_TEMPERATURE_K = 273.15;
export const TIMS_PRESSURE_MBAR = 2.6;
export const TIMS_TEMPERATURE_K = 305;

// The flight path is broken into regions with very different field strengths.
// The pusher, the accelerator and the drift all have a field that is constant
// across the region, so a step taken inside one of them is exact however long it
// is and only needs to be short enough to draw a smooth trail. The mirror is the
// one place where the field genuinely varies from point to point.
export const ACCEL_STEPS_PER_STACK = 24;
export const MIRROR_STEPS_PER_LENGTH = 1600;
export const DRIFT_STEPS_PER_LENGTH = 6;
export const MAX_STEPS_PER_FLIGHT = 200000;

// A step that would cross into another region is cut short so it lands on the
// boundary, then nudged just past it. Without the nudge an ion sitting exactly on
// a boundary cannot tell which region it belongs to.
export const BOUNDARY_OVERSHOOT = 1e-9;

// How far the mirror solution is extended upstream of the entrance. The field
// leaking out of a gridless mirror decays over roughly the aperture half-height,
// so the domain has to reach far enough that cutting it off costs nothing.
export const MIRROR_PRE_LENGTH_FACTOR = 5;
export const MIRROR_GRID_TRANSVERSE_NODES = 33;

export const ION_PALETTE = [
    "#1769aa", "#9a6700", "#a23b72", "#287a45",
    "#b45309", "#655281", "#0f766e", "#b42318"
];

export const PLOT_BACKGROUND = "#ffffff";
export const PLOT_AXIS = "#52606d";
export const PLOT_GRID = "rgba(100, 116, 139, 0.16)";
export const PLOT_TEXT_DIM = "#6b7785";
export const COLOR_SIGNAL = "#1769aa";
export const COLOR_MIRROR = "#a23b72";
export const COLOR_PUSHER = "#b45309";
export const COLOR_DETECTOR = "#287a45";
export const COLOR_WARNING = "#b42318";
