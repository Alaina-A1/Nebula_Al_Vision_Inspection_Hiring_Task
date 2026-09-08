/* =====================================================================
   NEBULA VISION — AI-assisted inspection & measurement
   Vanilla JS, no build step. Runs entirely in the browser.
   ===================================================================== */

(function(){
"use strict";

/* ---------------------------------------------------------------------
   0. CONSTANTS / REFERENCE DATA
   --------------------------------------------------------------------- */

const STEPS = [
  {id:'capture',   label:'Capture'},
  {id:'calibrate', label:'Calibrate'},
  {id:'measure',   label:'Measure'},
  {id:'inspect',   label:'Inspect'},
  {id:'fasteners', label:'Fasteners'},
  {id:'report',    label:'Report'},
];

// ISO metric coarse-thread bolts: nominal dia (mm) -> pitch, hex width-across-flats
const METRIC_BOLTS = [
  {size:'M3', d:3,  pitch:0.5,  waf:5.5},
  {size:'M4', d:4,  pitch:0.7,  waf:7},
  {size:'M5', d:5,  pitch:0.8,  waf:8},
  {size:'M6', d:6,  pitch:1.0,  waf:10},
  {size:'M8', d:8,  pitch:1.25, waf:13},
  {size:'M10',d:10, pitch:1.5,  waf:16},
  {size:'M12',d:12, pitch:1.75, waf:18},
  {size:'M14',d:14, pitch:2.0,  waf:21},
  {size:'M16',d:16, pitch:2.0,  waf:24},
  {size:'M18',d:18, pitch:2.5,  waf:27},
  {size:'M20',d:20, pitch:2.5,  waf:30},
  {size:'M22',d:22, pitch:2.5,  waf:34},
  {size:'M24',d:24, pitch:3.0,  waf:36},
];
// UNC imperial bolts: nominal dia (inch), TPI, hex WAF (inch)
const IMPERIAL_BOLTS = [
  {size:'1/4-20',  d:0.250, tpi:20, waf:0.4375},
  {size:'5/16-18', d:0.3125,tpi:18, waf:0.5},
  {size:'3/8-16',  d:0.375, tpi:16, waf:0.5625},
  {size:'7/16-14', d:0.4375,tpi:14, waf:0.625},
  {size:'1/2-13',  d:0.5,   tpi:13, waf:0.75},
  {size:'5/8-11',  d:0.625, tpi:11, waf:0.9375},
  {size:'3/4-10',  d:0.75,  tpi:10, waf:1.125},
];

const REFERENCE_PRESETS = [
  {id:'ruler',   label:'Ruler / tape (mark 100 mm span)', mm:100},
  {id:'vernier', label:'Vernier caliper scale (mark 50 mm span)', mm:50},
  {id:'card',    label:'Credit / ID card (long edge)', mm:85.6},
  {id:'coin1',   label:'Coin — US quarter (diameter)', mm:24.26},
  {id:'coin2',   label:'Coin — 1 Rupee (diameter)', mm:25},
  {id:'a4',      label:'A4 paper (short edge)', mm:210},
  {id:'custom',  label:'Custom reference (enter length)', mm:null},
];

// Simplified ISO 2768-1 general tolerance table (mm), by nominal size bracket
const ISO2768 = {
  brackets:[0.5,3,6,30,120,400,1000,2000],
  classes:{
    f:[0.05,0.05,0.1,0.15,0.2,0.3,0.5],
    m:[0.1,0.1,0.2,0.3,0.5,0.8,1.2],
    c:[0.2,0.3,0.5,0.8,1.2,2.0,3.0],
    v:[NaN,0.5,1.0,1.5,2.5,4.0,6.0],
  }
};

/* ---------------------------------------------------------------------
   1. STATE
   --------------------------------------------------------------------- */

const state = {
  step: 'capture',
  stream: null,
  captureMode: 'photo',      // photo | video | live
  recorder: null,
  recordedChunks: [],
  recordedURL: null,
  views: [],                 // array of view objects
  activeView: -1,
  componentType: '',
  activeMeasureTool: null,   // 'length' | 'circle' | 'angle' | null
  pendingPoints: [],         // points collected for the active tool
  calRefPreset: 'ruler',
  calCustomLength: 100,
  isFastener: false,
  fastenerFamily: 'hex',
  fastenerSystem: 'metric',
  fastenerMatch: null,
  tolNominal: '',
  tolClass: 'm',
  flagMode: false,
};

function newView(canvas){
  return {
    id: 'v'+Date.now()+Math.floor(Math.random()*1000),
    label: 'View ' + (state.views.length+1),
    canvas: canvas,                 // native-res offscreen canvas
    w: canvas.width, h: canvas.height,
    calibration: null,              // {scale(px/mm), refLabel, p1,p2, knownMm}
    measurements: [],               // {id,name,type,points,pxLen,mm,source,confidence}
    auto: null,                     // computed lazily
    defects: [],
  };
}

/* ---------------------------------------------------------------------
   2. DOM REFERENCES
   --------------------------------------------------------------------- */

const el = {
  stepper: document.getElementById('stepper'),
  viewport: document.getElementById('viewport'),
  video: document.getElementById('video'),
  frameCanvas: document.getElementById('frameCanvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  emptyMsg: document.getElementById('emptyMsg'),
  viewportHint: document.getElementById('viewportHint'),
  stageControls: document.getElementById('stageControls'),
  filmstrip: document.getElementById('filmstrip'),
  panelScroll: document.getElementById('panelScroll'),
  statusScale: document.getElementById('statusScale'),
  statusViews: document.getElementById('statusViews'),
  statusMsg: document.getElementById('statusMsg'),
  componentLabel: document.getElementById('componentLabel'),
  infoBtn: document.getElementById('infoBtn'),
  infoModal: document.getElementById('infoModal'),
  infoClose: document.getElementById('infoClose'),
};

const octx = el.overlayCanvas.getContext('2d');
const fctx = el.frameCanvas.getContext('2d');

/* ---------------------------------------------------------------------
   3. STEPPER / NAVIGATION
   --------------------------------------------------------------------- */

function renderStepper(){
  el.stepper.innerHTML = '';
  STEPS.forEach((s,i)=>{
    const btn = document.createElement('button');
    const done = stepIsDone(s.id);
    btn.className = (state.step===s.id?'active ':'') + (done?'done':'');
    btn.disabled = !stepUnlocked(s.id);
    btn.innerHTML = `<span class="n">${done?'&#10003;':i+1}</span>${s.label}`;
    btn.onclick = ()=>goStep(s.id);
    el.stepper.appendChild(btn);
  });
}

function stepUnlocked(id){
  if(id==='capture') return true;
  if(state.views.length===0) return false;
  if(id==='calibrate') return true;
  if(id==='measure') return true; // measuring without calibration allowed (px only)
  if(id==='inspect') return true;
  if(id==='fasteners') return true;
  if(id==='report') return true;
  return true;
}
function stepIsDone(id){
  if(id==='capture') return state.views.length>0;
  if(id==='calibrate') return state.views.some(v=>v.calibration);
  if(id==='measure') return state.views.some(v=>v.measurements.length>0);
  if(id==='inspect') return state.views.some(v=>v.auto && v.auto.defectScanRun);
  if(id==='fasteners') return !!state.fastenerMatch;
  return false;
}

function goStep(id){
  if(state.step==='capture' && id!=='capture' && state.stream){
    stopCamera();
  }
  state.step = id;
  state.activeMeasureTool = null;
  state.pendingPoints = [];
  state.flagMode = false;
  renderStepper();
  renderStageControls();
  renderPanel();
  renderViewport();
}

/* ---------------------------------------------------------------------
   4. CAMERA
   --------------------------------------------------------------------- */

async function startCamera(){
  stopCamera();
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}},
      audio:false
    });
    state.stream = stream;
    el.video.srcObject = stream;
    setStatus('Camera live.');
  }catch(err){
    setStatus('Camera unavailable: '+err.message);
  }
  renderStageControls();
  renderViewport();
}

function stopCamera(){
  if(state.stream){
    state.stream.getTracks().forEach(t=>t.stop());
    state.stream = null;
  }
  el.video.style.display='none';
}

function grabFrameToCanvas(){
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if(!vw || !vh){ setStatus('Camera not ready yet — wait a moment and try again.'); return null; }
  const c = document.createElement('canvas');
  c.width = vw; c.height = vh;
  c.getContext('2d').drawImage(el.video,0,0,vw,vh);
  return c;
}

function capturePhoto(){
  const c = grabFrameToCanvas();
  if(!c) return;
  addView(c);
}

function addView(canvas){
  const v = newView(canvas);
  runAutoAnalysis(v);
  state.views.push(v);
  state.activeView = state.views.length-1;
  updateStatus();
  renderStepper();
  renderFilmstrip();
  renderPanel();
  renderStageControls();
  renderViewport();
  setStatus('Captured '+v.label+'. Camera is still live — capture more angles, or move on.');
}

