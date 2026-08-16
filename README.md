# oaTOF-Sim

Interactive 3D simulation of an orthogonal-acceleration time-of-flight mass
analyser, built for teaching how the instrument actually works rather than for
showing a pretty animation.

## Try it out!
https://desperadus.github.io/oaTOF-Sim/

## Features

- 3D view of the pusher stack, flight tube, mirror and detector, with the
  V-shaped flight path an orthogonal analyser really flies
- Solved mirror equipotentials drawn in the flight plane, bulging out through the
  gridless entrance
- Focus explorer: arrival time against one starting coordinate at a time
- Mirror tune curve on a log scale, plus a two-variable auto-tune
- Resolution budget measured by silencing the source and restoring one spread at
  a time, with the quadrature sum shown next to the peak actually measured
- Mass calibration workbench with per-calibrant ppm residuals
- Detector and digitiser model: bin width, pulse width, transients, saturation
- Mobility map against 1/K₀, and preset mixtures including mobility isomers
- An eleven-step guided tour that drives the controls while it explains

## Honest limitations

- The mirror wall carries a plain linear potential ramp. Real gridless mirrors
  tune many electrodes individually to flatten the field across the aperture, so
  the transverse term in the budget here is larger than a well-engineered mirror
  would give. It is a fair consequence of the simple geometry, not a bug.
- The pusher and accelerator are treated as gridded, with uniform fields between
  planes.
- The peak width measurement is a histogram FWHM and is accurate to a couple of
  per cent at the sample sizes used.

## Running

```bash
npm install
npm run dev
```

