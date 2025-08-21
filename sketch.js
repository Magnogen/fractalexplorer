on('load', () => {
  // --- Worker creation utility ---
  const createWorker = (fn) => {
    const blob = new Blob([`(${fn})()`], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  };

  // --- Worker: Mandelbrot tile renderer ---
  const workerFn = () => {
    const mandelbrot = (cx, cy, iterations) => {
      let zx = 0, zy = 0, zx2 = 0, zy2 = 0, i = 0;
      while (zx * zx + zy * zy < 64 && i < iterations) {
        // zx = Math.abs(zx);
        // zy = Math.abs(zy);
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
        zx2 = zx * zx;
        zy2 = zy * zy;
        i++;
      }
      if (i == iterations) return { escaped: false, color: [0, 0, 0] };

      const smoothI = i - Math.log2(Math.log2(zx*zx + zy*zy)) + 4.0;
      
      const saturation = 0.75;
      
      const r = saturation*Math.sin(smoothI + 2*Math.PI*0/3)/2 + 1/2;
      const g = saturation*Math.sin(smoothI + 2*Math.PI*1/3)/2 + 1/2;
      const b = saturation*Math.sin(smoothI + 2*Math.PI*2/3)/2 + 1/2;

      return { escaped: true, iterations: i, color: [r*255, g*255, b*255] };
    };
    
    self.onmessage = (e) => {
      const { width, height, iterations, x, y, dx, dy, tx, ty } = e.data;
      const result = new Uint8ClampedArray(4 * width * height);

      const AA = 4;
      const offsets = [];
      for (let i = 0; i < AA; i++) {
        for (let j = 0; j < AA; j++) {
          offsets.push([(i + 0.5) / AA, (j + 0.5) / AA]);
        }
      }
      
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const cx = x + (px / width) * dx;
          const cy = y + (py / height) * dy;
          
          const base = mandelbrot(cx, cy, iterations);
          const needsRefine = base.iterations > iterations / 8;
          let finalColor = base.color;
          
          if (base.escaped && needsRefine) {
            let acc = [0, 0, 0];

            for (const [ox, oy] of offsets) {
              const subCx = x + ((px + ox) / width) * dx;
              const subCy = y + ((py + oy) / height) * dy;

              const sub = mandelbrot(subCx, subCy, iterations);

              acc[0] += sub.color[0];
              acc[1] += sub.color[1];
              acc[2] += sub.color[2];
            }

            finalColor = acc.map((v) => v / (offsets.length));
          }
          
          const index = 4 * (py * width + px);
          result[index + 0] = finalColor[0];
          result[index + 1] = finalColor[1];
          result[index + 2] = finalColor[2];
          
          result[index + 3] = 255;
        }
      }

      self.postMessage({ buffer: result.buffer, tx, ty }, [result.buffer]);
    };
  };

  const numWorkers = navigator.hardwareConcurrency || 4; // use # of CPU cores if available
  const workers = Array.from({ length: numWorkers }, () => ({ isBusy: false, worker: createWorker(workerFn) }));

  // --- Canvas setup ---
  const c = $('canvas');
  const ctx = c.getContext('2d');
  c.width = innerWidth;
  c.height = innerHeight;

  const frameSize = 64;
  const tilesX = Math.ceil(c.width / frameSize);
  const tilesY = Math.ceil(c.height / frameSize);

  // Viewport in fractal space
  let view = {
    x: -2.5,
    y: -1.5,
    w: 3.5,
    h: 3.5 * innerHeight/innerWidth,
  };
  
  // --- Job queue management ---
  let jobQueue = [];
  
  function processNext() {
    workers.forEach((worker) => {
      if (jobQueue.length == 0) return;
      if (worker.isBusy) return;
      const job = jobQueue.shift();
      worker.isBusy = true;
      worker.worker.postMessage(job);
    });
  }
  
  // Store full rendered fractal in a buffer canvas
  const bufferCanvas = document.createElement('canvas');
  bufferCanvas.width = c.width;
  bufferCanvas.height = c.height;
  const bufferCtx = bufferCanvas.getContext('2d');

  workers.forEach((worker) => {
    worker.worker.onmessage = (e) => {
      worker.isBusy = false;
      const { buffer, tx, ty } = e.data;
      const imageData = new ImageData(new Uint8ClampedArray(buffer), frameSize);
      bufferCtx.putImageData(imageData, tx * frameSize, ty * frameSize);
      ctx.drawImage(bufferCanvas, 0, 0);
      processNext(); // assign next job
    };
  });
  
  const getIterations = (view, initialWidth) => {
    const zoom = initialWidth / view.w;
    const base = 256;
    const factor = 128;
    return Math.max(base, Math.floor(base + factor * Math.log2(zoom)));
  }

  // --- Clear + refill queue ---
  const render = () => {
    const iterations = getIterations(view, 3.5);
    jobQueue = (Array.from({ length: tilesY * tilesX }, (_, i) => {
      const tx = i % tilesX, ty = (i / tilesX) | 0;
      
      const x = view.x + (tx * frameSize / c.width) * view.w;
      const y = view.y + (ty * frameSize / c.height) * view.h;
      
      const dx = (frameSize / c.width) * view.w;
      const dy = (frameSize / c.height) * view.h;
      
      return { width: frameSize, height: frameSize, iterations, x, y, dx, dy, tx, ty };
    }));
    processNext();
  }

  // --- FSM for interaction ---
  let panStart = null;
  let pinchStart = null;
  
  const finishPan = (ev) => {
    ev.preventDefault();
    const dxPx = ev.clientX - panStart.x;
    const dyPx = ev.clientY - panStart.y;
    
    view.x = panStart.view.x - (dxPx / c.width) * view.w;
    view.y = panStart.view.y - (dyPx / c.height) * view.h;
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(dxPx, dyPx);
    ctx.drawImage(bufferCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    bufferCtx.clearRect(0, 0, c.width, c.height);
    bufferCtx.drawImage(c, 0, 0);
    
    render();
    return 'idle';
  };

  const fsm = FSM({
    states: {
      idle: {
        mousedown: (ev) => {
          ev.preventDefault();
          panStart = { x: ev.clientX, y: ev.clientY, view: { ...view } };
          return 'panning';
        },
        touchstart: (ev) => {
          ev.preventDefault();
          if (ev.touches.length === 1) {
            const t = ev.touches[0];
            panStart = { x: t.clientX, y: t.clientY, view: { ...view } };
            return 'panning';
          } else if (ev.touches.length === 2) {
            const [t1, t2] = ev.touches;
            pinchStart = {
              cx: (t1.clientX + t2.clientX) / 2,
              cy: (t1.clientY + t2.clientY) / 2,
              dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
              view: { ...view }
            };
            return 'pinching';
          }
        },
        wheel: (ev) => {
          ev.preventDefault();

          const zoomFactor = ev.deltaY < 0 ? 9/10 : 10/9;
          const mouseX = ev.offsetX;
          const mouseY = ev.offsetY;

          const cx = view.x + (mouseX / c.width) * view.w;
          const cy = view.y + (mouseY / c.height) * view.h;

          const newW = view.w * zoomFactor;
          const newH = view.h * zoomFactor;

          view.x = cx - ((mouseX / c.width) * newW);
          view.y = cy - ((mouseY / c.height) * newH);
          view.w = newW;
          view.h = newH;
          
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);

          ctx.translate(mouseX, mouseY);
          ctx.scale(1/zoomFactor, 1/zoomFactor);
          ctx.translate(-mouseX, -mouseY);

          ctx.drawImage(bufferCanvas, 0, 0);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          bufferCtx.clearRect(0, 0, c.width, c.height);
          bufferCtx.drawImage(c, 0, 0);
          
          render();
        }
      },
      panning: {
        mousemove: (ev) => {
          ev.preventDefault();
          const dxPx = ev.clientX - panStart.x;
          const dyPx = ev.clientY - panStart.y;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.translate(dxPx, dyPx);
          ctx.drawImage(bufferCanvas, 0, 0);
        },
        touchstart: (ev) => {
          ev.preventDefault();
          if (ev.touches.length === 2) {
            const [t1, t2] = ev.touches;
            pinchStart = {
              cx: (t1.clientX + t2.clientX) / 2,
              cy: (t1.clientY + t2.clientY) / 2,
              dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
              view: { ...view }
            };
            return 'pinching';
          }
        },
        touchmove: (ev) => {
          ev.preventDefault();
          if (ev.touches.length != 1) return;
          const t = ev.touches[0];
          const dxPx = t.clientX - panStart.x;
          const dyPx = t.clientY - panStart.y;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.translate(dxPx, dyPx);
          ctx.drawImage(bufferCanvas, 0, 0);
        },
        touchend: (ev) => {
          ev.preventDefault();
          if (ev.touches.length === 0) {
            const t = ev.changedTouches[0];
            return finishPan({
              clientX: t.clientX,
              clientY: t.clientY,
              preventDefault: () => {} // no-op, already handled
            });
          }
        },
        mouseup: finishPan,
        mouseleave: (ev) => {
          if (ev.clientX && ev.clientY) return finishPan(ev);
          return 'idle';
        }
      },
      pinching: {
        touchmove: (ev) => {
          ev.preventDefault();
          if (ev.touches.length != 2) return;
          const [t1, t2] = ev.touches;
          const cx = (t1.clientX + t2.clientX) / 2;
          const cy = (t1.clientY + t2.clientY) / 2;
          const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

          const zoomFactor = pinchStart.dist / dist;

          // same math as wheel zoom
          const mouseX = pinchStart.cx;
          const mouseY = pinchStart.cy;
          const newW = pinchStart.view.w * zoomFactor;
          const newH = pinchStart.view.h * zoomFactor;

          view.x = pinchStart.view.x + (mouseX / c.width) * (pinchStart.view.w - newW);
          view.y = pinchStart.view.y + (mouseY / c.height) * (pinchStart.view.h - newH);
          view.w = newW;
          view.h = newH;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.translate(mouseX, mouseY);
          ctx.scale(1/zoomFactor, 1/zoomFactor);
          ctx.translate(-mouseX, -mouseY);
          ctx.drawImage(bufferCanvas, 0, 0);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        },
        touchend: (ev) => {
          ev.preventDefault();
          if (ev.touches.length === 1) {
            const t = ev.touches[0];
            panStart = { x: t.clientX, y: t.clientY, view: { ...view } };
            render();
            return 'panning';
          }
          if (ev.touches.length === 0) {
            render();
            return 'idle';
          }
        }
      }
    }
  });

  // --- Event bindings ---
  c.addEventListener('mousedown',   fsm.event('mousedown'));
  c.addEventListener('mousemove',   fsm.event('mousemove'));
  c.addEventListener('mouseup',     fsm.event('mouseup'));
  c.addEventListener('mouseleave',  fsm.event('mouseleave'));
  c.addEventListener('wheel',       fsm.event('wheel'));
  
  c.addEventListener('touchstart',  fsm.event('touchstart'), { passive: false });
  c.addEventListener('touchmove',   fsm.event('touchmove'),  { passive: false });
  c.addEventListener('touchend',    fsm.event('touchend'),   { passive: false });
  c.addEventListener('touchcancel', fsm.event('touchend'),   { passive: false });


  // First render
  render();
});
