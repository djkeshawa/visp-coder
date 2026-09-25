/// <reference lib="dom" />

/** Executed in the page by the runner. Geometry is evidence, never a quality verdict. */
export function measureRenderedLayout() {
  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`.slice(0, 100);
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
        return false;
    }
    return true;
  };
  const clippedFraction = (element: Element) => {
    const rect = element.getBoundingClientRect();
    let left = rect.left,
      right = rect.right,
      top = rect.top,
      bottom = rect.bottom;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return (Math.max(0, right - left) * Math.max(0, bottom - top)) / (rect.width * rect.height);
  };
  const canvasNodes = document.querySelectorAll("canvas");
  const canvases = Array.from(canvasNodes).slice(0, 16).filter(visible);
  const canvasMeasurements = canvases.slice(0, 4).map((canvas) => {
    const style = getComputedStyle(canvas);
    const width =
      canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height =
      canvas.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return {
      element: label(canvas),
      viewportAreaFraction: Math.min(1, (width * height) / Math.max(1, innerWidth * innerHeight)),
      intrinsic: { width: canvas.width, height: canvas.height },
      content: { width, height },
      scaleRatio:
        width > 0 && canvas.height > 0 ? (height * canvas.width) / (width * canvas.height) : null,
    };
  });
  // Bounded scan of controls and text, including non-semantic game overlays.
  const candidates = document.querySelectorAll(
    "button,a,input,select,textarea,[tabindex],h1,h2,h3,p",
  );
  const clipped = [];
  const controls = [];
  let inspected = 0;
  for (const element of Array.from(candidates).slice(0, 160)) {
    inspected++;
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (controls.length < 12 && element.matches("button,a,input,select,textarea,[tabindex]"))
      controls.push({
        element: label(element),
        width: rect.width,
        height: rect.height,
        inViewport:
          rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
      });
    const fraction = clippedFraction(element);
    if (fraction < 0.98)
      clipped.push({
        element: label(element),
        visibleFraction: Math.round(fraction * 1000) / 1000,
      });
    if (clipped.length >= 8) break;
  }
  return {
    version: 1,
    viewport: { width: innerWidth, height: innerHeight },
    canvases: canvasMeasurements,
    clipped,
    controls,
    omittedCanvases: Math.max(0, canvasNodes.length - canvasMeasurements.length),
    uninspectedElements: Math.max(0, candidates.length - inspected),
  };
}