function toggleRecording(){
  if(state.recorder && state.recorder.state==='recording'){
    state.recorder.stop();
    return;
  }
  if(!state.stream){ setStatus('Start the camera first.'); return; }
  state.recordedChunks = [];
  let mime = 'video/webm';
  if(!MediaRecorder.isTypeSupported(mime)) mime = '';
  try{
    state.recorder = new MediaRecorder(state.stream, mime?{mimeType:mime}:undefined);
  }catch(e){ setStatus('Recording not supported on this browser.'); return; }
  state.recorder.ondataavailable = e=>{ if(e.data.size>0) state.recordedChunks.push(e.data); };
  state.recorder.onstop = ()=>{
    const blob = new Blob(state.recordedChunks,{type:mime||'video/webm'});
    state.recordedURL = URL.createObjectURL(blob);
    renderStageControls();
    setStatus('Recording stopped. Scrub to a sharp frame and use it.');
  };
  state.recorder.start();
  setStatus('Recording…');
  renderStageControls();
}

function setMode(mode){
  state.captureMode = mode;
  state.recordedURL = null;
  renderStageControls();
}

/* ---------------------------------------------------------------------
   5. IMAGE PROCESSING — grayscale, sobel, background segmentation
   --------------------------------------------------------------------- */

function downscale(canvas, maxW){
  const scale = Math.min(1, maxW/canvas.width);
  const w = Math.max(1,Math.round(canvas.width*scale));
  const h = Math.max(1,Math.round(canvas.height*scale));
  const c = document.createElement('canvas');
  c.width=w; c.height=h;
  c.getContext('2d').drawImage(canvas,0,0,w,h);
  return {canvas:c, w, h, factor: canvas.width/w};
}

function toGray(imgData){
  const {data,width,height} = imgData;
  const g = new Float32Array(width*height);
  for(let i=0,p=0;i<data.length;i+=4,p++){
    g[p] = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
  }
  return g;
}

function sobel(gray,w,h){
  const mag = new Float32Array(w*h);
  const gx = [-1,0,1,-2,0,2,-1,0,1];
  const gy = [-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let sx=0, sy=0, k=0;
      for(let j=-1;j<=1;j++){
        for(let i=-1;i<=1;i++,k++){
          const v = gray[(y+j)*w+(x+i)];
          sx += v*gx[k]; sy += v*gy[k];
        }
      }
      mag[y*w+x] = Math.sqrt(sx*sx+sy*sy);
    }
  }
  return mag;
}

function sampleBackground(imgData){
  const {data,width,height} = imgData;
  let r=0,g=0,b=0,n=0;
  const ring = 3;
  for(let x=0;x<width;x++){
    for(let yy=0;yy<ring;yy++){
      addPx(x,yy); addPx(x,height-1-yy);
    }
  }
  for(let y=0;y<height;y++){
    for(let xx=0;xx<ring;xx++){
      addPx(xx,y); addPx(width-1-xx,y);
    }
  }
  function addPx(x,y){
    const i=(y*width+x)*4;
    r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++;
  }
  return {r:r/n, g:g/n, b:b/n};
}

function buildMasks(imgData, bg, thresholdPct){
  const {data,width,height} = imgData;
  const diff = new Uint8Array(width*height);
  const maxDist = Math.sqrt(3*255*255);
  for(let p=0, i=0; i<data.length; i+=4, p++){
    const dr=data[i]-bg.r, dg=data[i+1]-bg.g, db=data[i+2]-bg.b;
    const dist = Math.sqrt(dr*dr+dg*dg+db*db)/maxDist*100;
    diff[p] = dist > thresholdPct ? 1 : 0;
  }
  // flood fill background-like area reachable from border
  const reached = new Uint8Array(width*height);
  const qx=[],qy=[];
  function tryPush(x,y){
    if(x<0||y<0||x>=width||y>=height) return;
    const p=y*width+x;
    if(diff[p]===0 && !reached[p]){ reached[p]=1; qx.push(x); qy.push(y); }
  }
  for(let x=0;x<width;x++){ tryPush(x,0); tryPush(x,height-1); }
  for(let y=0;y<height;y++){ tryPush(0,y); tryPush(width-1,y); }
  let head=0;
  while(head<qx.length){
    const x=qx[head], y=qy[head]; head++;
    tryPush(x+1,y); tryPush(x-1,y); tryPush(x,y+1); tryPush(x,y-1);
  }
  return {diff, reached, width, height};
}

function labelComponents(mask, width, height, want){
  // want(p) => boolean, whether pixel p qualifies for this label pass
  const seen = new Uint8Array(width*height);
  const comps = [];
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const p=y*width+x;
      if(seen[p] || !want(p)) continue;
      // BFS
      const pts=[]; const qx=[x],qy=[y]; seen[p]=1;
      let head=0, minx=x,maxx=x,miny=y,maxy=y;
      while(head<qx.length){
        const cx=qx[head], cy=qy[head]; head++;
        pts.push([cx,cy]);
        if(cx<minx)minx=cx; if(cx>maxx)maxx=cx; if(cy<miny)miny=cy; if(cy>maxy)maxy=cy;
        const nbrs=[[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
        for(const [nx,ny] of nbrs){
          if(nx<0||ny<0||nx>=width||ny>=height) continue;
          const np=ny*width+nx;
          if(!seen[np] && want(np)){ seen[np]=1; qx.push(nx); qy.push(ny); }
        }
      }
      comps.push({pts, area:pts.length, bbox:{x:minx,y:miny,w:maxx-minx+1,h:maxy-miny+1}});
    }
  }
  return comps;
}

// Moore-neighbour boundary trace on a binary mask (1 = foreground), returns ordered contour points
function traceBoundary(inMask, width, height, bbox){
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  function isFg(x,y){
    if(x<0||y<0||x>=width||y>=height) return false;
    return inMask[y*width+x]===1;
  }
  // find start: first fg pixel in bbox, scanning
  let sx=-1, sy=-1;
  outer:
  for(let y=bbox.y; y<bbox.y+bbox.h; y++){
    for(let x=bbox.x; x<bbox.x+bbox.w; x++){
      if(isFg(x,y)){ sx=x; sy=y; break outer; }
    }
  }
  if(sx<0) return [];
  const contour=[[sx,sy]];
  let cx=sx, cy=sy, backDir=6; // came from "up" direction initially (arbitrary)
  const maxSteps = width*height*2;
  let steps=0;
  while(steps++<maxSteps){
    let found=false;
    for(let k=0;k<8;k++){
      const dir=(backDir+1+k)%8;
      const nx=cx+dirs[dir][0], ny=cy+dirs[dir][1];
      if(isFg(nx,ny)){
        cx=nx; cy=ny;
        backDir=(dir+4)%8; // opposite direction, for next search start
        contour.push([cx,cy]);
        found=true;
        break;
      }
    }
    if(!found) break;
    if(cx===sx && cy===sy && contour.length>2) break;
  }
  return contour;
}

