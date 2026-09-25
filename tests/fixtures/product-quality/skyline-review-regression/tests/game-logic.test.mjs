import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_COUNT,
  countRemainingAmmo,
  countRemainingTargets,
  createGameState,
  getImpactIds,
  resolveLaunch,
} from '../src/game-logic.mjs';

test('a new round starts with twelve live targets and seven warheads', () => {
  const state = createGameState();

  assert.equal(countRemainingTargets(state), TARGET_COUNT);
  assert.equal(countRemainingAmmo(state), 7);
  assert.equal(state.selectedMissile, 'precision');
});

test('kinetic missile clears exactly the selected room and consumes one round', () => {
  const initial = createGameState();
  const result = resolveLaunch(initial, 'precision', 0);

  assert.equal(result.accepted, true);
  assert.deepEqual(result.destroyedIds, [0]);
  assert.equal(result.state.targets[0].destroyed, true);
  assert.equal(countRemainingTargets(result.state), 11);
  assert.equal(result.state.ammo.precision, 2);
  assert.equal(result.state.turn, 1);
});

test('shockwave clears the full 3 by 3 neighborhood around a center target', () => {
  const result = resolveLaunch(createGameState(), 'shockwave', 5);

  assert.deepEqual(result.destroyedIds, [0, 1, 2, 4, 5, 6, 8, 9, 10]);
  assert.equal(countRemainingTargets(result.state), 3);
  assert.equal(result.state.ammo.shockwave, 1);
});

test('cluster follows a vertical chain and can secure the building', () => {
  let state = createGameState();
  state = resolveLaunch(state, 'precision', 0).state;
  state = resolveLaunch(state, 'shockwave', 5).state;
  const result = resolveLaunch(state, 'cluster', 3);

  assert.deepEqual(getImpactIds('cluster', 3), [3, 7, 11]);
  assert.deepEqual(result.destroyedIds, [3, 7, 11]);
  assert.equal(result.state.result, 'won');
  assert.equal(countRemainingTargets(result.state), 0);
  assert.equal(result.message, 'Building secured');
});

test('cluster always keeps its promised three-room vertical footprint', () => {
  assert.deepEqual(getImpactIds('cluster', 1), [1, 5, 9]);
  assert.deepEqual(getImpactIds('cluster', 5), [1, 5, 9]);
  assert.deepEqual(getImpactIds('cluster', 9), [1, 5, 9]);
});

test('the final spent warhead produces a recoverable loss result', () => {
  let state = createGameState();
  state = {
    ...state,
    ammo: {precision: 1, shockwave: 0, cluster: 0},
    targets: state.targets.map((target) => ({...target, destroyed: target.id !== 11})),
  };
  const result = resolveLaunch(state, 'precision', 11);

  assert.equal(result.state.result, 'won');

  const lossState = {
    ...state,
    targets: state.targets.map((target) => ({...target, destroyed: target.id !== 10 && target.id !== 11})),
  };
  const loss = resolveLaunch(lossState, 'precision', 10);
  assert.equal(loss.state.result, 'lost');
  assert.equal(loss.message, 'Warheads depleted — sector still active');
});

test('depleting the selected rack automatically arms the next available rack', () => {
  let state = createGameState();
  state = resolveLaunch(state, 'precision', 0).state;
  state = resolveLaunch(state, 'precision', 1).state;
  state = resolveLaunch(state, 'precision', 2).state;

  assert.equal(state.ammo.precision, 0);
  assert.equal(state.selectedMissile, 'shockwave');
  assert.equal(state.isLaunching, false);
});

test('a spent rack and completed round reject new launches without mutating state', () => {
  let state = createGameState();
  state = {...state, ammo: {...state.ammo, precision: 0}};
  const empty = resolveLaunch(state, 'precision', 0);

  assert.equal(empty.accepted, false);
  assert.equal(empty.state, state);

  const completed = {...state, result: 'won'};
  const afterWin = resolveLaunch(completed, 'shockwave', 5);
  assert.equal(afterWin.accepted, false);
  assert.equal(afterWin.state, completed);
});
