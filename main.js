// Orthogonal-acceleration TOF 3D Physics Simulator - entry point.

import { applySample } from "./src/state.js";
import { createSketch } from "./src/render3d.js";
import { setupUI } from "./src/ui.js";

function initApp() {
    applySample("peptides");
    const instance = new p5(createSketch());
    setupUI(instance);
}

window.addEventListener("DOMContentLoaded", initApp);
