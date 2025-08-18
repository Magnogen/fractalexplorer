on('load', () => {
  // --- Worker creation utility ---
  const createWorker = (fn) => {
    const blob = new Blob([`(${fn})()`], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  };

  // --- Worker: Mandelbrot tile renderer ---
  const workerFn = () => {
    self.onmessage = (e) => {
      const { width, height, iterations, x0, y0, dx, dy, tx, ty } = e.data;
      const result = new Uint8ClampedArray(4 * width * height);

      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const cx = x0 + (px / width) * dx;
          const cy = y0 + (py / height) * dy;
          let zx = 0, zy = 0, i = 0;

          while (zx * zx + zy * zy < 5 && i < iterations) {
            let tmp = zx * zx - zy * zy + cx;
            zy = 2 * zx * zy + cy;
            zx = tmp;
            i++;
          }
          
          const smoothI = i - Math.log2(Math.log2(zx*zx + zy*zy)) + 4.0;
          const index = py * width + px;
          
          result[4 * index + 3] = 255;
          
          if (i == iterations) continue;
          
          result[4 * index + 0] = Math.cos((smoothI * 5)/255)*255;
          result[4 * index + 1] = Math.cos((smoothI * 9)/255)*255;
          result[4 * index + 2] = Math.cos((smoothI * 13)/255)*255;
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
  
  function enqueue(job) {
    jobQueue.push(job);
    processNext();
  }
  
  function processNext() {
    if (jobQueue.length === 0) return;
    workers.forEach((worker) => {
      if (worker.isBusy) return;
      const job = jobQueue.shift();
      if (!job) return;
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
  
  function getIterations(view, initialWidth) {
    const zoom = initialWidth / view.w;
    const base = 256;
    const factor = 128;
    return Math.floor(base + factor * Math.log2(zoom));
  }

  // --- Clear + refill queue ---
  function render() {
    jobQueue = [];
    working = false;

    const iterations = getIterations(view, 3.5);

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = view.x + (tx * frameSize / c.width) * view.w;
        const y0 = view.y + (ty * frameSize / c.height) * view.h;
        const dx = (frameSize / c.width) * view.w;
        const dy = (frameSize / c.height) * view.h;

        enqueue({
          width: frameSize,
          height: frameSize,
          iterations,  // dynamic now!
          x0, y0, dx, dy,
          tx, ty
        });
      }
    }
  }


  // --- FSM for interaction ---
  let panStart = null;

  const fsm = FSM({
    initially: 'idle',
    states: {
      idle: {
        mousedown: (ev) => {
          panStart = { x: ev.clientX, y: ev.clientY, view: { ...view } };
          return 'panning';
        },
        wheel: (ev) => {
          ev.preventDefault();

          const zoomFactor = ev.deltaY < 0 ? 0.8 : 1.25;
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

          render();
        }
      },
      panning: {
        mousemove: (ev) => {
          const dxPx = ev.clientX - panStart.x;
          const dyPx = ev.clientY - panStart.y;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.translate(dxPx, dyPx);
          ctx.drawImage(bufferCanvas, 0, 0);
        },
        mouseup: (ev) => {
          const dxPx = ev.clientX - panStart.x;
          const dyPx = ev.clientY - panStart.y;

          view.x = panStart.view.x - (dxPx / c.width) * view.w;
          view.y = panStart.view.y - (dyPx / c.height) * view.h;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          bufferCtx.clearRect(0, 0, c.width, c.height);
          render();

          return 'idle';
        },
        mouseleave: (ev) => {
          const dxPx = ev.clientX - panStart.x;
          const dyPx = ev.clientY - panStart.y;

          view.x = panStart.view.x - (dxPx / c.width) * view.w;
          view.y = panStart.view.y - (dyPx / c.height) * view.h;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          bufferCtx.clearRect(0, 0, c.width, c.height);
          render();

          return 'idle';
        }
      }
    }
  });

  // --- Event bindings ---
  c.addEventListener('mousedown', fsm.event('mousedown'));
  c.addEventListener('mousemove', fsm.event('mousemove'));
  c.addEventListener('mouseup', fsm.event('mouseup'));
  c.addEventListener('mouseleave', fsm.event('mouseleave'));
  c.addEventListener('wheel', fsm.event('wheel'));

  // First render
  render();
});
