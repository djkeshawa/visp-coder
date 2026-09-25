(function attachGameCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GameCore = api;
  }
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const EPSILON = 1e-7;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function distance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function circleRectCollision(circle, rect) {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const closest = {
      x: clamp(circle.x, rect.x, right),
      y: clamp(circle.y, rect.y, bottom),
    };
    const offset = {
      x: circle.x - closest.x,
      y: circle.y - closest.y,
    };
    const distanceSquared = offset.x ** 2 + offset.y ** 2;
    const radiusSquared = circle.radius ** 2;

    if (distanceSquared > radiusSquared) {
      return {
        hit: false,
        normal: { x: 0, y: 0 },
        penetration: 0,
        point: closest,
      };
    }

    if (distanceSquared > EPSILON) {
      const contactDistance = Math.sqrt(distanceSquared);
      return {
        hit: true,
        normal: {
          x: offset.x / contactDistance,
          y: offset.y / contactDistance,
        },
        penetration: circle.radius - contactDistance,
        point: closest,
      };
    }

    const distancesToEdges = [
      { distance: circle.x - rect.x, normal: { x: -1, y: 0 }, point: { x: rect.x, y: circle.y } },
      { distance: right - circle.x, normal: { x: 1, y: 0 }, point: { x: right, y: circle.y } },
      { distance: circle.y - rect.y, normal: { x: 0, y: -1 }, point: { x: circle.x, y: rect.y } },
      { distance: bottom - circle.y, normal: { x: 0, y: 1 }, point: { x: circle.x, y: bottom } },
    ];
    const nearestEdge = distancesToEdges.reduce((nearest, candidate) => (
      candidate.distance < nearest.distance ? candidate : nearest
    ));

    return {
      hit: true,
      normal: nearestEdge.normal,
      penetration: circle.radius + nearestEdge.distance,
      point: nearestEdge.point,
    };
  }

  function circleCircleCollision(first, second) {
    const offset = {
      x: first.x - second.x,
      y: first.y - second.y,
    };
    const contactDistance = Math.hypot(offset.x, offset.y);
    const combinedRadius = first.radius + second.radius;

    if (contactDistance > combinedRadius) {
      return { hit: false, normal: { x: 0, y: 0 }, penetration: 0 };
    }

    if (contactDistance <= EPSILON) {
      return {
        hit: true,
        normal: { x: 0, y: -1 },
        penetration: combinedRadius,
      };
    }

    return {
      hit: true,
      normal: {
        x: offset.x / contactDistance,
        y: offset.y / contactDistance,
      },
      penetration: combinedRadius - contactDistance,
    };
  }

  function resolveCircleRectCollision(body, rect, restitution = 0.45) {
    const contact = circleRectCollision(body, rect);
    if (!contact.hit) {
      return {
        ...body,
        collided: false,
        normal: { x: 0, y: 0 },
        penetration: 0,
        impactSpeed: 0,
      };
    }

    const velocityAlongNormal = (body.vx ?? 0) * contact.normal.x
      + (body.vy ?? 0) * contact.normal.y;
    const reflectedVelocity = {
      vx: body.vx ?? 0,
      vy: body.vy ?? 0,
    };

    if (velocityAlongNormal < 0) {
      const impulse = (1 + restitution) * velocityAlongNormal;
      reflectedVelocity.vx -= impulse * contact.normal.x;
      reflectedVelocity.vy -= impulse * contact.normal.y;
    }

    return {
      ...body,
      x: body.x + contact.normal.x * contact.penetration,
      y: body.y + contact.normal.y * contact.penetration,
      vx: reflectedVelocity.vx,
      vy: reflectedVelocity.vy,
      collided: true,
      normal: contact.normal,
      penetration: contact.penetration,
      impactSpeed: Math.max(0, -velocityAlongNormal),
    };
  }

  function stepProjectile(body, deltaTime, groundY, options = {}) {
    const gravity = options.gravity ?? 620;
    const restitution = options.restitution ?? 0.42;
    const groundFriction = options.groundFriction ?? 0.76;
    const bounds = options.bounds ?? {};
    const radius = body.radius ?? 0;
    const next = {
      ...body,
      x: body.x + (body.vx ?? 0) * deltaTime,
      y: body.y + (body.vy ?? 0) * deltaTime,
      vx: body.vx ?? 0,
      vy: (body.vy ?? 0) + gravity * deltaTime,
      bounced: false,
    };

    if (next.y + radius >= groundY) {
      next.y = groundY - radius;
      next.vy = -Math.abs(next.vy) * restitution;
      next.vx *= groundFriction;
      next.bounced = true;
    }

    if (Number.isFinite(bounds.left) && next.x - radius < bounds.left) {
      next.x = bounds.left + radius;
      next.vx = Math.abs(next.vx) * restitution;
    }
    if (Number.isFinite(bounds.right) && next.x + radius > bounds.right) {
      next.x = bounds.right - radius;
      next.vx = -Math.abs(next.vx) * restitution;
    }

    return next;
  }

  function impactScore(speed, material = 'wood') {
    const multiplier = {
      wood: 1,
      glass: 1.25,
      stone: 1.55,
      pig: 2,
    }[material] ?? 1;
    return Math.max(20, Math.round((20 + Math.max(0, speed) * 0.65) * multiplier));
  }

  return Object.freeze({
    clamp,
    distance,
    circleRectCollision,
    circleCircleCollision,
    resolveCircleRectCollision,
    stepProjectile,
    impactScore,
  });
});