function convexHull(points){
  // points: [[x,y],...]  Andrew's monotone chain
  const pts = points.slice().sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
  if(pts.length<3) return pts;
  function cross(o,a,b){ return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  const lower=[];
  for(const p of pts){
    while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for(let i=pts.length-1;i>=0;i--){
    const p=pts[i];
    while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function simplifyPolygon(points, epsilon){
  if(points.length<3) return points;
  function perpDist(p,a,b){
    const dx=b[0]-a[0], dy=b[1]-a[1];
    const len = Math.hypot(dx,dy) || 1e-6;
    return Math.abs((p[0]-a[0])*dy - (p[1]-a[1])*dx)/len;
  }
  function rdp(pts){
    if(pts.length<3) return pts;
    let maxD=0, idx=0;
    for(let i=1;i<pts.length-1;i++){
      const d = perpDist(pts[i], pts[0], pts[pts.length-1]);
      if(d>maxD){ maxD=d; idx=i; }
    }
    if(maxD>epsilon){
      const left = rdp(pts.slice(0,idx+1));
      const right = rdp(pts.slice(idx));
      return left.slice(0,-1).concat(right);
    }
    return [pts[0], pts[pts.length-1]];
  }
  // treat as closed polygon: break at farthest pair for stability
  return rdp(points.concat([points[0]])).slice(0,-1);
}

/* ---------------------------------------------------------------------
   6. AUTO ANALYSIS PIPELINE (runs once per captured view)
   --------------------------------------------------------------------- */

function runAutoAnalysis(view){
  try{
    const {canvas:proc, w, h, factor} = downscale(view.canvas, 340);
    const ctx = proc.getContext('2d');
    const imgData = ctx.getImageData(0,0,w,h);
    const bg = sampleBackground(imgData);
    const {diff, reached} = buildMasks(imgData, bg, 14);

    // foreground components = diff==1
    const fgComps = labelComponents(diff, w, h, p=>diff[p]===1);
    fgComps.sort((a,b)=>b.area-a.area);
    const main = fgComps[0];

    let result = {
      procW:w, procH:h, factor, bg,
      backgroundUniform: estimateBgUniformity(imgData, bg),
      shapeGuess:'unknown', cornerCount:0, circularity:0,
      bboxFull:null, area:0, perimeter:0,
      holes:[], hullFull:[], contourFull:[],
      defectScanRun:false, defectSegments:[], asymmetryPct:null,
      insufficientArea:false,
    };

    if(!main || main.area < (w*h*0.01)){
      result.insufficientArea = true;
      view.auto = result;
      return;
    }

    // mask restricted to main component for hole + boundary detection
    const mainMask = new Uint8Array(w*h);
    for(const [x,y] of main.pts) mainMask[y*w+x]=1;

    // holes: background-coloured (diff==0) & not reached from border, inside bbox
    const holeCandidateMask = new Uint8Array(w*h);
    for(let i=0;i<w*h;i++) holeCandidateMask[i] = (diff[i]===0 && !reached[i]) ? 1 : 0;
    const holeComps = labelComponents(holeCandidateMask, w, h, p=>holeCandidateMask[p]===1)
      .filter(c=>c.area>=3 && c.area < main.area*0.5);

    const contour = traceBoundary(mainMask, w, h, main.bbox);
    const hull = contour.length>8 ? convexHull(contour) : convexHull(main.pts);
    const simplified = simplifyPolygon(hull, Math.max(2, 0.02*Math.max(main.bbox.w, main.bbox.h)));

    const perimeter = contour.length || estimatePerimeter(mainMask,w,h,main.bbox);
    const circularity = Math.min(1, (4*Math.PI*main.area)/(perimeter*perimeter || 1));

    let shapeGuess='irregular';
    const nCorners = simplified.length;
    const aspect = main.bbox.w/main.bbox.h;
    if(circularity>0.80){ shapeGuess='round'; }
    else if(nCorners>=5 && nCorners<=7 && aspect>0.8 && aspect<1.25){ shapeGuess='hex'; }
    else if(nCorners>=4 && nCorners<=5){ shapeGuess='rectangular'; }

    result.shapeGuess = shapeGuess;
    result.cornerCount = nCorners;
    result.circularity = circularity;
    result.area = main.area;
    result.perimeter = perimeter;
    result.bboxFull = { x:main.bbox.x*factor, y:main.bbox.y*factor, w:main.bbox.w*factor, h:main.bbox.h*factor };
    result.hullFull = simplified.map(([x,y])=>[x*factor,y*factor]);
    result.contourFull = contour.filter((_,i)=>i%3===0).map(([x,y])=>[x*factor,y*factor]);
    result.holes = holeComps.map(hc=>{
      const cx = hc.pts.reduce((s,p)=>s+p[0],0)/hc.pts.length;
      const cy = hc.pts.reduce((s,p)=>s+p[1],0)/hc.pts.length;
      const r = Math.sqrt(hc.area/Math.PI);
      return { cx:cx*factor, cy:cy*factor, rPx:r*factor };
    }).sort((a,b)=>b.rPx-a.rPx).slice(0,8);

    // symmetry heuristic (left-right, about bbox vertical centreline)
    result.asymmetryPct = estimateAsymmetry(mainMask, w, h, main.bbox);

    view.auto = result;
  }catch(err){
    console.error('auto analysis failed', err);
    view.auto = {failed:true, insufficientArea:true};
  }
}

function estimatePerimeter(mask,w,h,bbox){
  let n=0;
  for(let y=bbox.y;y<bbox.y+bbox.h;y++){
    for(let x=bbox.x;x<bbox.x+bbox.w;x++){
      const p=y*w+x;
      if(mask[p]!==1) continue;
      if(x===0||y===0||x===w-1||y===h-1||mask[p-1]!==1||mask[p+1]!==1||mask[p-w]!==1||mask[p+w]!==1){ n++; }
    }
  }
  return n;
}

function estimateAsymmetry(mask,w,h,bbox){
  const cx = bbox.x + bbox.w/2;
  let total=0, mismatched=0;
  for(let y=bbox.y;y<bbox.y+bbox.h;y++){
    for(let x=bbox.x;x<bbox.x+bbox.w;x++){
      const mx = Math.round(2*cx - x);
      if(mx<0||mx>=w) continue;
      total++;
      const a = mask[y*w+x]===1;
      const b = mask[y*w+mx]===1;
      if(a!==b) mismatched++;
    }
  }
  return total? Math.round(mismatched/total*100) : null;
}

function estimateBgUniformity(imgData, bg){
  const {data,width,height} = imgData;
  let sum=0,n=0;
  const ring=3;
  for(let x=0;x<width;x+=4){
    for(let yy=0;yy<ring;yy++){ sum+=dist(x,yy); sum+=dist(x,height-1-yy); n+=2; }
  }
  function dist(x,y){
    const i=(y*width+x)*4;
    const dr=data[i]-bg.r, dg=data[i+1]-bg.g, db=data[i+2]-bg.b;
    return Math.sqrt(dr*dr+dg*dg+db*db);
  }
  const avg = sum/n;
  return avg < 40; // fairly uniform
}

/* ---------------------------------------------------------------------
   7. EDGE SNAPPING (local Sobel patch around a click, full resolution)
   --------------------------------------------------------------------- */

function snapToEdge(view, x, y, radius){
  const c = view.canvas;
  const rx0 = Math.max(0, Math.round(x-radius)), ry0 = Math.max(0, Math.round(y-radius));
  const rx1 = Math.min(c.width, Math.round(x+radius)), ry1 = Math.min(c.height, Math.round(y+radius));
  const pw = rx1-rx0, ph = ry1-ry0;
  if(pw<3||ph<3) return {x,y};
  const ctx = c.getContext('2d');
  const patch = ctx.getImageData(rx0,ry0,pw,ph);
  const gray = toGray(patch);
  const mag = sobel(gray,pw,ph);
  let best=-1, bx=x-rx0, by=y-ry0;
  for(let yy=1;yy<ph-1;yy++){
    for(let xx=1;xx<pw-1;xx++){
      const d = Math.hypot(xx-(x-rx0), yy-(y-ry0));
      if(d>radius) continue;
      const score = mag[yy*pw+xx] - d*3; // prefer strong edge close to click
      if(score>best){ best=score; bx=xx; by=yy; }
    }
  }
  if(best < 25) return {x,y}; // no clear edge nearby, keep raw click
  return {x: rx0+bx, y: ry0+by};
}

/* ---------------------------------------------------------------------
   8. MEASUREMENT MATH
   --------------------------------------------------------------------- */

function dist(p1,p2){ return Math.hypot(p2.x-p1.x, p2.y-p1.y); }

function circleFrom3(p1,p2,p3){
  const ax=p1.x, ay=p1.y, bx=p2.x, by=p2.y, cx=p3.x, cy=p3.y;
  const d = 2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by));
  if(Math.abs(d)<1e-6) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy)+(bx*bx+by*by)*(cy-ay)+(cx*cx+cy*cy)*(ay-by))/d;
  const uy = ((ax*ax+ay*ay)*(cx-bx)+(bx*bx+by*by)*(ax-cx)+(cx*cx+cy*cy)*(bx-ax))/d;
  const r = Math.hypot(ax-ux, ay-uy);
  return {cx:ux, cy:uy, r};
}

function angleFrom3(vertex,a,b){
  const v1x=a.x-vertex.x, v1y=a.y-vertex.y;
  const v2x=b.x-vertex.x, v2y=b.y-vertex.y;
  const dot=v1x*v2x+v1y*v2y;
  const m1=Math.hypot(v1x,v1y), m2=Math.hypot(v2x,v2y);
  if(m1<1e-6||m2<1e-6) return 0;
  let c = dot/(m1*m2);
  c = Math.max(-1,Math.min(1,c));
  return Math.acos(c)*180/Math.PI;
}

function pxToMm(view, px){
  if(!view.calibration) return null;
  return px / view.calibration.scale;
}

function activeScaleLabel(view){
  if(!view || !view.calibration) return 'not calibrated';
  return view.calibration.scale.toFixed(2)+' px/mm';
}

/* ---------------------------------------------------------------------
   9. FASTENER MATCHING
   --------------------------------------------------------------------- */

function matchFastener(){
  const view = currentView();
  if(!view) return null;
  // find best diameter-like measurement: prefer 'diameter' type, else 'length' named "shaft" etc.
  const diaMeas = view.measurements.filter(m=>m.type==='circle' && m.mm);
  const lenMeas = view.measurements.filter(m=>m.type==='length' && m.mm);
  let dMm = null, source='diameter tool';
  if(diaMeas.length){ dMm = diaMeas[diaMeas.length-1].mm; }
  else if(view.auto && view.auto.shapeGuess==='round' && view.calibration){
    const r = Math.sqrt(view.auto.area/Math.PI) * view.auto.factor;
    dMm = pxToMm(view, r*2);
    source='auto silhouette (low confidence)';
  }
  let wafMm = null;
  if(view.auto && view.auto.shapeGuess==='hex' && view.calibration){
    const bbox = view.auto.bboxFull;
    wafMm = pxToMm(view, Math.min(bbox.w,bbox.h));
  }
  const table = state.fastenerSystem==='metric' ? METRIC_BOLTS : IMPERIAL_BOLTS;
  const unit = state.fastenerSystem==='metric' ? 'mm' : 'in';
  const measured = wafMm ? {value:wafMm, key:'waf', label:'width across flats'} :
                   dMm ? {value: state.fastenerSystem==='metric'?dMm:dMm/25.4, key:'d', label:'shaft diameter'} : null;
  if(!measured) return null;

  let best=null, bestDiff=Infinity;
  for(const row of table){
    const ref = measured.key==='waf' ? row.waf : row.d;
    const diff = Math.abs(ref-measured.value);
    if(diff<bestDiff){ bestDiff=diff; best=row; }
  }
  if(!best) return null;
  const ref = measured.key==='waf'? best.waf : best.d;
  const pctErr = Math.abs(ref-measured.value)/ref*100;
  const confidence = Math.max(5, Math.round(100 - pctErr*9));

  return {
    family: state.fastenerFamily,
    system: state.fastenerSystem,
    size: best.size,
    pitchOrTpi: state.fastenerSystem==='metric' ? best.pitch+' mm pitch (coarse, DB match)' : best.tpi+' TPI (UNC, DB match)',
    measuredValue: measured.value.toFixed(3)+' '+unit,
    measuredBasis: measured.label,
    confidence,
    unit,
  };
}

