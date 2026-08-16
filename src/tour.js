// Guided tour: a stepped lesson that drives the controls while it explains.

export const TOUR_STEPS = [
    {
        title: "A beam that never stops",
        body: `<p>Everything upstream of a time-of-flight analyser is <em>continuous</em>: the source sprays ions, the guide cools them, and they arrive as a steady stream. A TOF analyser is the opposite &mdash; it can only measure one packet at a time, released at a known instant.</p>
               <p>The stream you can see is drifting left to right through the pusher, along the beam axis. It has a few electronvolts of energy and it never stops arriving. The whole design problem of an orthogonal analyser is what to do about that.</p>`,
        apply: (api) => {
            api.setMode("continuous");
            api.setConfig({ playbackMicrosecondsPerSecond: 6, showField: false, showTrails: true });
            api.setSample("peptides");
            api.setTab("tab-setup");
        }
    },
    {
        title: "Push sideways",
        body: `<p>The trick is to accelerate the ions at right angles to the way they were already going. A slab of the beam is kicked along the flight axis at several kilovolts, while the few electronvolts of sideways motion it already had are left completely untouched.</p>
               <p>That is why the flight path is a <strong>V</strong>: every ion keeps drifting along the beam axis for the whole flight, so the detector sits well off to one side. Watch a push happen and follow the packet.</p>`,
        apply: (api) => {
            api.setConfig({ playbackMicrosecondsPerSecond: 8, showField: true });
            api.setTab("tab-setup");
        }
    },
    {
        title: "Most of the beam is thrown away",
        body: `<p>Between one push and the next, the beam keeps flowing straight through the pusher and out the far side. Only what happens to be inside the aperture at the instant the pusher fires is used.</p>
               <p>Light ions travel fastest along the beam axis, so they flush through soonest and lose the most. The sample is now a wide mass range &mdash; check the duty cycle column in the species list and watch it climb with m/z. Nothing imposes this: the simulation just counts what was in the box.</p>`,
        apply: (api) => {
            api.setMode("continuous");
            api.setConfig({ playbackMicrosecondsPerSecond: 20, showField: false });
            api.setSample("wideRange");
            api.setTab("tab-setup");
        }
    },
    {
        title: "The packet is not a point",
        body: `<p>The slab that gets pushed has thickness. An ion nearer the pusher plate falls through more voltage than one nearer the grid, so it leaves with more energy &mdash; here about five per cent more across a millimetre of beam.</p>
               <p>The mirror has been deliberately detuned. Look at the focus curve: a millimetre of starting position turns into <em>hundreds of nanoseconds</em> of arrival time, against a peak that should be two nanoseconds wide. Uncorrected, this alone would cap resolution near a hundred.</p>`,
        apply: (api) => {
            api.setConfig({ mirrorBackFraction: 1.24 });
            api.setFocusAxis("position");
            api.setTab("tab-focus");
            api.measureFocus();
        }
    },
    {
        title: "What the mirror is for",
        body: `<p>A two-stage ion mirror sends faster ions deeper, so they take a longer path and come back at the same moment as the slower ones. Get both mirror voltages right and the correction is good to <em>second order</em> in energy.</p>
               <p>The tune has just been searched for and applied. The same focus curve now spans a fraction of a nanosecond &mdash; the energy spread has been reduced by four orders of magnitude. Scan the mirror tune to see how narrow that optimum is: a few thousandths either way and it is gone.</p>`,
        apply: (api) => {
            api.setTab("tab-focus");
            api.autoTune();
        }
    },
    {
        title: "Turn-around time: the wall",
        body: `<p>With the energy spread focused away, what is left? An ion drifting <em>backwards</em> when the pusher fires has to be stopped and turned around first, and it arrives late by exactly that delay. The spread is thermal, so it never goes away.</p>
               <p>The budget breaks the peak into one term per source spread, each measured by switching the others off. Turn-around dominates everything else by a wide margin. Raise the pusher field or cool the beam to shrink it &mdash; nothing else will.</p>`,
        apply: (api) => {
            api.setTab("tab-budget");
            api.measureBudget();
        }
    },
    {
        title: "A spectrum, flown",
        body: `<p>Now record one. Every ion in this trace was flown through the pusher, the drift and the mirror; the arrival times were histogrammed, given the width of a detector pulse and counted with real statistics.</p>
               <p>Nothing about the peak shape or width was drawn in. Notice the peaks get wider at higher m/z while the resolution stays roughly constant &mdash; both the flight time and the turn-around spread scale as the square root of mass, so their ratio does not.</p>`,
        apply: (api) => {
            api.setSample("calibrant");
            api.setTab("tab-spectrum");
            api.acquire();
        }
    },
    {
        title: "Why the mass scale needs calibrating",
        body: `<p>Flight time goes as the square root of m/z. That would make a one-point calibration exact &mdash; except that cables, the amplifier and the trigger all add a fixed delay, and a fixed delay is the one thing a square root cannot absorb.</p>
               <p>The offset term has been switched off. Watch the residuals fan out to hundreds of parts per million, worst at low mass where the delay is the largest share of the flight. Switch it back on and they collapse to a couple of ppm.</p>`,
        apply: (api) => {
            api.setConfig({ calibrationUseOffset: false });
            api.setTab("tab-spectrum");
            api.rebuild();
        }
    },
    {
        title: "The detector has opinions too",
        body: `<p>The analyser is only half the instrument. The digitiser bins time, the detector smears each ion into a pulse of finite width, and summing a finite number of pushes leaves counting noise.</p>
               <p>The bin width and pulse width have been made deliberately coarse and the number of summed transients cut right down. The peaks are wider and noisier &mdash; and the analyser has not changed at all. These controls re-bin the ions already flown, so they respond instantly.</p>`,
        apply: (api) => {
            api.setConfig({
                calibrationUseOffset: true,
                binWidthPs: 1500, singleIonResponseNs: 2.5, transientCount: 25
            });
            api.setTab("tab-spectrum");
            api.rebuild();
        }
    },
    {
        title: "Two ions, one mass",
        body: `<p>The sample is now a pair of ions with <em>identical</em> m/z and different shapes. No mass analyser can tell them apart, and the spectrum shows one peak.</p>
               <p>Switch to TIMS mode. Ions are held where the gas drag balances the electric field, so the field needed to hold one depends on its mobility; lowering the field releases them in order, bulkiest first. The mobility map separates what the mass scale cannot.</p>`,
        apply: (api) => {
            api.setConfig({ binWidthPs: 250, singleIonResponseNs: 0.9, transientCount: 400 });
            api.setSample("isomers");
            api.setMode("tims");
            api.setTab("tab-mobility");
            api.acquire();
        }
    },
    {
        title: "Over to you",
        body: `<p>Everything is unlocked. A few things worth trying:</p>
               <ul>
                 <li>Load the resolution challenge and try to split m/z 1000.000 from 1000.090.</li>
                 <li>Drop the beam temperature towards zero and watch the turn-around term vanish.</li>
                 <li>Switch the mirror to the ideal linear ramp and re-tune &mdash; the real gridless field is not the same instrument.</li>
                 <li>Move the detector along the beam axis until the heavy ions fall off the end of it.</li>
                 <li>Turn on digitiser saturation and watch a strong peak go flat topped.</li>
               </ul>`,
        apply: (api) => {
            api.setTab("tab-setup");
        }
    }
];

