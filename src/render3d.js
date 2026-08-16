// 3D presentation of the analyser: the pusher stack, the flight tube, the
// gridless mirror, the detector and the ions themselves.
//
// The flight axis is about a metre long while the beam only wanders a few
// centimetres sideways, so the two transverse directions are drawn expanded.
// Without that the whole instrument would be a straight line and the V-shaped
// path an orthogonal analyser actually flies would be invisible.

import { SECONDS_PER_MICROSECOND } from "./constants.js";
import { fieldAt, regionOf, REGION_MIRROR } from "./physics.js";
import { mirrorPotentialAt } from "./mirror.js";
import { config, state, advanceLiveBeam } from "./state.js";

const AXIAL_PIXELS = 760;
const TRAIL_FADE_SEGMENTS = 4;
const MIRROR_PLATE_COUNT = 13;
const EQUIPOTENTIAL_LEVELS = 9;
const EQUIPOTENTIAL_SAMPLES = 15;
const PUSHER_ARROW_COLUMNS = 5;
const PUSHER_ARROW_ROWS = 3;
const PUSH_FLASH_SECONDS = 4e-6;

export const view = {
    rotationX: -0.5,
    rotationY: 0.0,
    invalidated: true
};

export function invalidateRender() {
    view.invalidated = true;
}

function getScales(runtime) {
    const axial = AXIAL_PIXELS / runtime.mirrorEnd;
    return { axial, transverse: axial * config.transverseExaggeration };
}

// Physical (z, x, y) in metres to the sketch's (X, Y, Z) in pixels.
function place(p, z, x, y, scales) {
    p.vertex(z * scales.axial, x * scales.transverse, y * scales.transverse);
}

function electrodeAlpha() {
    return Math.round((config.electrodeOpacity / 100) * 255);
}

// A plate spanning the beam direction and the aperture height, drawn at one
// point along the flight axis.
function drawPlate(p, z, xFrom, xTo, halfHeight, colour, scales) {
    p.push();
    p.noStroke();
    p.fill(colour);
    p.beginShape();
    place(p, z, xFrom, -halfHeight, scales);
    place(p, z, xTo, -halfHeight, scales);
    place(p, z, xTo, halfHeight, scales);
    place(p, z, xFrom, halfHeight, scales);
    p.endShape(p.CLOSE);
    p.pop();
}

function drawPusherStack(p, runtime, scales) {
    const alpha = electrodeAlpha();
    if (alpha <= 0) return;
    const xFrom = -0.004;
    const xTo = runtime.pusherLength + 0.004;
    const halfHeight = runtime.apertureHalfHeight;

    const sincePush = state.clock - state.lastPushAt;
    const flash = sincePush >= 0 && sincePush < PUSH_FLASH_SECONDS ? 1 : 0.25;

    drawPlate(p, 0, xFrom, xTo, halfHeight,
        p.color(180, 83, 9, alpha * (0.45 + 0.55 * flash)), scales);
    drawPlate(p, runtime.pusherGap, xFrom, xTo, halfHeight,
        p.color(120, 130, 140, alpha * 0.55), scales);
    drawPlate(p, runtime.stackEnd, xFrom, xTo, halfHeight,
        p.color(120, 130, 140, alpha * 0.4), scales);
}

function drawFlightTube(p, runtime, scales) {
    const xFrom = -0.01;
    const xTo = runtime.detectorCentre + runtime.detectorLength;
    const halfHeight = runtime.apertureHalfHeight;
    p.push();
    p.noFill();
    p.stroke(120, 132, 144, 90);
    p.strokeWeight(1);
    for (const y of [-halfHeight, halfHeight]) {
        p.beginShape();
        place(p, runtime.stackEnd, xFrom, y, scales);
        place(p, runtime.mirrorStart, xFrom, y, scales);
        place(p, runtime.mirrorStart, xTo, y, scales);
        place(p, runtime.stackEnd, xTo, y, scales);
        p.endShape(p.CLOSE);
    }
    for (const x of [xFrom, xTo]) {
        p.beginShape();
        place(p, runtime.stackEnd, x, -halfHeight, scales);
        place(p, runtime.mirrorStart, x, -halfHeight, scales);
        place(p, runtime.mirrorStart, x, halfHeight, scales);
        place(p, runtime.stackEnd, x, halfHeight, scales);
        p.endShape(p.CLOSE);
    }
    p.pop();
}

