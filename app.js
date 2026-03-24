/* ...existing code... */
import mitt from "mitt";

const bus = mitt();

const qs = (id) => document.getElementById(id);

let audioCtx;
let bytebeatNode;
let imageNode;

const state = {
  runningBytebeat: false,
  runningImage: false,
  bytebeat: {
    expr: "(t>>6|t|t>>(t>>9))*t&128",
    sr: 8000,
    bits: 8
  },
  imagePlay: {
    sr: 8000,
    buffer: null
  },
  audioToImage: {
    sr: 8000,
    buffer: null,
    imgW: 512,
    imgH: 256
  },
  videoToAudio: {
    fps: 30,
    buffer: null,
    duration: 0
  }
};

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule('./worklet.js');
  } else {
    await audioCtx.resume();
  }
}

function compileExpr(src) {
  try {
    // Preprocess to support custom gate operator `/--/`
    // Any `A /--/ B` is treated as applying the gate to A (unary operator).
    const processed = String(src).replace(
      /([^\s()]+)\s*\/--\/\s*([^\s()]+)/g,
      '__gate($1)'
    );
    // t is an increasing integer sample counter
    // Return 8-bit (0..255) or 16-bit (-32768..32767)
    return new Function(
      't',
      `"use strict"; const __gate=(x)=>{const v=Math.abs(x*(x*x));return v>100?0:x/2;}; const fol=(A,op,B)=>{let v=op;for(let i=0;i<A;i++) v-=B;return v;}; const tol=(A,op,B)=>{let v=op;for(let i=0;i<B;i++) v+=A;return v;}; return (${processed});`
    );
  } catch (e) {
    console.error(e);
    return null;
  }
}

function createBytebeatNode(exprSrc, sr, bits) {
  const fn = compileExpr(exprSrc);
  if (!fn) return null;
  const node = new AudioWorkletNode(audioCtx, 'bytebeat-processor', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sr, bits, exprSrc }
  });
  node.port.postMessage({ type: 'update', sr, bits, exprSrc });
  return node;
}

function createImageNode(buffer, sr) {
  const node = new AudioWorkletNode(audioCtx, 'image-processor', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sr, buffer }
  });
  node.port.postMessage({ type: 'update', sr, buffer });
  return node;
}

function stopNode(node) {
  if (node) node.disconnect();
}

/**
 * Convert a Uint8Array buffer (0..255) into a bytebeat expression that
 * looks up samples from a constant table using t % N.
 */
function bufferToBytebeatCode(buf) {
  const len = buf.length;
  if (!buf || len === 0) return '';
  // Build a compact array literal
  const parts = new Array(len);
  for (let i = 0; i < len; i++) {
    parts[i] = buf[i].toString();
  }
  const arrayLiteral = '[' + parts.join(',') + ']';
  // t is the bytebeat time index; wrap with modulo to loop
  return `${arrayLiteral}[t % ${len}]`;
}

/* UI wiring */
const unlockBtn = qs('audioUnlock');
const playBtn = qs('play');
const stopBtn = qs('stop');
const presets = qs('presets');
const exprEl = qs('expr');
const srEl = qs('sr');
const bitsEl = qs('bits');

const imgWEl = qs('imgWidth');
const imgHEl = qs('imgHeight');
const renderBtn = qs('renderImage');
const saveBtn = qs('savePng');
const bbCanvas = qs('bytebeatCanvas');
const saveBbWavBtn = qs('saveBbWav');
const bytebeatAudioEl = qs('bytebeatAudio');

const imgFileEl = qs('imgFile');
const imgSrEl = qs('imgSr');
const playImgBtn = qs('playImage');
const stopImgBtn = qs('stopImage');
const imgCanvas = qs('imageCanvas');
const saveImgWavBtn = qs('saveImageWav');
const imageAudioEl = qs('imageAudio');
const imgToCodeBtn = qs('imgToCode');

/* Audio → Bytebeat Image wiring */
const audioFileEl = qs('audioFile');
const audioSrEl = qs('audioSr');
const audioImgWEl = qs('audioImgWidth');
const audioImgHEl = qs('audioImgHeight');
const renderAudioImageBtn = qs('renderAudioImage');
const playAudioImageBtn = qs('playAudioImage');
const stopAudioImageBtn = qs('stopAudioImage');
const saveAudioImagePngBtn = qs('saveAudioImagePng');
const saveAudioImageWavBtn = qs('saveAudioImageWav');
const audioImageCanvas = qs('audioImageCanvas');
const audioImgToCodeBtn = qs('audioImgToCode');