/* ---------------------------------------------------------------------
   10. DEFECT DETECTION (contour curvature + symmetry heuristics)
   --------------------------------------------------------------------- */

function runDefectScan(view){
  if(!view.auto || view.auto.insufficientArea){ view.defects=[]; view.auto = view.auto||{}; view.auto.defectScanRun=true; return; }
  const contour = view.auto.contourFull;
  const defects = [];
  const k = Math.max(2, Math.floor(contour.length/40));
  const curvatures = [];
  for(let i=0;i<contour.length;i++){
    const a = contour[(i-k+contour.length)%contour.length];
    const b = contour[i];
    const c = contour[(i+k)%contour.length];
    const ang = angleFrom3({x:b[0],y:b[1]},{x:a[0],y:a[1]},{x:c[0],y:c[1]});
    curvatures.push(180-ang); // deviation from straight
  }
  const mean = curvatures.reduce((s,v)=>s+v,0)/(curvatures.length||1);
  const variance = curvatures.reduce((s,v)=>s+(v-mean)*(v-mean),0)/(curvatures.length||1);
  const std = Math.sqrt(variance);
  const thresh = mean + 2*std;
  let run=[];
  for(let i=0;i<curvatures.length;i++){
    if(curvatures[i]>thresh && curvatures[i]>35){
      run.push(contour[i]);
    } else if(run.length){
      if(run.length>=3) defects.push(segmentToDefect(run,'Irregular / jagged edge'));
      run=[];
    }
  }
  if(run.length>=3) defects.push(segmentToDefect(run,'Irregular / jagged edge'));

  if(view.auto.asymmetryPct!==null && view.auto.asymmetryPct>28){
    defects.push({type:'asymmetry', desc:`Left-right silhouette mismatch ~${view.auto.asymmetryPct}% — check for bending or deformation`, bbox:view.auto.bboxFull});
  }
  view.defects = defects.concat(view.defects.filter(d=>d.manual));
  view.auto.defectScanRun = true;
}

function segmentToDefect(pts,label){
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const bbox = {x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs)-Math.min(...xs)+6, h:Math.max(...ys)-Math.min(...ys)+6};
  return {type:'edge', desc:label, bbox};
}

/* ---------------------------------------------------------------------
   11. VIEWPORT RENDERING / COORDINATE MAPPING
   --------------------------------------------------------------------- */

function currentView(){ return state.views[state.activeView] || null; }

let fitRect = {dx:0,dy:0,dw:0,dh:0};

function resizeCanvases(){
  const rect = el.viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio||1;
  [el.frameCanvas, el.overlayCanvas].forEach(cv=>{
    cv.style.width = rect.width+'px';
    cv.style.height = rect.height+'px';
    cv.width = Math.round(rect.width*dpr);
    cv.height = Math.round(rect.height*dpr);
  });
  fctx.setTransform(dpr,0,0,dpr,0,0);
  octx.setTransform(dpr,0,0,dpr,0,0);
  computeFitRect();
}

function computeFitRect(){
  const view = currentView();
  const rect = el.viewport.getBoundingClientRect();
  if(!view){ fitRect={dx:0,dy:0,dw:rect.width,dh:rect.height}; return; }
  const cw = rect.width, ch = rect.height;
  const scale = Math.min(cw/view.w, ch/view.h);
  const dw = view.w*scale, dh = view.h*scale;
  fitRect = { dx:(cw-dw)/2, dy:(ch-dh)/2, dw, dh, scale };
}

function imgToCanvas(x,y){
  return { x: fitRect.dx + x*fitRect.scale, y: fitRect.dy + y*fitRect.scale };
}
function canvasToImg(x,y){
  return { x: (x-fitRect.dx)/fitRect.scale, y: (y-fitRect.dy)/fitRect.scale };
}

function renderViewport(){
  const showLive = state.step==='capture' && !!state.stream;
  el.video.style.display = showLive ? 'block' : 'none';
  el.frameCanvas.style.display = showLive ? 'none' : 'block';
  el.overlayCanvas.style.display = showLive ? 'none' : 'block';

  const view = currentView();
  computeFitRect();
  const rect = el.viewport.getBoundingClientRect();
  fctx.clearRect(0,0,rect.width,rect.height);
  octx.clearRect(0,0,rect.width,rect.height);

  if(showLive){ el.emptyMsg.style.display='none'; return; }

  if(!view){
    el.emptyMsg.style.display='flex';
    return;
  }
  el.emptyMsg.style.display='none';
  fctx.drawImage(view.canvas, fitRect.dx, fitRect.dy, fitRect.dw, fitRect.dh);
  drawOverlay(view);
}

function drawOverlay(view){
  octx.save();
  // auto silhouette (subtle) — show on measure/inspect/fasteners steps
  if(['measure','inspect','fasteners'].includes(state.step) && view.auto && !view.auto.insufficientArea){
    if(view.auto.hullFull && view.auto.hullFull.length>2){
      octx.beginPath();
      view.auto.hullFull.forEach(([x,y],i)=>{
        const c = imgToCanvas(x,y);
        i===0 ? octx.moveTo(c.x,c.y) : octx.lineTo(c.x,c.y);
      });
      octx.closePath();
      octx.strokeStyle='rgba(10,95,214,0.55)';
      octx.lineWidth=1.5;
      octx.setLineDash([5,4]);
      octx.stroke();
      octx.setLineDash([]);
    }
    view.auto.holes.forEach(h=>{
      const c = imgToCanvas(h.cx,h.cy);
      const r = h.rPx*fitRect.scale;
      octx.beginPath(); octx.arc(c.x,c.y,r,0,Math.PI*2);
      octx.strokeStyle='rgba(201,122,18,0.85)'; octx.lineWidth=1.5; octx.stroke();
    });
  }

  // defects
  if(state.step==='inspect' && view.defects && view.defects.length){
    view.defects.forEach(d=>{
      const c1 = imgToCanvas(d.bbox.x, d.bbox.y);
      const c2 = imgToCanvas(d.bbox.x+d.bbox.w, d.bbox.y+d.bbox.h);
      octx.strokeStyle='rgba(181,43,43,0.9)'; octx.lineWidth=2;
      octx.strokeRect(c1.x,c1.y,c2.x-c1.x,c2.y-c1.y);
      octx.fillStyle='rgba(181,43,43,0.12)';
      octx.fillRect(c1.x,c1.y,c2.x-c1.x,c2.y-c1.y);
    });
  }

  // calibration line
  if(state.step==='calibrate'){
    if(view.calibration){
      drawLine(view.calibration.p1, view.calibration.p2, '#0a5fd6', view.calibration.knownMm.toFixed(1)+' mm ref');
    }
    state.pendingPoints.forEach((p,i)=>drawHandle(p, i===0?'A':'B'));
    if(state.pendingPoints.length===2){
      drawLine(state.pendingPoints[0], state.pendingPoints[1], '#c97a12', 'pending');
    }
  }

  // measurements
  if(state.step==='measure' || state.step==='report'){
    view.measurements.forEach(m=>{
      const color = m.source==='measured' ? '#137a3d' : '#c97a12';
      if(m.type==='length'){
        drawLine(m.points[0], m.points[1], color, labelFor(m));
      } else if(m.type==='circle'){
        const c = imgToCanvas(m.circle.cx, m.circle.cy);
        const r = m.circle.r*fitRect.scale;
        octx.beginPath(); octx.arc(c.x,c.y,r,0,Math.PI*2);
        octx.strokeStyle=color; octx.lineWidth=2; octx.stroke();
        m.points.forEach(p=>drawHandle(p,''));
        drawTextAt(c.x, c.y-r-6, labelFor(m), color);
      } else if(m.type==='angle'){
        drawLine(m.points[0], m.points[1], color, '');
        drawLine(m.points[0], m.points[2], color, '');
        drawTextAt(imgToCanvas(m.points[0].x,m.points[0].y).x+10, imgToCanvas(m.points[0].x,m.points[0].y).y+14, labelFor(m), color);
      }
    });
    state.pendingPoints.forEach(p=>drawHandle(p,''));
  }

  octx.restore();

  function drawLine(p1,p2,color,label){
    const c1=imgToCanvas(p1.x,p1.y), c2=imgToCanvas(p2.x,p2.y);
    octx.beginPath(); octx.moveTo(c1.x,c1.y); octx.lineTo(c2.x,c2.y);
    octx.strokeStyle=color; octx.lineWidth=2; octx.stroke();
    drawHandle(p1,''); drawHandle(p2,'');
    if(label) drawTextAt((c1.x+c2.x)/2, (c1.y+c2.y)/2-8, label, color);
  }
  function drawHandle(p,tag){
    const c = imgToCanvas(p.x,p.y);
    octx.beginPath(); octx.arc(c.x,c.y,5,0,Math.PI*2);
    octx.fillStyle='#fff'; octx.fill();
    octx.lineWidth=2; octx.strokeStyle='#14181c'; octx.stroke();
    if(tag){ octx.fillStyle='#14181c'; octx.font='11px Roboto Mono'; octx.fillText(tag, c.x+7, c.y-7); }
  }
  function drawTextAt(x,y,text,color){
    if(!text) return;
    octx.font='700 12px Roboto Mono';
    const wtxt = octx.measureText(text).width;
    octx.fillStyle='rgba(255,255,255,0.92)';
    octx.fillRect(x-wtxt/2-4, y-13, wtxt+8, 17);
    octx.fillStyle=color;
    octx.textAlign='center';
    octx.fillText(text, x, y);
    octx.textAlign='left';
  }
}