// Mirror plates coloured by the potential each one carries, so the two stages
// are visible as two different gradients.
function drawMirror(p, runtime, scales) {
    const alpha = electrodeAlpha();
    if (alpha <= 0) return;
    const xFrom = -0.01;
    const xTo = runtime.detectorCentre + runtime.detectorLength;
    const halfHeight = runtime.mirrorHalfHeight;
    const highest = Math.max(runtime.mirrorBackVoltage, runtime.mirrorStage1Voltage, 1);

    p.push();
    p.noFill();
    p.strokeWeight(2.5);
    for (let index = 0; index < MIRROR_PLATE_COUNT; index++) {
        const fraction = index / (MIRROR_PLATE_COUNT - 1);
        const z = runtime.mirrorStart + fraction * runtime.mirrorLength;
        const local = z - runtime.mirrorStart;
        const potential = local < runtime.stage1Length
            ? (local / runtime.stage1Length) * runtime.mirrorStage1Voltage
            : runtime.mirrorStage1Voltage +
            ((local - runtime.stage1Length) / runtime.stage2Length) *
            (runtime.mirrorBackVoltage - runtime.mirrorStage1Voltage);
        const shade = Math.max(0, Math.min(1, potential / highest));
        p.stroke(p.lerpColor(
            p.color(150, 158, 166, alpha),
            p.color(162, 59, 114, alpha),
            shade
        ));
        p.beginShape();
        place(p, z, xFrom, -halfHeight, scales);
        place(p, z, xTo, -halfHeight, scales);
        place(p, z, xTo, halfHeight, scales);
        place(p, z, xFrom, halfHeight, scales);
        p.endShape(p.CLOSE);
    }

    // Back plate drawn solid: it is the surface the ions must never reach.
    p.pop();
    drawPlate(p, runtime.mirrorEnd, xFrom, xTo, halfHeight,
        p.color(162, 59, 114, alpha), scales);
}

function drawDetector(p, runtime, scales) {
    const from = runtime.detectorCentre - runtime.detectorLength / 2;
    const to = runtime.detectorCentre + runtime.detectorLength / 2;
    drawPlate(p, runtime.stackEnd, from, to, runtime.detectorHalfHeight,
        p.color(40, 122, 69, 190), scales);
}

function drawAxes(p, runtime, scales) {
    p.push();
    p.strokeWeight(2);
    p.stroke(82, 96, 109, 150);
    p.line(0, 0, 0, runtime.mirrorEnd * scales.axial, 0, 0);
    p.stroke(180, 83, 9, 150);
    p.line(0, 0, 0, 0, (runtime.detectorCentre + runtime.detectorLength) * scales.transverse, 0);
    p.stroke(23, 105, 170, 130);
    p.line(0, 0, -runtime.apertureHalfHeight * scales.transverse,
        0, 0, runtime.apertureHalfHeight * scales.transverse);
    p.pop();
}

// Equipotentials of the solved mirror, drawn in the plane of the flight path.
// The bulge where they leak past the entrance plane is the entrance lens.
function drawMirrorEquipotentials(p, runtime, scales) {
    if (runtime.mirrorIdeal) return;
    const field = runtime.mirrorField;
    const highest = runtime.mirrorBackVoltage;
    const beamX = runtime.detectorCentre / 2;

    p.push();
    p.noFill();
    p.strokeWeight(1.2);
    for (let level = 1; level <= EQUIPOTENTIAL_LEVELS; level++) {
        const target = (level / (EQUIPOTENTIAL_LEVELS + 1)) * highest;
        p.stroke(162, 59, 114, 120);
        p.beginShape();
        let drew = false;
        for (let sample = 0; sample < EQUIPOTENTIAL_SAMPLES; sample++) {
            const y = -runtime.mirrorHalfHeight +
                (2 * runtime.mirrorHalfHeight * sample) / (EQUIPOTENTIAL_SAMPLES - 1);
            const found = findEquipotentialZ(field, target, y, runtime);
            if (found === null) continue;
            place(p, runtime.mirrorStart + found, beamX, y, scales);
            drew = true;
        }
        p.endShape();
        if (!drew) break;
    }
    p.pop();
}