/* Video → Bytebeat (audio) wiring */
const videoFileEl = qs('videoFile');
const videoFpsEl = qs('videoFps');
const renderVideoAudioBtn = qs('renderVideoAudio');
const playVideoAudioBtn = qs('playVideoAudio');
const stopVideoAudioBtn = qs('stopVideoAudio');
const saveVideoAudioWavBtn = qs('saveVideoAudioWav');
const videoPreviewCanvas = qs('videoPreviewCanvas');

let loadedVideo = null;

/* Audio unlock for mobile */
unlockBtn.addEventListener('click', async () => {
  await ensureAudio();
  unlockBtn.textContent = 'Audio Enabled';
  unlockBtn.disabled = true;
});

/* Presets */
presets.addEventListener('change', () => {
  exprEl.value = presets.value;
});

/* Play/Stop Bytebeat */
playBtn.addEventListener('click', async () => {
  await ensureAudio();
  state.bytebeat.expr = exprEl.value.trim();
  state.bytebeat.sr = parseInt(srEl.value, 10);
  state.bytebeat.bits = parseInt(bitsEl.value, 10);

  stopNode(bytebeatNode);
  bytebeatNode = createBytebeatNode(state.bytebeat.expr, state.bytebeat.sr, state.bytebeat.bits);
  if (!bytebeatNode) return;
  bytebeatNode.connect(audioCtx.destination);
  state.runningBytebeat = true;
});

stopBtn.addEventListener('click', () => {
  stopNode(bytebeatNode);
  state.runningBytebeat = false;
});

/* Render Bytebeat to Image */
renderBtn.addEventListener('click', async () => {
  await ensureAudio();
  const w = Math.max(32, Math.min(4096, parseInt(imgWEl.value, 10) || 512));
  const h = Math.max(32, Math.min(4096, parseInt(imgHEl.value, 10) || 256));
  bbCanvas.width = w; bbCanvas.height = h;
  const ctx = bbCanvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);

  const exprSrc = exprEl.value.trim();
  const fn = compileExpr(exprSrc);
  if (!fn) return;

  // Generate w*h samples at chosen sample rate. Map to grayscale.
  const bits = parseInt(bitsEl.value, 10);
  let t = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, t++) {
      let val = fn(t) || 0;
      let gray;
      if (bits === 8) {
        gray = (val & 255) >>> 0;
      } else {
        // 16-bit signed to 0..255
        val = Math.max(-32768, Math.min(32767, val|0));
        gray = Math.floor((val + 32768) / 256);
      }
      const i = (y * w + x) * 4;
      imgData.data[i] = gray;
      imgData.data[i+1] = gray;
      imgData.data[i+2] = gray;
      imgData.data[i+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
});

saveBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = bbCanvas.toDataURL('image/png');
  a.download = 'bytebeat.png';
  a.click();
});

saveBbWavBtn.addEventListener('click', () => {
  const w = Math.max(32, Math.min(4096, parseInt(imgWEl.value, 10) || 512));
  const h = Math.max(32, Math.min(4096, parseInt(imgHEl.value, 10) || 256));
  const samples = w * h;
  const exprSrc = exprEl.value.trim();
  const fn = compileExpr(exprSrc);
  if (!fn || samples <= 0) return;

  const bits = parseInt(bitsEl.value, 10);
  const sr = parseInt(srEl.value, 10) || 8000;

  const n = samples;
  const bps = 2; // 16-bit PCM
  const dataLen = n * bps;
  const wavLen = 44 + dataLen;
  const ab = new ArrayBuffer(wavLen);
  const dv = new DataView(ab);

  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

  // WAV header
  ws(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);      // PCM
  dv.setUint16(22, 1, true);      // mono
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * bps, true);
  dv.setUint16(32, bps, true);    // block align
  dv.setUint16(34, 16, true);     // bits per sample
  ws(36, 'data');
  dv.setUint32(40, dataLen, true);

  // Samples
  for (let t = 0, o = 44; t < n; t++, o += 2) {
    let val = fn(t) || 0;
    let s;
    if (bits === 8) {
      const byte = (val & 255) >>> 0;           // 0..255
      const q = (byte - 128) / 128;            // -1..1
      s = Math.max(-1, Math.min(1, q));
    } else {
      val = Math.max(-32768, Math.min(32767, val | 0));
      s = val / 32768;
    }
    dv.setInt16(o, Math.max(-1, Math.min(1, s)) * 32767, true);
  }

  const blob = new Blob([ab], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bytebeat.wav';
  a.click();
  if (bytebeatAudioEl) {
    bytebeatAudioEl.src = url;
    bytebeatAudioEl.play().catch(() => {});
  }
});