function labelFor(m){
  if(m.mm!=null) return m.name+': '+m.mm.toFixed(2)+' mm';
  return m.name+': '+Math.round(m.pxLen)+' px';
}

/* ---------------------------------------------------------------------
   12. CLICK HANDLING ON OVERLAY
   --------------------------------------------------------------------- */

el.overlayCanvas.addEventListener('click', (e)=>{
  const view = currentView();
  if(!view) return;
  const rect = el.overlayCanvas.getBoundingClientRect();
  const cx = e.clientX-rect.left, cy = e.clientY-rect.top;
  const img = canvasToImg(cx,cy);
  if(img.x<0||img.y<0||img.x>view.w||img.y>view.h) return;
  const snapped = snapToEdge(view, img.x, img.y, 14);

  if(state.step==='calibrate'){
    state.pendingPoints.push(snapped);
    if(state.pendingPoints.length>2) state.pendingPoints.shift();
    renderViewport();
    renderPanel();
    return;
  }
  if(state.step==='measure' && state.activeMeasureTool){
    state.pendingPoints.push(snapped);
    const need = state.activeMeasureTool==='length' ? 2 : state.activeMeasureTool==='circle' ? 3 : 3;
    if(state.pendingPoints.length>=need){
      commitMeasurement(view, state.activeMeasureTool, state.pendingPoints.slice(0,need));
      state.pendingPoints=[];
    }
    renderViewport();
    renderPanel();
    return;
  }
  if(state.step==='inspect' && state.flagMode){
    state.pendingPoints.push(img);
    if(state.pendingPoints.length===2){
      const [a,b] = state.pendingPoints;
      view.defects.push({type:'manual', manual:true, desc:'User-flagged area', bbox:{
        x:Math.min(a.x,b.x), y:Math.min(a.y,b.y), w:Math.abs(a.x-b.x), h:Math.abs(a.y-b.y)
      }});
      state.pendingPoints=[];
      state.flagMode=false;
      renderPanel();
    }
    renderViewport();
    return;
  }
});

function commitMeasurement(view, tool, pts){
  let m;
  if(tool==='length'){
    const pxLen = dist(pts[0],pts[1]);
    m = { id:'m'+Date.now(), name:nextMeasureName(view,'Length'), type:'length', points:pts,
      pxLen, mm: pxToMm(view,pxLen), source:'measured' };
  } else if(tool==='circle'){
    const circ = circleFrom3(pts[0],pts[1],pts[2]);
    if(!circ){ setStatus('Those 3 points are almost collinear — pick points further apart around the circle.'); return; }
    m = { id:'m'+Date.now(), name:nextMeasureName(view,'Diameter'), type:'circle', points:pts, circle:circ,
      pxLen: circ.r*2, mm: pxToMm(view, circ.r*2), source:'measured' };
  } else if(tool==='angle'){
    const ang = angleFrom3(pts[0],pts[1],pts[2]);
    m = { id:'m'+Date.now(), name:nextMeasureName(view,'Angle'), type:'angle', points:pts,
      pxLen:null, mm:null, angleDeg:ang, source:'measured' };
  }
  if(m) view.measurements.push(m);
  updateStatus();
  renderStepper();
}

function nextMeasureName(view, base){
  const n = view.measurements.filter(m=>m.name.startsWith(base)).length+1;
  return base+' '+n;
}

/* ---------------------------------------------------------------------
   13. STAGE CONTROLS (capture toolbar)
   --------------------------------------------------------------------- */

function renderStageControls(){
  const c = el.stageControls;
  c.innerHTML = '';
  if(state.step!=='capture'){
    // simple prev/next
    const idx = STEPS.findIndex(s=>s.id===state.step);
    const prev = mkBtn('&larr; Back', 'btn', ()=>goStep(STEPS[Math.max(0,idx-1)].id));
    const next = mkBtn('Next &rarr;', 'btn primary', ()=>goStep(STEPS[Math.min(STEPS.length-1,idx+1)].id));
    next.disabled = idx>=STEPS.length-1;
    c.appendChild(prev); c.appendChild(spacerEl()); c.appendChild(next);
    return;
  }

  const modeToggle = document.createElement('div');
  modeToggle.className='mode-toggle';
  ['photo','video','live'].forEach(m=>{
    const b = document.createElement('button');
    b.textContent = m[0].toUpperCase()+m.slice(1);
    b.className = state.captureMode===m?'active':'';
    b.onclick = ()=>setMode(m);
    modeToggle.appendChild(b);
  });
  c.appendChild(modeToggle);

  const camOn = !!state.stream;
  if(!camOn){
    c.appendChild(mkBtn('Start camera', 'btn primary', startCamera));
  } else {
    if(state.captureMode==='photo' || state.captureMode==='live'){
      c.appendChild(mkBtn('Capture', 'btn primary', capturePhoto));
    }
    if(state.captureMode==='video'){
      const recording = state.recorder && state.recorder.state==='recording';
      c.appendChild(mkBtn(recording?'Stop recording':'Record', 'btn '+(recording?'rec':'primary'), toggleRecording));
    }
    c.appendChild(mkBtn('Stop camera', 'btn', ()=>{ stopCamera(); renderStageControls(); renderViewport(); }));
  }
  c.appendChild(spacerEl());
  if(state.views.length){
    c.appendChild(mkBtn('Next: Calibrate &rarr;', 'btn primary', ()=>goStep('calibrate')));
  }

  if(state.captureMode==='video' && state.recordedURL){
    const wrap = document.createElement('div');
    wrap.style.cssText='display:flex;align-items:center;gap:8px;width:100%;margin-top:8px;';
    const vid = document.createElement('video');
    vid.src = state.recordedURL; vid.controls=true; vid.style.cssText='height:36px;';
    const useBtn = mkBtn('Use this frame', 'btn small primary', ()=>{
      const c2 = document.createElement('canvas');
      c2.width = vid.videoWidth||640; c2.height = vid.videoHeight||480;
      c2.getContext('2d').drawImage(vid,0,0,c2.width,c2.height);
      addView(c2);
    });
    wrap.appendChild(vid); wrap.appendChild(useBtn);
    c.appendChild(wrap);
  }
}

function mkBtn(html,cls,fn){
  const b = document.createElement('button');
  b.className = cls; b.innerHTML = html; b.onclick = fn;
  return b;
}
function spacerEl(){ const d=document.createElement('div'); d.className='spacer'; return d; }

/* ---------------------------------------------------------------------
   14. FILMSTRIP
   --------------------------------------------------------------------- */

function renderFilmstrip(){
  const f = el.filmstrip;
  f.innerHTML='';
  state.views.forEach((v,i)=>{
    const d = document.createElement('div');
    d.className = 'thumb'+(i===state.activeView?' active':'');
    const img = document.createElement('img');
    img.src = v.canvas.toDataURL('image/jpeg',0.7);
    const tag = document.createElement('div');
    tag.className='tag'; tag.textContent = v.calibration?'cal':'—';
    d.appendChild(img); d.appendChild(tag);
    d.onclick = ()=>{ state.activeView=i; renderFilmstrip(); renderPanel(); renderViewport(); renderStepper(); };
    f.appendChild(d);
  });
  if(state.step==='capture'){
    const add = document.createElement('div');
    add.className='addview'; add.textContent='+';
    add.title='Capture another view';
    add.onclick = ()=>{ if(!state.stream) startCamera(); };
    f.appendChild(add);
  }
}

/* ---------------------------------------------------------------------
   15. PANEL RENDERING (per step)
   --------------------------------------------------------------------- */

function renderPanel(){
  const p = el.panelScroll;
  p.innerHTML = '';
  const view = currentView();

  if(state.step==='capture') return renderCapturePanel(p,view);
  if(state.step==='calibrate') return renderCalibratePanel(p,view);
  if(state.step==='measure') return renderMeasurePanel(p,view);
  if(state.step==='inspect') return renderInspectPanel(p,view);
  if(state.step==='fasteners') return renderFastenerPanel(p,view);
  if(state.step==='report') return renderReportPanel(p,view);
}

