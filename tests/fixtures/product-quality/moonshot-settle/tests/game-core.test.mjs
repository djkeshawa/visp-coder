import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  clamp,
  distance,
  circleRectCollision,
  resolveCircleRectCollision,
  stepProjectile,
  impactScore,
} = require('../game-core.js');

test('clamp and distance provide stable geometry primitives', () => {
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('circleRectCollision returns a contact normal and penetration depth', () => {
  const contact = circleRectCollision(
    { x: 12, y: 20, radius: 12 },
    { x: 20, y: 10, width: 30, height: 20 },
  );

  assert.equal(contact.hit, true);
  assert.deepEqual(contact.normal, { x: -1, y: 0 });
  assert.equal(contact.penetration, 4);
});

test('resolveCircleRectCollision separates an incoming projectile and reflects it', () => {
  const result = resolveCircleRectCollision(
    { x: 12, y: 20, radius: 12, vx: 100, vy: 0 },
    { x: 20, y: 10, width: 30, height: 20 },
    0.5,
  );

  assert.equal(result.collided, true);
  assert.equal(result.x, 8);
  assert.equal(result.vx, -50);
  assert.equal(result.impactSpeed, 100);
});

test('stepProjectile applies gravity and bounces from the ground', () => {
  const result = stepProjectile(
    { x: 120, y: 90, radius: 10, vx: 50, vy: 100 },
    0.5,
    100,
    { gravity: 200, restitution: 0.5, groundFriction: 0.8 },
  );

  assert.equal(result.x, 145);
  assert.equal(result.y, 90);
  assert.equal(result.vy, -100);
  assert.equal(result.bounced, true);
});

test('impactScore rewards faster hits and tougher materials', () => {
  assert.equal(impactScore(0, 'wood'), 20);
  assert.ok(impactScore(280, 'glass') > impactScore(280, 'wood'));
  assert.ok(impactScore(280, 'stone') > impactScore(280, 'glass'));
});
