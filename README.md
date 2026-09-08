# Nebula Vision — AI Vision Inspection & Measurement

A single-page web app (no build step, no backend) that turns a phone browser's
camera into a rough dimensional-inspection instrument: capture → calibrate →
measure → inspect → fastener match → PDF report.

Open `index.html` over HTTPS or `localhost` (camera access requires a secure
context) — e.g. serve the folder with `npx serve`, push it to GitHub Pages, or
open it on a phone on the same Wi-Fi as a machine running a local server.

## Stack, and why

Plain HTML/CSS/JS, one external dependency (`jsPDF`, loaded from cdnjs for the
report export). No React/OpenCV.js/TensorFlow.

- **No ML model.** A real defect/fastener classifier needs training data this
  project doesn't have. Shipping a model that silently guesses would be
  dishonest about its accuracy. Instead the app uses classical, inspectable
  computer vision (background subtraction, Sobel edges, Moore-neighbour
  contour tracing, convex hull + Douglas-Peucker corner counting) and is
  explicit in the UI about every value's provenance: **measured** (you clicked
  it), **estimated** (silhouette heuristic), or **matched** (looked up against
  a standards table).
- **No OpenCV.js.** The image processing needed here (grayscale, Sobel,
  flood-fill segmentation, connected components, convex hull, polygon
  simplification) is a few hundred lines of plain JS and keeps the whole app
  a single static file with no WASM download.

## Calibration approach

The user places a reference of known size (ruler, credit card, coin, or a
custom object) in the same plane as the part and taps its two end points.
Pixel distance ÷ known length = a **pixels-per-millimetre scale for that
photo only.** Move the camera and the scale is invalid — the app forces a
fresh calibration per view rather than assuming distance stays constant, which
is the single biggest error source in phone-camera measurement. With more
than one calibrated view, the app reports the mean scale **and** its spread,
which is a direct signal of how much the capture distance drifted between
shots.

Clicks snap to the strongest nearby edge (a small Sobel patch computed around
the click point), which makes repeated calibration/measurement clicks land on
the same physical edge instead of a soft, human-judged approximation.

## Where AI/CV is used vs. where the user is asked to click

| Task | Method | Why |
|---|---|---|
| Overall bounding length/width, hole diameters | Automatic (background subtraction + connected components) | Cheap, and a bounding box is a low-risk automatic claim |
| Precise length/diameter/angle for a report | User clicks 2–3 points (snapped to edges) | A single silhouette can't reliably tell a designed edge from a shadow or a defect; the user's judgement plus edge-snap CV is more trustworthy than a fully automatic guess for anything that ends up on a PASS/FAIL report |
| Hex vs. round vs. rectangular shape guess | Automatic (convex hull, corner count, circularity) | Coarse classification is where silhouette analysis is actually reliable |
| Fastener nominal size | Automatic DB lookup, but only after the user has measured or confirmed a diameter/width-across-flats | Matching is arithmetic once a diameter is trusted; getting the diameter reliably is the hard part, so that step is user-verified |
| Defect flags | Automatic contour-curvature outlier detection + manual "flag an area" | Heuristic flags are a starting point for a human, not a verdict — hence no auto PASS/FAIL from this step alone |

## Error / uncertainty model

- Every measurement carries a `measured` / `estimated` tag, shown in the UI
  and the PDF — never a single unlabelled number.
- Multi-view: measurements with the same name across views are averaged and
  reported as `mean ± standard deviation`, not just the last value.
- Fastener matches carry a confidence percentage derived from how far the
  measured diameter is from the nearest standard nominal size.
- PASS/FAIL (in Report) only ever compares a **measured** (not estimated)
  dimension against a nominal ± a simplified ISO 2768 general-tolerance
  bracket, and reports "unknown" rather than guessing if no direct
  measurement exists.

## What this system measures reliably

- In-plane lengths, diameters, hole positions and angles, once calibrated
  with a same-plane reference and a roughly perpendicular camera — typically
  1–3% error at arm's length with a good reference and steady hands.
- Coarse shape classification (round / hex / rectangular / irregular).
- Nominal fastener size, given a clear, calibrated diameter or hex
  width-across-flats.

## What it does not measure reliably, and why

- **Thread pitch.** Threads are sub-millimetre; a normal phone photo doesn't
  resolve them. The app never claims a measured pitch — it only reports the
  DB's coarse-pitch value for the matched nominal size.
- **Anything out of the calibration plane** (depth, a tilted face, a feature
  on the far side of a curved part). Perspective distorts these and a single
  photo cannot correct for it; the app does not attempt a perspective
  correction and says so rather than silently producing a wrong number.
- **Lens distortion** is not calibrated per device (no per-phone barrel/
  pincushion correction), so accuracy degrades toward the frame edges — the
  UI asks users to keep the part centred.
- **Sub-millimetre surface defects** (hairline cracks, small burrs, surface
  finish) are generally below phone-camera resolution and lighting quality;
  the defect scan only catches gross silhouette irregularities (jagged
  edges, asymmetry), not surface condition.

## Multi-angle / video

Photo, video, and live modes all share one `getUserMedia` stream; "video"
additionally lets the user scrub a recording and pull a specific sharp frame
into the same pipeline as a photo. True continuous multi-frame fusion (e.g.
structure-from-motion) is out of scope for a 5-day take-home without a CV
library — instead, multiple independently-calibrated stills are combined by
averaging repeated named measurements, which is an honest, simple way to
reduce single-shot error without claiming 3D reconstruction the app doesn't
do.