function sec(parent, headTop, headMain){
  const h2 = document.createElement('h2'); h2.textContent = headTop;
  const h3 = document.createElement('h3'); h3.textContent = headMain;
  parent.appendChild(h2); parent.appendChild(h3);
}

function noteEl(parent, text, cls){
  const d = document.createElement('div'); d.className='note'+(cls?(' '+cls):'');
  d.innerHTML = text; parent.appendChild(d); return d;
}

function renderCapturePanel(p, view){
  sec(p,'Step 1 of 6','Capture the component');
  noteEl(p,'Use a plain, evenly lit background (a sheet of paper or a desk works well) so the outline can be separated automatically. Keep the part parallel to the camera and fill a third of the frame.');
  const f = document.createElement('div'); f.className='field';
  f.innerHTML = `<label>Component type (optional — helps the report; auto-detection below is a shape guess, not a name)</label>`;
  const inp = document.createElement('input'); inp.type='text'; inp.placeholder='e.g. M10 hex bolt, bracket, shaft…';
  inp.value = state.componentType;
  inp.oninput = ()=>{ state.componentType = inp.value; el.componentLabel.textContent = inp.value || 'no component identified yet'; };
  f.appendChild(inp); p.appendChild(f);

  if(view && view.auto){
    const a = view.auto;
    const guessBox = document.createElement('div'); guessBox.className='note';
    if(a.insufficientArea){
      guessBox.className='note warn';
      guessBox.textContent = 'Could not separate the part from the background clearly. Try a plainer background or better contrast, or continue and measure manually.';
    } else {
      guessBox.innerHTML = `Shape guess: <b>${a.shapeGuess}</b> &middot; corners≈${a.cornerCount} &middot; circularity ${a.circularity.toFixed(2)}` +
        (a.holes.length? ` &middot; ${a.holes.length} hole(s) detected` : '') +
        `<br><span style="color:#8a5406">This is a heuristic silhouette read, confirm visually.</span>`;
    }
    p.appendChild(guessBox);
  }

  if(state.views.length>1){
    const div = document.createElement('div'); div.className='divider'; p.appendChild(div);
    const h = document.createElement('div'); h.style.cssText='font-size:12.5px;color:var(--ink-soft);margin-bottom:6px;';
    h.textContent = state.views.length+' views captured — combined for measurement averaging later.';
    p.appendChild(h);
  }
}

function renderCalibratePanel(p, view){
  sec(p,'Step 2 of 6','Set the scale');
  if(!view){ noteEl(p,'Capture a photo first.'); return; }
  noteEl(p,'Place a reference of known size flat in the same plane as the part, then click its two end points on the image.');

  const f1 = document.createElement('div'); f1.className='field';
  f1.innerHTML='<label>Reference used</label>';
  const sel = document.createElement('select');
  REFERENCE_PRESETS.forEach(r=>{
    const o=document.createElement('option'); o.value=r.id; o.textContent=r.label;
    if(r.id===state.calRefPreset) o.selected=true;
    sel.appendChild(o);
  });
  sel.onchange = ()=>{ state.calRefPreset = sel.value; renderCalibratePanel(p,view); };
  f1.appendChild(sel); p.appendChild(f1);

  const preset = REFERENCE_PRESETS.find(r=>r.id===state.calRefPreset);
  const f2 = document.createElement('div'); f2.className='field';
  f2.innerHTML = '<label>Known length (mm)</label>';
  const num = document.createElement('input'); num.type='number'; num.step='0.1';
  num.value = preset.mm!==null ? preset.mm : state.calCustomLength;
  num.disabled = preset.mm!==null;
  num.oninput = ()=>{ state.calCustomLength = parseFloat(num.value)||0; };
  f2.appendChild(num); p.appendChild(f2);

  const status = document.createElement('div'); status.style.cssText='font-size:12.5px;color:var(--ink-soft);margin-bottom:10px;';
  status.textContent = state.pendingPoints.length===0 ? 'Click point A on the reference.' :
    state.pendingPoints.length===1 ? 'Click point B on the reference.' : 'Two points placed — ready to calibrate.';
  p.appendChild(status);

  const setBtn = document.createElement('button'); setBtn.className='btn primary'; setBtn.style.width='100%';
  setBtn.textContent='Set calibration from points';
  setBtn.disabled = state.pendingPoints.length<2;
  setBtn.onclick = ()=>{
    const mm = preset.mm!==null ? preset.mm : state.calCustomLength;
    if(!mm || mm<=0){ setStatus('Enter a valid known length first.'); return; }
    const pxLen = dist(state.pendingPoints[0], state.pendingPoints[1]);
    view.calibration = { scale: pxLen/mm, p1:state.pendingPoints[0], p2:state.pendingPoints[1], knownMm: mm, refLabel: preset.label };
    state.pendingPoints=[];
    updateStatus(); renderStepper(); renderFilmstrip(); renderCalibratePanel(p,view); renderViewport();
  };
  p.appendChild(setBtn);

  if(view.calibration){
    const div = document.createElement('div'); div.className='divider'; p.appendChild(div);
    const ok = document.createElement('div'); ok.className='note';
    ok.innerHTML = `Calibrated: <b>${view.calibration.scale.toFixed(2)} px/mm</b> using ${view.calibration.refLabel}.`;
    p.appendChild(ok);
    const clear = document.createElement('button'); clear.className='btn small'; clear.textContent='Recalibrate';
    clear.onclick=()=>{ view.calibration=null; renderCalibratePanel(p,view); updateStatus(); renderStepper(); renderFilmstrip(); renderViewport(); };
    p.appendChild(clear);
  }

  const calCount = state.views.filter(v=>v.calibration).length;
  if(calCount>1){
    const scales = state.views.filter(v=>v.calibration).map(v=>v.calibration.scale);
    const mean = scales.reduce((a,b)=>a+b,0)/scales.length;
    const sd = Math.sqrt(scales.reduce((s,v)=>s+(v-mean)*(v-mean),0)/scales.length);
    const div2 = document.createElement('div'); div2.className='divider'; p.appendChild(div2);
    noteEl(p, `Across ${calCount} calibrated views: mean ${mean.toFixed(2)} px/mm, spread ±${sd.toFixed(2)} (${(sd/mean*100).toFixed(1)}%). Large spread usually means camera distance changed between shots.`);
  }
}

function renderMeasurePanel(p, view){
  sec(p,'Step 3 of 6','Measure dimensions');
  if(!view){ noteEl(p,'Capture a photo first.'); return; }
  if(!view.calibration) noteEl(p,'No calibration on this view yet — measurements will show in pixels only. Go to Calibrate for real-world units.','warn');

  const grid = document.createElement('div'); grid.className='mtool-grid';
  const tools = [
    {id:'length', lbl:'Length / width', sub:'2 points, straight distance'},
    {id:'circle', lbl:'Diameter / hole', sub:'3 points around the circle'},
    {id:'angle',  lbl:'Angle', sub:'vertex + 2 ends'},
  ];
  tools.forEach(t=>{
    const b = document.createElement('button');
    b.className = state.activeMeasureTool===t.id?'active':'';
    b.innerHTML = `<span class="lbl">${t.lbl}</span><span class="sub">${t.sub}</span>`;
    b.onclick = ()=>{ state.activeMeasureTool = state.activeMeasureTool===t.id?null:t.id; state.pendingPoints=[]; renderMeasurePanel(p,view); renderViewport(); };
    grid.appendChild(b);
  });
  p.appendChild(grid);

  const autoBtn = document.createElement('button'); autoBtn.className='btn'; autoBtn.style.width='100%'; autoBtn.style.marginBottom='8px';
  autoBtn.textContent = 'Add auto bounding-box length & width (AI-estimated)';
  autoBtn.disabled = !view.auto || view.auto.insufficientArea;
  autoBtn.onclick = ()=>{
    const a = view.auto;
    const lenPx = Math.max(a.bboxFull.w, a.bboxFull.h);
    const widPx = Math.min(a.bboxFull.w, a.bboxFull.h);
    view.measurements.push({id:'m'+Date.now()+'a', name:nextMeasureName(view,'Auto length'), type:'length',
      points:[{x:a.bboxFull.x,y:a.bboxFull.y},{x:a.bboxFull.x+lenPx,y:a.bboxFull.y}], pxLen:lenPx, mm:pxToMm(view,lenPx), source:'estimated'});
    view.measurements.push({id:'m'+Date.now()+'b', name:nextMeasureName(view,'Auto width'), type:'length',
      points:[{x:a.bboxFull.x,y:a.bboxFull.y+2},{x:a.bboxFull.x+widPx,y:a.bboxFull.y+2}], pxLen:widPx, mm:pxToMm(view,widPx), source:'estimated'});
    renderMeasurePanel(p,view); renderViewport(); updateStatus(); renderStepper();
  };
  p.appendChild(autoBtn);

  if(view.auto && view.auto.holes && view.auto.holes.length){
    const holeBtn = document.createElement('button'); holeBtn.className='btn'; holeBtn.style.width='100%'; holeBtn.style.marginBottom='14px';
    holeBtn.textContent = `Add ${view.auto.holes.length} detected hole diameter(s) (AI-estimated)`;
    holeBtn.onclick = ()=>{
      view.auto.holes.forEach((h,i)=>{
        view.measurements.push({id:'m'+Date.now()+i, name:nextMeasureName(view,'Hole Ø'), type:'circle',
          points:[], circle:{cx:h.cx,cy:h.cy,r:h.rPx}, pxLen:h.rPx*2, mm:pxToMm(view,h.rPx*2), source:'estimated'});
      });
      renderMeasurePanel(p,view); renderViewport(); updateStatus(); renderStepper();
    };
    p.appendChild(holeBtn);
  }

  const hint = document.createElement('div'); hint.style.cssText='font-size:12px;color:var(--ink-soft);margin-bottom:12px;';
  if(state.activeMeasureTool){
    const need = state.activeMeasureTool==='length'?2:3;
    hint.textContent = `Click ${need-state.pendingPoints.length} more point(s) on the image. Clicks snap to the nearest strong edge.`;
  }
  p.appendChild(hint);

  const div = document.createElement('div'); div.className='divider'; p.appendChild(div);
  const listHead = document.createElement('div'); listHead.style.cssText='font-size:12.5px;color:var(--ink-soft);margin-bottom:4px;';
  listHead.textContent = 'Measurements on this view';
  p.appendChild(listHead);

  const ul = document.createElement('ul'); ul.className='mlist';
  if(!view.measurements.length){
    const li=document.createElement('li'); li.innerHTML='<span class="name" style="color:var(--ink-soft)">None yet</span>'; ul.appendChild(li);
  }
  view.measurements.forEach(m=>{
    const li = document.createElement('li');
    const valText = m.type==='angle' ? m.angleDeg.toFixed(1)+'&deg;' : (m.mm!=null? m.mm.toFixed(2)+' mm' : Math.round(m.pxLen)+' px');
    li.innerHTML = `<span class="name">${m.name}</span><span><span class="val">${valText}</span><span class="tag ${m.source==='measured'?'measured':'estimated'}">${m.source}</span></span>`;
    const del = document.createElement('button'); del.className='del'; del.innerHTML='&times;'; del.title='Remove';
    del.onclick = ()=>{ view.measurements = view.measurements.filter(x=>x.id!==m.id); renderMeasurePanel(p,view); renderViewport(); updateStatus(); renderStepper(); };
    li.querySelector('span:last-child').appendChild(del);
    ul.appendChild(li);
  });
  p.appendChild(ul);

  if(state.views.length>1){
    const div2 = document.createElement('div'); div2.className='divider'; p.appendChild(div2);
    renderCrossViewAverages(p);
  }
}