// The potential rises monotonically along the mirror, so a scan followed by one
// linear interpolation locates a level without any root finding machinery.
function findEquipotentialZ(field, target, y, runtime) {
    const steps = 90;
    let previousZ = -runtime.mirrorPreLength;
    let previousValue = mirrorPotentialAt(field, previousZ, y);
    for (let step = 1; step <= steps; step++) {
        const z = -runtime.mirrorPreLength +
            ((runtime.mirrorLength + runtime.mirrorPreLength) * step) / steps;
        const value = mirrorPotentialAt(field, z, y);
        if ((previousValue - target) * (value - target) <= 0 && value !== previousValue) {
            return previousZ + ((target - previousValue) / (value - previousValue)) * (z - previousZ);
        }
        previousZ = z;
        previousValue = value;
    }
    return null;
}

function drawPusherField(p, runtime, scales) {
    const sincePush = state.clock - state.lastPushAt;
    const active = sincePush >= 0 && sincePush < PUSH_FLASH_SECONDS;
    const alpha = active ? 230 : 90;
    const scratch = { z: 0, y: 0 };

    p.push();
    p.strokeWeight(active ? 2.2 : 1.2);
    p.stroke(180, 83, 9, alpha);
    for (let column = 0; column < PUSHER_ARROW_COLUMNS; column++) {
        const x = (runtime.pusherLength * (column + 0.5)) / PUSHER_ARROW_COLUMNS;
        for (let row = 0; row < PUSHER_ARROW_ROWS; row++) {
            const z = (runtime.stackEnd * (row + 0.5)) / PUSHER_ARROW_ROWS;
            fieldAt(z, 0, runtime, scratch);
            if (scratch.z === 0) continue;
            const length = Math.min(0.02, 0.02 * (scratch.z / runtime.pusherField));
            p.line(
                z * scales.axial, x * scales.transverse, 0,
                (z + length) * scales.axial, x * scales.transverse, 0
            );
            p.line(
                (z + length) * scales.axial, x * scales.transverse, 0,
                (z + length * 0.6) * scales.axial, (x + 0.0015) * scales.transverse, 0
            );
            p.line(
                (z + length) * scales.axial, x * scales.transverse, 0,
                (z + length * 0.6) * scales.axial, (x - 0.0015) * scales.transverse, 0
            );
        }
    }
    p.pop();
}

// Trails are drawn as a few stroked polylines rather than one call per segment.
// A per-segment loop costs thousands of draw calls per frame once the trails
// fill up, which is enough to stall the whole sketch.
function drawTrail(p, ion, scales) {
    const pointCount = ion.trail.length;
    const segmentSize = Math.ceil(pointCount / TRAIL_FADE_SEGMENTS);
    const colour = p.color(ion.color);

    p.push();
    p.noFill();
    for (let segment = 0; segment < TRAIL_FADE_SEGMENTS; segment++) {
        const start = segment * segmentSize;
        const end = Math.min(pointCount - 1, start + segmentSize);
        if (end - start < 1) continue;
        const fade = (segment + 1) / TRAIL_FADE_SEGMENTS;
        colour.setAlpha(p.lerp(40, 230, fade));
        p.stroke(colour);
        p.strokeWeight(p.lerp(0.8, 2.0, fade));
        p.beginShape();
        for (let index = start; index <= end; index++) {
            const point = ion.trail[index];
            place(p, point.z, point.x, point.y, scales);
        }
        p.endShape();
    }
    p.pop();
}

function drawIons(p, runtime, scales) {
    for (const beamIon of state.beamIons) {
        p.push();
        p.translate(
            beamIon.z * scales.axial,
            beamIon.x * scales.transverse,
            beamIon.y * scales.transverse
        );
        p.noStroke();
        p.fill(p.color(beamIon.color));
        p.sphere(2.2);
        p.pop();
    }

    for (const ion of state.flightIons) {
        if (config.showTrails && ion.trail.length > 1) drawTrail(p, ion, scales);
        if (ion.status !== "flying") continue;
        p.push();
        p.translate(ion.z * scales.axial, ion.x * scales.transverse, ion.y * scales.transverse);
        p.noStroke();
        p.ambientMaterial(p.color(ion.color));
        p.fill(p.color(ion.color));
        p.sphere(3.2);
        p.pop();
    }

    for (const mark of state.impactMarks) {
        p.push();
        p.translate(mark.z * scales.axial, mark.x * scales.transverse, mark.y * scales.transverse);
        p.noStroke();
        p.fill(180, 35, 24, 150);
        p.sphere(3.6);
        p.pop();
    }
}

