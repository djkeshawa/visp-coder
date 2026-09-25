(function attachFowlPlayCore(root, factory) {
  const api = factory();
  root.FowlPlayCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCore() {
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function getLayout(width, height) {
    const slingY = height < 760 ? height - 170 : height - 160;
    const slingX = clamp(width * 0.15, 96, 184);
    return {
      width,
      height,
      groundY: slingY + 72,
      sling: { x: slingX, y: slingY },
      maxStretch: Math.min(122, Math.max(94, width * 0.12)),
      gravity: 900,
    };
  }

  function clampAim(anchor, pointer, maxStretch) {
    const dx = pointer.x - anchor.x;
    const dy = pointer.y - anchor.y;
    const length = Math.hypot(dx, dy);
    if (length <= maxStretch) return { x: pointer.x, y: pointer.y };
    const ratio = maxStretch / length;
    return { x: anchor.x + dx * ratio, y: anchor.y + dy * ratio };
  }

  function launchVelocity(anchor, releasePoint, power) {
    return {
      vx: (anchor.x - releasePoint.x) * power,
      vy: (releasePoint.y - anchor.y) * power,
    };
  }

  function stepBody(body, delta, gravity) {
    body.x += body.vx * delta;
    body.y += body.vy * delta;
    body.vy += gravity * delta;
    return body;
  }

  function circleIntersectsCircle(circle, other, padding = 0) {
    return distance(circle, other) <= circle.radius + other.radius + padding;
  }

  function circleIntersectsRect(circle, rect, padding = 0) {
    const nearestX = clamp(circle.x, rect.x - padding, rect.x + rect.width + padding);
    const nearestY = clamp(circle.y, rect.y - padding, rect.y + rect.height + padding);
    return Math.hypot(circle.x - nearestX, circle.y - nearestY) <= circle.radius;
  }

  function isOutOfBounds(body, width, height) {
    return body.x < -120 || body.x > width + 120 || body.y > height + 130 || body.y < -160;
  }

  function createBird(x, y, variant) {
    return { x, y, vx: 0, vy: 0, radius: 24, variant, rotation: 0 };
  }

  function createLevel(width, height) {
    const layout = getLayout(width, height);
    const clusterX = width < 600
      ? Math.min(width - 118, layout.sling.x + 108)
      : Math.min(width - 160, Math.max(layout.sling.x + 245, width * 0.37));
    const clusterY = layout.groundY - 270;
    return {
      layout,
      targets: [
        { id: "munch-1", x: clusterX, y: clusterY, radius: 26, alive: true },
        { id: "munch-2", x: clusterX + 52, y: clusterY + 28, radius: 26, alive: true },
        { id: "munch-3", x: clusterX + 52, y: clusterY - 28, radius: 26, alive: true },
      ],
      blocks: [
        { id: "wood-floor", x: clusterX - 4, y: layout.groundY - 54, width: 178, height: 18, material: "wood", alive: true },
        { id: "wood-left", x: clusterX + 4, y: layout.groundY - 154, width: 18, height: 100, material: "wood", alive: true },
        { id: "wood-right", x: clusterX + 152, y: layout.groundY - 154, width: 18, height: 100, material: "wood", alive: true },
        { id: "ice-roof", x: clusterX + 10, y: layout.groundY - 178, width: 154, height: 18, material: "ice", alive: true },
        { id: "ice-cap", x: clusterX + 60, y: layout.groundY - 210, width: 58, height: 16, material: "ice", alive: true },
      ],
    };
  }

  return {
    clamp,
    distance,
    getLayout,
    clampAim,
    launchVelocity,
    stepBody,
    circleIntersectsCircle,
    circleIntersectsRect,
    isOutOfBounds,
    createBird,
    createLevel,
  };
});