/* Image loading */
imgFileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const maxW = imgCanvas.clientWidth || 320;
    const scale = Math.min(1, maxW / img.width);
    const w = Math.floor(img.width * scale);
    const h = Math.floor(img.height * scale);
    imgCanvas.width = w; imgCanvas.height = h;
    const ctx = imgCanvas && imgCanvas.getContext('2d');
    if (!imgCanvas || !ctx) { console.error('imageCanvas or 2D context unavailable'); return; }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);

    // Extract grayscale buffer
    const data = ctx.getImageData(0, 0, w, h).data;
    const buf = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i+1], b = data[i+2];
      buf[p] = Math.round(0.2126*r + 0.7152*g + 0.0722*b);
    }
    state.imagePlay.buffer = buf;
  };
  img.src = url;
});

/* Play/Stop image as audio */
playImgBtn.addEventListener('click', async () => {
  await ensureAudio();
  const sr = parseInt(imgSrEl.value, 10);
  if (!state.imagePlay.buffer) return;
  stopNode(imageNode);
  imageNode = createImageNode(state.imagePlay.buffer, sr);
  imageNode.connect(audioCtx.destination);
  state.runningImage = true;
});

stopImgBtn.addEventListener('click', () => {
  stopNode(imageNode);
  state.runningImage = false;
});

saveImgWavBtn.addEventListener('click', () => {
  const sr=parseInt(imgSrEl.value,10), buf=state.imagePlay.buffer; if(!buf) return;
  const n=buf.length, bps=2, dataLen=n*bps, wavLen=44+dataLen;
  const ab=new ArrayBuffer(wavLen), dv=new DataView(ab);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++) dv.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF'); dv.setUint32(4,36+dataLen,true); ws(8,'WAVE'); ws(12,'fmt '); dv.setUint32(16,16,true);
  dv.setUint16(20,1,true); dv.setUint16(22,1,true); dv.setUint32(24,sr,true); dv.setUint32(28,sr*bps,true);
  dv.setUint16(32,bps,true); dv.setUint16(34,16,true); ws(36,'data'); dv.setUint32(40,dataLen,true);
  for(let i=0,o=44;i<n;i++,o+=2){ const q=Math.max(-1,Math.min(1,(buf[i]-128)/128)); dv.setInt16(o,q*32767,true); }
  const blob=new Blob([ab],{type:'audio/wav'});
  const url = URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='image.wav';
  a.click();
  if (imageAudioEl) {
    imageAudioEl.src = url;
    imageAudioEl.play().catch(()=>{});
  }
});

/* Image → Bytebeat: export current buffer as bytebeat code into main editor */
if (imgToCodeBtn) {
  imgToCodeBtn.addEventListener('click', () => {
    const buf = state.imagePlay.buffer;
    if (!buf || buf.length === 0) return;
    const code = bufferToBytebeatCode(buf);
    if (!code) return;
    exprEl.value = code;
    presets.value = code; // preset select will show raw code
  });
}

/* Audio → Bytebeat Image: load audio and build buffer */
audioFileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const arrayBuf = await file.arrayBuffer();
  await ensureAudio();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    const ch0 = decoded.getChannelData(0);
    const srTarget = parseInt(audioSrEl.value, 10) || 8000;
    const ratio = decoded.sampleRate / srTarget;
    const length = Math.max(1, Math.floor(ch0.length / ratio));
    const buf = new Uint8Array(length);
    let srcPos = 0;
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(srcPos);
      const s = ch0[Math.min(idx, ch0.length - 1)] || 0;
      const clamped = Math.max(-1, Math.min(1, s));
      const v = Math.round((clamped * 0.5 + 0.5) * 255); // -1..1 -> 0..255
      buf[i] = v;
      srcPos += ratio;
    }
    state.audioToImage.buffer = buf;
    state.audioToImage.sr = srTarget;
  } catch (err) {
    console.error('Failed to decode audio', err);
  }
});