function renderCrossViewAverages(p){
  const groups = {};
  state.views.forEach(v=>v.measurements.forEach(m=>{
    if(m.mm==null) return;
    const key = m.name.replace(/\s\d+$/,'');
    (groups[key]=groups[key]||[]).push(m.mm);
  }));
  const keys = Object.keys(groups).filter(k=>groups[k].length>1);
  if(!keys.length) return;
  const h = document.createElement('div'); h.style.cssText='font-size:12.5px;color:var(--ink-soft);margin-bottom:4px;'; h.textContent='Multi-view averages';
  p.appendChild(h);
  const ul = document.createElement('ul'); ul.className='mlist';
  keys.forEach(k=>{
    const vals = groups[k];
    const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
    const sd = Math.sqrt(vals.reduce((s,v)=>s+(v-mean)*(v-mean),0)/vals.length);
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${k} (n=${vals.length})</span><span class="val">${mean.toFixed(2)} &plusmn; ${sd.toFixed(2)} mm</span>`;
    ul.appendChild(li);
  });
  p.appendChild(ul);
}

function renderInspectPanel(p, view){
  sec(p,'Step 4 of 6','Visual inspection');
  if(!view){ noteEl(p,'Capture a photo first.'); return; }
  noteEl(p,'This heuristic checks the part\'s silhouette for jagged edges and left-right asymmetry. It is a starting point for a human check, not a certified defect scan.');

  const runBtn = document.createElement('button'); runBtn.className='btn primary'; runBtn.style.width='100%'; runBtn.style.marginBottom='10px';
  runBtn.textContent = 'Run defect scan';
  runBtn.disabled = !view.auto || view.auto.insufficientArea;
  runBtn.onclick = ()=>{ runDefectScan(view); renderInspectPanel(p,view); renderViewport(); renderStepper(); };
  p.appendChild(runBtn);

  const flagBtn = document.createElement('button'); flagBtn.className='btn'; flagBtn.style.width='100%'; flagBtn.style.marginBottom='14px';
  flagBtn.textContent = state.flagMode ? 'Click 2 corners on the image…' : 'Flag an area manually';
  flagBtn.onclick = ()=>{ state.flagMode=!state.flagMode; state.pendingPoints=[]; renderInspectPanel(p,view); };
  p.appendChild(flagBtn);

  const ul = document.createElement('ul'); ul.className='mlist';
  if(!view.defects.length){
    const li=document.createElement('li'); li.innerHTML='<span class="name" style="color:var(--ink-soft)">'+(view.auto&&view.auto.defectScanRun?'No irregularities flagged':'Scan not run yet')+'</span>'; ul.appendChild(li);
  }
  view.defects.forEach((d,i)=>{
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${d.desc}</span>`;
    const del = document.createElement('button'); del.className='del'; del.innerHTML='&times;';
    del.onclick=()=>{ view.defects.splice(i,1); renderInspectPanel(p,view); renderViewport(); };
    li.appendChild(del);
    ul.appendChild(li);
  });
  p.appendChild(ul);
}

function renderFastenerPanel(p, view){
  sec(p,'Step 5 of 6','Fastener recognition');
  const toggle = document.createElement('label'); toggle.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13.5px;';
  const cb = document.createElement('input'); cb.type='checkbox'; cb.checked=state.isFastener;
  cb.onchange = ()=>{ state.isFastener = cb.checked; renderFastenerPanel(p,view); };
  toggle.appendChild(cb); toggle.appendChild(document.createTextNode('This component is a standard fastener'));
  p.appendChild(toggle);
  if(!state.isFastener) return;

  const f1 = document.createElement('div'); f1.className='field row';
  const famSel = document.createElement('select');
  [['hex','Hex bolt / cap screw'],['nut','Nut'],['washer','Washer'],['screw','Machine screw']].forEach(([v,l])=>{
    const o=document.createElement('option'); o.value=v; o.textContent=l; if(v===state.fastenerFamily)o.selected=true; famSel.appendChild(o);
  });
  famSel.onchange=()=>{state.fastenerFamily=famSel.value;};
  const sysSel = document.createElement('select');
  [['metric','Metric (ISO)'],['imperial','Imperial (UNC)']].forEach(([v,l])=>{
    const o=document.createElement('option'); o.value=v; o.textContent=l; if(v===state.fastenerSystem)o.selected=true; sysSel.appendChild(o);
  });
  sysSel.onchange=()=>{state.fastenerSystem=sysSel.value;};
  f1.appendChild(famSel); f1.appendChild(sysSel); p.appendChild(f1);

  noteEl(p,'Match uses your most recent diameter measurement (Measure step) or the auto hex width-across-flats. Add a diameter measurement first for best accuracy.');

  const matchBtn = document.createElement('button'); matchBtn.className='btn primary'; matchBtn.style.width='100%'; matchBtn.style.marginBottom='12px';
  matchBtn.textContent='Match against standards database';
  matchBtn.onclick = ()=>{ state.fastenerMatch = matchFastener(); renderFastenerPanel(p,view); renderStepper(); };
  p.appendChild(matchBtn);

  if(state.fastenerMatch===null){
    noteEl(p,'No match yet — add a diameter/hole measurement in the Measure step, or capture a clearer top-down photo.','warn');
  } else if(state.fastenerMatch){
    const m = state.fastenerMatch;
    const card = document.createElement('div'); card.className='note';
    card.innerHTML = `Detected: <b>${m.family}</b><br>Standard: <b>${m.system==='metric'?'ISO Metric':'ANSI/UNC Imperial'}</b><br>
      Estimated size: <b>${m.size}</b> <span class="tag matched">db match</span><br>
      Thread: ${m.pitchOrTpi}<br>
      Based on ${m.measuredBasis}: ${m.measuredValue} <span class="tag measured">measured</span>`;
    p.appendChild(card);
    const confWrap = document.createElement('div'); confWrap.style.marginTop='8px';
    confWrap.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-soft);"><span>Confidence</span><span>${m.confidence}%</span></div><div class="confbar"><i style="width:${m.confidence}%"></i></div>`;
    p.appendChild(confWrap);
  }
}

