(function exposePhysics(globalScope) {
  const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

  const distance = (first, second) => Math.hypot(second.x - first.x, second.y - first.y);

  const magnitude = (vector) => Math.hypot(vector.x, vector.y);

  function circleRectCollision(circle, rectangle) {
    const width = rectangle.width ?? rectangle.w;
    const height = rectangle.height ?? rectangle.h;
    const nearestX = clamp(circle.x, rectangle.x, rectangle.x + width);
    const nearestY = clamp(circle.y, rectangle.y, rectangle.y + height);
    let offsetX = circle.x - nearestX;
    let offsetY = circle.y - nearestY;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    if (distanceSquared > circle.radius * circle.radius) {
      return { hit: false, normal: { x: 0, y: 0 }, penetration: 0 };
    }

    if (distanceSquared === 0) {
      const distances = [
        { distance: Math.abs(circle.x - rectangle.x), normal: { x: -1, y: 0 } },
        { distance: Math.abs(rectangle.x + width - circle.x), normal: { x: 1, y: 0 } },
        { distance: Math.abs(circle.y - rectangle.y), normal: { x: 0, y: -1 } },
        { distance: Math.abs(rectangle.y + height - circle.y), normal: { x: 0, y: 1 } },
      ];
      const nearestEdge = distances.reduce((closest, candidate) => (
        candidate.distance < closest.distance ? candidate : closest
      ));

      return {
        hit: true,
        normal: nearestEdge.normal,
        penetration: circle.radius + nearestEdge.distance,
      };
    }

    const hitDistance = Math.sqrt(distanceSquared);
    offsetX /= hitDistance;
    offsetY /= hitDistance;

    return {
      hit: true,
      normal: { x: offsetX, y: offsetY },
      penetration: circle.radius - hitDistance,
    };
  }

  function resolveCircleRectCollision(circle, velocity, rectangle, restitution = 0.42) {
    const collision = circleRectCollision(circle, rectangle);

    if (!collision.hit) {
      return {
        hit: false,
        position: { x: circle.x, y: circle.y },
        velocity: { x: velocity.x, y: velocity.y },
        normal: { x: 0, y: 0 },
        penetration: 0,
      };
    }

    const { normal, penetration } = collision;
    const position = {
      x: circle.x + normal.x * (penetration + 0.8),
      y: circle.y + normal.y * (penetration + 0.8),
    };
    const incomingSpeed = velocity.x * normal.x + velocity.y * normal.y;
    const nextVelocity = { x: velocity.x, y: velocity.y };

    if (incomingSpeed < 0) {
      nextVelocity.x -= (1 + restitution) * incomingSpeed * normal.x;
      nextVelocity.y -= (1 + restitution) * incomingSpeed * normal.y;
    }

    nextVelocity.x *= 0.84;
    nextVelocity.y *= 0.84;

    return {
      hit: true,
      position,
      velocity: nextVelocity,
      normal,
      penetration,
    };
  }

  function stepProjectile(projectile, deltaSeconds, bounds) {
    const nextProjectile = {
      ...projectile,
      vy: projectile.vy + bounds.gravity * deltaSeconds,
    };
    nextProjectile.x += nextProjectile.vx * deltaSeconds;
    nextProjectile.y += nextProjectile.vy * deltaSeconds;

    let bounced = false;
    let landed = false;

    if (nextProjectile.x - nextProjectile.radius < bounds.left) {
      nextProjectile.x = bounds.left + nextProjectile.radius;
      nextProjectile.vx = Math.abs(nextProjectile.vx) * bounds.restitution;
      bounced = true;
    }

    if (nextProjectile.x + nextProjectile.radius > bounds.right) {
      nextProjectile.x = bounds.right - nextProjectile.radius;
      nextProjectile.vx = -Math.abs(nextProjectile.vx) * bounds.restitution;
      bounced = true;
    }

    if (nextProjectile.y + nextProjectile.radius >= bounds.groundY) {
      nextProjectile.y = bounds.groundY - nextProjectile.radius;
      if (Math.abs(nextProjectile.vy) > 70) {
        nextProjectile.vy = -Math.abs(nextProjectile.vy) * bounds.restitution;
        nextProjectile.vx *= 0.78;
        bounced = true;
      } else {
        nextProjectile.vy = 0;
        nextProjectile.vx *= 0.88;
        landed = true;
      }
    }

    return { projectile: nextProjectile, bounced, landed };
  }

  function impactScore(speed, material) {
    const baseScore = material === 'pig' ? 100 : 25;
    const speedBonus = Math.round(Math.max(0, clamp(speed, 80, 320) - 80) * 0.3125);
    return baseScore + speedBonus;
  }

  const api = Object.freeze({
    clamp,
    distance,
    magnitude,
    circleRectCollision,
    resolveCircleRectCollision,
    stepProjectile,
    impactScore,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    globalScope.FuryPhysics = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