/* Audio → Bytebeat Image: render image */
renderAudioImageBtn.addEventListener('click', () => {
  const buf = state.audioToImage.buffer;
  if (!buf || buf.length === 0) return;

  const w = Math.max(32, Math.min(4096, parseInt(audioImgWEl.value, 10) || 512));
  const h = Math.max(32, Math.min(4096, parseInt(audioImgHEl.value, 10) || 256));
  state.audioToImage.imgW = w;
  state.audioToImage.imgH = h;

  audioImageCanvas.width = w;
  audioImageCanvas.height = h;
  const ctx = audioImageCanvas.getContext('2d');
  if (!ctx) return;
  const imgData = ctx.createImageData(w, h);

  const totalPixels = w * h;
  for (let i = 0; i < totalPixels; i++) {
    const v = buf[i % buf.length];
    const o = i * 4;
    imgData.data[o] = v;
    imgData.data[o + 1] = v;
    imgData.data[o + 2] = v;
    imgData.data[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
});

/* Audio → Bytebeat Image: play as audio using image-processor */
playAudioImageBtn.addEventListener('click', async () => {
  const buf = state.audioToImage.buffer;
  if (!buf || buf.length === 0) return;
  await ensureAudio();
  const sr = state.audioToImage.sr || (parseInt(audioSrEl.value, 10) || 8000);
  stopNode(imageNode);
  imageNode = createImageNode(buf, sr);
  imageNode.connect(audioCtx.destination);
  state.runningImage = true;
});

stopAudioImageBtn.addEventListener('click', () => {
  stopNode(imageNode);
  state.runningImage = false;
});

/* Audio → Bytebeat Image: save PNG */
saveAudioImagePngBtn.addEventListener('click', () => {
  if (!audioImageCanvas) return;
  const a = document.createElement('a');
  a.href = audioImageCanvas.toDataURL('image/png');
  a.download = 'audio-bytebeat.png';
  a.click();
});

/* Audio → Bytebeat Image: save WAV from buffer */
saveAudioImageWavBtn.addEventListener('click', () => {
  const buf = state.audioToImage.buffer;
  if (!buf || buf.length === 0) return;
  const sr = state.audioToImage.sr || (parseInt(audioSrEl.value, 10) || 8000);
  const n = buf.length, bps = 2, dataLen = n * bps, wavLen = 44 + dataLen;
  const ab = new ArrayBuffer(wavLen), dv = new DataView(ab);
  const ws = (o,s)=>{for(let i=0;i<s.length;i++) dv.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF'); dv.setUint32(4,36+dataLen,true); ws(8,'WAVE'); ws(12,'fmt '); dv.setUint32(16,16,true);
  dv.setUint16(20,1,true); dv.setUint16(22,1,true); dv.setUint32(24,sr,true); dv.setUint32(28,sr*bps,true);
  dv.setUint16(32,bps,true); dv.setUint16(34,16,true); ws(36,'data'); dv.setUint32(40,dataLen,true);
  for(let i=0,o=44;i<n;i++,o+=2){
    const q = Math.max(-1, Math.min(1, (buf[i]-128)/128));
    dv.setInt16(o, q*32767, true);
  }
  const blob = new Blob([ab], {type:'audio/wav'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audio-bytebeat.wav';
  a.click();
});

/* Audio → Bytebeat Image: export buffer as bytebeat code */
if (audioImgToCodeBtn) {
  audioImgToCodeBtn.addEventListener('click', () => {
    const buf = state.audioToImage.buffer;
    if (!buf || buf.length === 0) return;
    const code = bufferToBytebeatCode(buf);
    if (!code) return;
    exprEl.value = code;
    presets.value = code;
  });
}

/* Video → Bytebeat (audio): load video */
videoFileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) {
    loadedVideo = null;
    state.videoToAudio.buffer = null;
    return;
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  loadedVideo = video;

  video.addEventListener('loadedmetadata', () => {
    state.videoToAudio.duration = video.duration || 0;
    // Draw first frame as preview when ready
    const drawPreview = () => {
      if (!videoPreviewCanvas) return;
      const ctx = videoPreviewCanvas.getContext('2d');
      if (!ctx) return;
      const w = video.videoWidth || 320;
      const h = video.videoHeight || 180;
      const scale = Math.min(
        videoPreviewCanvas.width / w,
        videoPreviewCanvas.height / h
      );
      const dw = Math.max(1, Math.floor(w * scale));
      const dh = Math.max(1, Math.floor(h * scale));
      ctx.clearRect(0, 0, videoPreviewCanvas.width, videoPreviewCanvas.height);
      ctx.drawImage(video, 0, 0, dw, dh);
    };
    // Seek slightly into the video to ensure a frame is available
    video.currentTime = 0.0001;
    video.addEventListener('seeked', drawPreview, { once: true });
  }, { once: true });
});

/* Helper: extract a grayscale value per sampled frame */
async function extractVideoBytebeatBuffer(video, fps, previewCanvas) {
  if (!video || fps <= 0) {
    return null;
  }

  // Ensure metadata (duration, dimensions) is available
  if (!video.videoWidth || !video.videoHeight || !isFinite(video.duration) || video.duration === 0) {
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      const onError = (err) => {
        video.removeEventListener('loadedmetadata', onLoaded);
        reject(err);
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    }).catch(() => {});
  }

  if (!video.videoWidth || !video.videoHeight || !isFinite(video.duration) || video.duration === 0) {
    return null;
  }

  // Limit how much of the video we process to avoid extremely long audio
  const MAX_SECONDS = 5; // only convert up to the first 5 seconds
  const durationUsed = Math.min(video.duration, MAX_SECONDS);
  const totalFrames = Math.max(1, Math.floor(durationUsed * fps));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const buf = new Uint8Array(totalFrames);

  const step = 1 / fps;
  let t = 0;

  // Ensure we can control currentTime without autoplay
  video.pause();

  for (let i = 0; i < totalFrames; i++) {
    t = Math.min(durationUsed, i * step);
    await new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
    });

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    // Average grayscale over entire frame
    let sum = 0;
    const pixelCount = frameData.length / 4;
    for (let p = 0; p < frameData.length; p += 4) {
      const r = frameData[p];
      const g = frameData[p + 1];
      const b = frameData[p + 2];
      const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      sum += gray;
    }
    const avgGray = Math.round(sum / pixelCount);
    buf[i] = avgGray;

    // Optionally update preview with the last sampled frame we used
    if (previewCanvas && i === totalFrames - 1) {
      const pctx = previewCanvas.getContext('2d');
      if (pctx) {
        const w = previewCanvas.width;
        const h = previewCanvas.height;
        const scale = Math.min(w / canvas.width, h / canvas.height);
        const dw = Math.max(1, Math.floor(canvas.width * scale));
        const dh = Math.max(1, Math.floor(canvas.height * scale));
        pctx.clearRect(0, 0, w, h);
        pctx.drawImage(canvas, 0, 0, dw, dh);
      }
    }
  }

  return buf;
}

