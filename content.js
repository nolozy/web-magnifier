(() => {
  const MIN_SELECTION = 20;
  const MIN_WIDTH = 50;
  const MARGIN = 20;
  // Chrome allows captureVisibleTab twice per second
  const CAPTURE_INTERVAL = 550;

  let overlay = null;
  let closeMagnifier = null;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== "toggle") return;
    if (overlay) {
      cancelSelection();
    } else {
      startSelection();
    }
    sendResponse();
  });

  // Page elements outside the fullscreen element are not rendered.
  // A fullscreen <video> cannot hold children, so the page stays the parent then.
  function getParent() {
    const fullscreen = document.fullscreenElement;
    return fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.documentElement;
  }

  // --- Selecting the area ---

  function startSelection() {
    if (closeMagnifier) closeMagnifier();

    overlay = document.createElement("div");
    overlay.className = "wm-overlay";
    getParent().appendChild(overlay);

    overlay.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("fullscreenchange", cancelSelection);
  }

  function cancelSelection() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("fullscreenchange", cancelSelection);
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancelSelection();
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const box = document.createElement("div");
    box.className = "wm-selection-box";
    overlay.appendChild(box);
    overlay.setPointerCapture(e.pointerId);

    const getRect = (ev) => ({
      left: Math.min(ev.clientX, startX),
      top: Math.min(ev.clientY, startY),
      width: Math.abs(ev.clientX - startX),
      height: Math.abs(ev.clientY - startY),
    });

    const onMove = (ev) => {
      const rect = getRect(ev);
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };
    onMove(e);

    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", (ev) => {
      const rect = getRect(ev);
      cancelSelection();
      if (rect.width > MIN_SELECTION && rect.height > MIN_SELECTION) {
        createMagnifier(rect);
      }
    }, { once: true });
  }

  // --- What the selection is on top of ---

  function findVideoAt(x, y, root = document, seen = new Set()) {
    for (const el of root.elementsFromPoint(x, y)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.tagName === "VIDEO") return el;
      if (el.shadowRoot) {
        const video = findVideoAt(x, y, el.shadowRoot, seen);
        if (video) return video;
      }
    }
    return null;
  }

  // Where the frame is drawn inside the <video> box (object-fit can letterbox or crop it)
  function getFrameRect(video) {
    const box = video.getBoundingClientRect();
    const sx = box.width / video.videoWidth;
    const sy = box.height / video.videoHeight;
    let scaleX = sx;
    let scaleY = sy;
    const fit = getComputedStyle(video).objectFit;
    if (fit === "contain") scaleX = scaleY = Math.min(sx, sy);
    if (fit === "cover") scaleX = scaleY = Math.max(sx, sy);
    if (fit === "none") scaleX = scaleY = 1;
    if (fit === "scale-down") scaleX = scaleY = Math.min(sx, sy, 1);
    const width = video.videoWidth * scaleX;
    const height = video.videoHeight * scaleY;
    return {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width,
      height,
    };
  }

  function getVideoSource(rect) {
    const video = findVideoAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!video || !video.videoWidth) return null;

    const frame = getFrameRect(video);
    const fits = rect.left >= frame.left - 1 && rect.top >= frame.top - 1 &&
      rect.left + rect.width <= frame.left + frame.width + 1 &&
      rect.top + rect.height <= frame.top + frame.height + 1;
    if (!fits) return null;

    // In video pixels, so it survives resizing the player and going fullscreen
    const scaleX = video.videoWidth / frame.width;
    const scaleY = video.videoHeight / frame.height;
    return {
      video,
      x: (rect.left - frame.left) * scaleX,
      y: (rect.top - frame.top) * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    };
  }

  // --- The magnifier window ---

  function overlaps(a, b) {
    return a.left < b.left + b.width && b.left < a.left + a.width &&
      a.top < b.top + b.height && b.top < a.top + a.height;
  }

  function getInitialRect(selection) {
    const scale = Math.min(
      2,
      (innerWidth - MARGIN * 2) / selection.width,
      (innerHeight - MARGIN * 2) / selection.height
    );
    const width = selection.width * scale;
    const height = selection.height * scale;
    const right = innerWidth - width - MARGIN;
    const bottom = innerHeight - height - MARGIN;
    const corners = [
      { left: MARGIN, top: MARGIN },
      { left: right, top: MARGIN },
      { left: MARGIN, top: bottom },
      { left: right, top: bottom },
    ].map((corner) => ({ ...corner, width, height }));
    return corners.find((corner) => !overlaps(corner, selection)) || corners[0];
  }

  function createMagnifier(selection) {
    const videoSource = getVideoSource(selection);
    const initial = getInitialRect(selection);
    const aspectRatio = selection.width / selection.height;

    const container = document.createElement("div");
    container.className = "wm-magnifier";
    container.style.left = `${initial.left}px`;
    container.style.top = `${initial.top}px`;
    container.style.width = `${initial.width}px`;
    container.style.height = `${initial.height}px`;

    const canvas = document.createElement("canvas");
    container.appendChild(canvas);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "wm-close-btn";
    closeBtn.textContent = "×";
    closeBtn.title = "Close";
    container.appendChild(closeBtn);

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "wm-resize-handle";
    container.appendChild(resizeHandle);

    getParent().appendChild(container);

    const ctx = canvas.getContext("2d");
    let alive = true;
    let draw = () => {};

    const resizeObserver = new ResizeObserver(() => {
      canvas.width = Math.max(1, Math.round(container.clientWidth * devicePixelRatio));
      canvas.height = Math.max(1, Math.round(container.clientHeight * devicePixelRatio));
      draw();
    });
    resizeObserver.observe(container);

    const onFullscreenChange = () => getParent().appendChild(container);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    const stopSource = videoSource
      ? startVideoSource(videoSource)
      : startScreenSource(selection);

    function close() {
      alive = false;
      closeMagnifier = null;
      stopSource();
      resizeObserver.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      container.remove();
    }
    closeMagnifier = close;

    closeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", close);
    makeDraggable(container);
    makeResizable(container, resizeHandle, aspectRatio);

    // <video>: draw the frame directly, every animation frame at the video's own resolution
    function startVideoSource({ video, x, y, width, height }) {
      let animationId = 0;
      const loop = () => {
        if (!video.isConnected) {
          close();
          return;
        }
        draw();
        animationId = requestAnimationFrame(loop);
      };
      draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (video.videoWidth) ctx.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
      };
      loop();
      return () => cancelAnimationFrame(animationId);
    }

    // Anything else: crop screenshots of the tab
    function startScreenSource(rect) {
      let frame = null;

      draw = () => {
        if (!frame) return;
        const scale = frame.width / innerWidth;
        ctx.drawImage(
          frame,
          rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale,
          0, 0, canvas.width, canvas.height
        );
      };

      const captureOnce = async () => {
        // Keep the magnifier out of its own picture
        const hide = overlaps(container.getBoundingClientRect(), rect);
        if (hide) {
          container.style.visibility = "hidden";
          await nextPaint();
        }
        let response;
        try {
          response = await chrome.runtime.sendMessage({ action: "capture" });
        } finally {
          if (hide) container.style.visibility = "";
        }
        if (response.error) {
          console.warn("Web Magnifier:", response.error);
          return;
        }
        const bitmap = await decodeDataUrl(response.dataUrl);
        if (!alive) {
          bitmap.close();
          return;
        }
        if (frame) frame.close();
        frame = bitmap;
        draw();
      };

      const loop = async () => {
        await nextPaint();
        while (alive) {
          const startedAt = performance.now();
          if (!document.hidden) await captureOnce();
          await sleep(CAPTURE_INTERVAL - (performance.now() - startedAt));
        }
      };
      loop().catch((err) => {
        // The extension was reloaded or removed
        console.warn("Web Magnifier:", err);
        if (alive) close();
      });

      return () => {
        if (frame) frame.close();
        frame = null;
      };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  // requestAnimationFrame stops in a background tab, so the wait is capped
  function nextPaint() {
    const frames = new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return Promise.race([frames, sleep(100)]);
  }

  // Decoded by hand because a page's CSP can block fetch() and <img> on data: URLs
  function decodeDataUrl(dataUrl) {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: "image/png" }));
  }

  function followPointer(element, e, onMove) {
    e.preventDefault();
    e.stopPropagation();
    // Keeps the events coming while the pointer is over an iframe
    element.setPointerCapture(e.pointerId);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", () => {
      element.removeEventListener("pointermove", onMove);
    }, { once: true });
  }

  function makeDraggable(element) {
    element.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const box = element.getBoundingClientRect();
      followPointer(element, e, (ev) => {
        // A part of the window always stays on screen
        const left = box.left + ev.clientX - startX;
        const top = box.top + ev.clientY - startY;
        element.style.left = `${Math.min(Math.max(left, MIN_WIDTH - box.width), innerWidth - MIN_WIDTH)}px`;
        element.style.top = `${Math.min(Math.max(top, 0), innerHeight - MIN_WIDTH)}px`;
      });
    });
  }

  function makeResizable(container, handle, aspectRatio) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startWidth = container.getBoundingClientRect().width;
      followPointer(handle, e, (ev) => {
        const width = Math.max(MIN_WIDTH, startWidth + ev.clientX - startX);
        container.style.width = `${width}px`;
        container.style.height = `${width / aspectRatio}px`;
      });
    });
  }
})();