export function createTourController(api) {
    const overlay = document.getElementById("tour-overlay");
    const titleNode = document.getElementById("tour-title");
    const bodyNode = document.getElementById("tour-body");
    const countNode = document.getElementById("tour-step-count");
    const dotsNode = document.getElementById("tour-dots");
    const previousButton = document.getElementById("btn-tour-prev");
    const nextButton = document.getElementById("btn-tour-next");

    let currentStep = 0;

    function render() {
        const step = TOUR_STEPS[currentStep];
        countNode.innerText = `Step ${currentStep + 1} of ${TOUR_STEPS.length}`;
        titleNode.innerText = step.title;
        bodyNode.innerHTML = step.body;
        previousButton.disabled = currentStep === 0;
        nextButton.innerText = currentStep === TOUR_STEPS.length - 1 ? "Finish" : "Next";

        dotsNode.innerHTML = "";
        TOUR_STEPS.forEach((_, index) => {
            const dot = document.createElement("span");
            dot.className = index === currentStep ? "tour-dot active" : "tour-dot";
            dotsNode.appendChild(dot);
        });

        step.apply(api);
    }

    function open() {
        overlay.hidden = false;
        currentStep = 0;
        render();
    }

    function close() {
        overlay.hidden = true;
    }

    previousButton.addEventListener("click", () => {
        if (currentStep === 0) return;
        currentStep--;
        render();
    });
    nextButton.addEventListener("click", () => {
        if (currentStep === TOUR_STEPS.length - 1) {
            close();
            return;
        }
        currentStep++;
        render();
    });
    document.getElementById("btn-tour-close").addEventListener("click", close);

    return { open, close };
}