/* Video → Bytebeat (audio): render buffer from video frames */
renderVideoAudioBtn.addEventListener('click', async () => {
  if (!loadedVideo) return;
  const fps = Math.max(1, Math.min(120, parseInt(videoFpsEl.value, 10) || 30));
  state.videoToAudio.fps = fps;

  try {
    const buf = await extractVideoBytebeatBuffer(loadedVideo, fps, videoPreviewCanvas);
    if (!buf) return;
    state.videoToAudio.buffer = buf;
  } catch (err) {
    console.error('Failed to extract video frames', err);
  }
});

/* Video → Bytebeat (audio): play using image-processor */
playVideoAudioBtn.addEventListener('click', async () => {
  const buf = state.videoToAudio.buffer;
  if (!buf || buf.length === 0) return;
  await ensureAudio();
  const fps = state.videoToAudio.fps || (parseInt(videoFpsEl.value, 10) || 30);
  stopNode(imageNode);
  imageNode = createImageNode(buf, fps);
  imageNode.connect(audioCtx.destination);
  state.runningImage = true;
});

/* Video → Bytebeat (audio): stop playback */
stopVideoAudioBtn.addEventListener('click', () => {
  stopNode(imageNode);
  state.runningImage = false;
});

/* Video → Bytebeat (audio): save WAV */
saveVideoAudioWavBtn.addEventListener('click', () => {
  const buf = state.videoToAudio.buffer;
  if (!buf || buf.length === 0) return;
  const fps = state.videoToAudio.fps || (parseInt(videoFpsEl.value, 10) || 30);
  const sr = fps; // each sampled video frame is one audio frame at this rate

  const n = buf.length;
  const bps = 2;
  const dataLen = n * bps;
  const wavLen = 44 + dataLen;
  const ab = new ArrayBuffer(wavLen);
  const dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

  ws(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * bps, true);
  dv.setUint16(32, bps, true);
  dv.setUint16(34, 16, true);
  ws(36, 'data');
  dv.setUint32(40, dataLen, true);

  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const q = Math.max(-1, Math.min(1, (buf[i] - 128) / 128));
    dv.setInt16(o, q * 32767, true);
  }

  const blob = new Blob([ab], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'video-bytebeat.wav';
  a.click();
});

/* Mobile: resume audio on interaction */
['touchstart','pointerdown','keydown'].forEach(evt => {
  window.addEventListener(evt, async () => {
    if (audioCtx && audioCtx.state !== 'running') {
      await audioCtx.resume();
    }
  }, { passive: true });
});
/* ...existing code... */