function renderReportPanel(p, view){
  sec(p,'Step 6 of 6','Inspection report');
  if(!view){ noteEl(p,'Capture a photo first.'); return; }

  const f1 = document.createElement('div'); f1.className='field row';
  f1.innerHTML = '';
  const nomWrap = document.createElement('div');
  nomWrap.innerHTML = '<label>Expected / nominal dimension (mm, optional)</label>';
  const nomInp = document.createElement('input'); nomInp.type='number'; nomInp.step='0.01'; nomInp.value=state.tolNominal;
  nomInp.oninput=()=>{ state.tolNominal = nomInp.value; renderReportPreview(); };
  nomWrap.appendChild(nomInp);
  const clsWrap = document.createElement('div');
  clsWrap.innerHTML = '<label>ISO 2768 class</label>';
  const clsSel = document.createElement('select');
  [['f','f — fine'],['m','m — medium'],['c','c — coarse'],['v','v — very coarse']].forEach(([v,l])=>{
    const o=document.createElement('option'); o.value=v; o.textContent=l; if(v===state.tolClass)o.selected=true; clsSel.appendChild(o);
  });
  clsSel.onchange=()=>{ state.tolClass=clsSel.value; renderReportPreview(); };
  clsWrap.appendChild(clsSel);
  f1.appendChild(nomWrap); f1.appendChild(clsWrap);
  p.appendChild(f1);

  noteEl(p,'Pass/Fail compares your largest "measured" (not estimated) length against the nominal ± ISO 2768 tolerance for that size bracket. Leave nominal blank to skip grading.');

  const exportBtn = document.createElement('button'); exportBtn.className='btn primary'; exportBtn.style.width='100%'; exportBtn.style.marginTop='6px';
  exportBtn.textContent='Export PDF report';
  exportBtn.onclick = exportPDF;
  p.appendChild(exportBtn);

  const div = document.createElement('div'); div.className='divider'; p.appendChild(div);
  const previewHolder = document.createElement('div'); previewHolder.id='reportPreviewHolder';
  p.appendChild(previewHolder);
  renderReportPreview();
}

function computeVerdict(){
  if(!state.tolNominal) return null;
  const nominal = parseFloat(state.tolNominal);
  if(!nominal) return null;
  const view = currentView();
  const measured = view.measurements.filter(m=>m.source==='measured' && m.mm!=null);
  if(!measured.length) return {status:'unknown', reason:'no direct measurement to compare'};
  const closest = measured.reduce((best,m)=> Math.abs(m.mm-nominal)<Math.abs(best.mm-nominal)?m:best );
  const br = ISO2768.brackets;
  let idx = br.findIndex(b=>nominal<=b); if(idx<0) idx = br.length-1; idx = Math.max(0, idx-1);
  const tol = ISO2768.classes[state.tolClass][idx];
  if(isNaN(tol)) return {status:'unknown', reason:'tolerance undefined for this class/size'};
  const within = Math.abs(closest.mm-nominal) <= tol;
  return { status: within?'pass':'fail', measured:closest, nominal, tol };
}

function renderReportPreview(){
  const holder = document.getElementById('reportPreviewHolder');
  if(!holder) return;
  const view = currentView();
  holder.innerHTML='';
  const verdict = computeVerdict();
  const badge = document.createElement('span');
  badge.className = 'badge '+(verdict? (verdict.status==='pass'?'pass':verdict.status==='fail'?'fail':'unknown') : 'unknown');
  badge.textContent = verdict ? (verdict.status==='pass'?'PASS':verdict.status==='fail'?'FAIL':'—') : 'No tolerance set';
  holder.appendChild(badge);
  if(verdict && verdict.measured){
    const t = document.createElement('div'); t.style.cssText='font-size:12px;color:var(--ink-soft);margin-top:6px;';
    t.textContent = `${verdict.measured.name}: ${verdict.measured.mm.toFixed(2)} mm vs nominal ${verdict.nominal} ±${verdict.tol} mm`;
    holder.appendChild(t);
  }
}

/* ---------------------------------------------------------------------
   16. PDF REPORT
   --------------------------------------------------------------------- */

function exportPDF(){
  const view = currentView();
  if(!view){ setStatus('No view to report on.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'pt', format:'a4'});
  const pageW = doc.internal.pageSize.getWidth();
  let y = 40;

  doc.setFont('helvetica','bold'); doc.setFontSize(18);
  doc.text('Nebula Vision — Inspection Report', 40, y); y+=22;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(90);
  doc.text('Generated '+new Date().toLocaleString(), 40, y); y+=20;
  doc.setTextColor(20);

  const imgData = view.canvas.toDataURL('image/jpeg',0.85);
  const imgW = 240, imgH = imgW*view.h/view.w;
  doc.addImage(imgData,'JPEG',40,y,imgW,imgH);

  let ry = y;
  const rx = 40+imgW+20;
  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text(state.componentType || 'Unnamed component', rx, ry+14);
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  ry += 32;
  const shape = view.auto && !view.auto.insufficientArea ? view.auto.shapeGuess : 'undetermined';
  doc.text('Shape guess (AI-estimated): '+shape, rx, ry); ry+=16;
  doc.text('Calibration: '+(view.calibration? view.calibration.scale.toFixed(2)+' px/mm via '+view.calibration.refLabel : 'not calibrated'), rx, ry); ry+=16;
  if(view.auto && view.auto.holes && view.auto.holes.length){
    doc.text('Holes detected: '+view.auto.holes.length, rx, ry); ry+=16;
  }
  const verdict = computeVerdict();
  if(verdict){
    doc.setFont('helvetica','bold');
    doc.setTextColor(verdict.status==='pass'?[19,122,61]:verdict.status==='fail'?[181,43,43]:[100,100,100]);
    doc.text('Result: '+verdict.status.toUpperCase(), rx, ry+4); ry+=20;
    doc.setTextColor(20); doc.setFont('helvetica','normal');
  }
  if(state.fastenerMatch){
    const m = state.fastenerMatch;
    doc.text(`Fastener match: ${m.size} (${m.system}), ${m.confidence}% confidence`, rx, ry); ry+=16;
  }

  y = Math.max(y+imgH, ry) + 24;

  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text('Measured dimensions', 40, y); y+=8;
  const rows = view.measurements.map(m=>[
    m.name,
    m.type==='angle' ? m.angleDeg.toFixed(1)+' deg' : (m.mm!=null? m.mm.toFixed(2)+' mm' : Math.round(m.pxLen)+' px'),
    m.source
  ]);
  y = simpleTable(doc, y+14, ['Feature','Value','Source'], rows, [200,160,140]);

  y += 20;
  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text('Inspection findings', 40, y); y+=8;
  const drows = view.defects.length? view.defects.map(d=>[d.desc, d.type]) : [['No irregularities flagged / scan not run','—']];
  y = simpleTable(doc, y+14, ['Finding','Type'], drows, [340, 100]);

  y += 24;
  if(y>doc.internal.pageSize.getHeight()-140) { doc.addPage(); y=40; }
  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text('Notes on reliability', 40, y); y+=16;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(90);
  const disclaimer = [
    'Dimensions are derived from a single calibrated photograph unless otherwise noted; accuracy depends on the reference',
    'object being in the same plane as the part and the camera being roughly perpendicular to that plane. Thread pitch,',
    'sub-millimetre defects, and out-of-plane features are not reliably measurable from a phone camera and are not certified',
    'by this report. Values tagged "estimated" come from automatic silhouette analysis and should be verified manually',
    'before use in a quality decision.'
  ];
  disclaimer.forEach(line=>{ doc.text(line,40,y); y+=12; });
  doc.setTextColor(20);

  doc.save((state.componentType||'nebula-inspection').replace(/\s+/g,'_')+'_report.pdf');
  setStatus('PDF report downloaded.');
}

function simpleTable(doc, startY, headers, rows, colWidths){
  let y = startY;
  doc.setFontSize(9.5);
  doc.setFont('helvetica','bold'); doc.setTextColor(90);
  let x=40;
  headers.forEach((h,i)=>{ doc.text(h,x,y); x+=colWidths[i]; });
  y+=4; doc.setDrawColor(220); doc.line(40,y,40+colWidths.reduce((a,b)=>a+b,0),y); y+=12;
  doc.setFont('helvetica','normal'); doc.setTextColor(20);
  rows.forEach(r=>{
    if(y>doc.internal.pageSize.getHeight()-60){ doc.addPage(); y=40; }
    x=40;
    r.forEach((c,i)=>{ doc.text(String(c),x,y); x+=colWidths[i]; });
    y+=15;
  });
  return y;
}

/* ---------------------------------------------------------------------
   17. STATUS BAR / MISC
   --------------------------------------------------------------------- */

function setStatus(msg){ el.statusMsg.textContent = msg; }
function updateStatus(){
  const view = currentView();
  el.statusScale.textContent = 'Scale: '+activeScaleLabel(view);
  el.statusViews.textContent = 'Views captured: '+state.views.length;
}

/* ---------------------------------------------------------------------
   18. INIT
   --------------------------------------------------------------------- */

el.infoBtn.onclick = ()=> el.infoModal.classList.add('show');
el.infoClose.onclick = ()=> el.infoModal.classList.remove('show');
el.infoModal.onclick = (e)=>{ if(e.target===el.infoModal) el.infoModal.classList.remove('show'); };

window.addEventListener('resize', ()=>{ resizeCanvases(); renderViewport(); });

function init(){
  renderStepper();
  renderStageControls();
  renderPanel();
  updateStatus();
  requestAnimationFrame(()=>{ resizeCanvases(); renderViewport(); });
}
init();

})();