export function createSketch() {
    return (p) => {
        let canvasVisible = true;

        p.setup = () => {
            const holder = document.getElementById("p5-canvas-holder");
            const canvas = p.createCanvas(holder.clientWidth, holder.clientHeight, p.WEBGL);
            canvas.parent(holder);
            p.pixelDensity(1);
            canvas.style("touch-action", "none");

            if ("IntersectionObserver" in window) {
                const observer = new IntersectionObserver((entries) => {
                    canvasVisible = entries[0]?.isIntersecting ?? true;
                    if (canvasVisible) invalidateRender();
                });
                observer.observe(holder);
            }

            window.addEventListener("resize", () => {
                p.resizeCanvas(holder.clientWidth, holder.clientHeight);
                invalidateRender();
            });

            // p5 only applies wheel zoom from inside orbitControl during draw();
            // this sketch skips frames while paused, so wheel input is handled
            // directly to keep zooming responsive in every state.
            holder.addEventListener("wheel", (event) => {
                if (event.target?.closest?.("button, input, select")) return;
                event.preventDefault();
                event.stopPropagation();

                const renderer = p._renderer;
                const camera = renderer?._curCamera || renderer?.curCamera;
                if (!camera) return;

                const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? holder.clientHeight : 1;
                const deltaPixels = event.deltaY * unit;
                if (!Number.isFinite(deltaPixels) || deltaPixels === 0) return;

                const radius = Math.hypot(
                    camera.eyeX - camera.centerX,
                    camera.eyeY - camera.centerY,
                    camera.eyeZ - camera.centerZ
                );
                if (!Number.isFinite(radius) || radius === 0) return;

                const requested = radius * Math.exp(deltaPixels * (event.ctrlKey ? 0.006 : 0.003));
                const nextRadius = Math.min(9000, Math.max(90, requested));
                const scale = nextRadius / radius;
                p.camera(
                    camera.centerX + (camera.eyeX - camera.centerX) * scale,
                    camera.centerY + (camera.eyeY - camera.centerY) * scale,
                    camera.centerZ + (camera.eyeZ - camera.centerZ) * scale,
                    camera.centerX, camera.centerY, camera.centerZ,
                    camera.upX, camera.upY, camera.upZ
                );
                invalidateRender();
            }, { capture: true, passive: false });
        };

        p.draw = () => {
            if (state.isPlaying) advanceFrame();
            if (!canvasVisible) return;

            const runtime = state.runtime;
            const scales = getScales(runtime);

            p.background(236, 240, 244);
            p.ambientLight(70, 74, 80);
            p.directionalLight(255, 246, 224, -0.4, 0.4, -1.0);
            p.directionalLight(110, 148, 186, 0.7, -0.25, 0.45);
            p.orbitControl(1, 1, 0.1);

            p.rotateX(view.rotationX);
            p.rotateY(view.rotationY);
            p.translate(
                -(runtime.mirrorEnd * scales.axial) / 2,
                -((runtime.detectorCentre + runtime.detectorLength) / 2) * scales.transverse,
                0
            );

            if (config.showGrid) drawAxes(p, runtime, scales);
            if (config.showField) {
                drawMirrorEquipotentials(p, runtime, scales);
                drawPusherField(p, runtime, scales);
            }
            drawFlightTube(p, runtime, scales);
            drawIons(p, runtime, scales);
            drawDetector(p, runtime, scales);
            drawPusherStack(p, runtime, scales);
            drawMirror(p, runtime, scales);

            view.invalidated = false;
        };
    };
}

// One rendered frame advances the instrument by the requested slice of real
// flight time, so the playback control is a slow-motion factor and nothing else.
export function advanceFrame() {
    const seconds = (config.playbackMicrosecondsPerSecond * SECONDS_PER_MICROSECOND) / 60;
    advanceLiveBeam(seconds);
}

export { regionOf, REGION_MIRROR };
