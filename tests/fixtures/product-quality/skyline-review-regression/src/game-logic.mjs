export const GRID_COLUMNS = 4;
export const GRID_ROWS = 3;
export const TARGET_COUNT = GRID_COLUMNS * GRID_ROWS;

export const MISSILES = Object.freeze({
  precision: Object.freeze({
    id: 'precision',
    label: 'Kinetic',
    ammo: 3,
    role: 'One room / direct hit',
    impactMessage: 'Kinetic impact confirmed',
  }),
  shockwave: Object.freeze({
    id: 'shockwave',
    label: 'Shockwave',
    ammo: 2,
    role: '3 × 3 blast radius',
    impactMessage: 'Shockwave impact confirmed',
  }),
  cluster: Object.freeze({
    id: 'cluster',
    label: 'Cluster',
    ammo: 2,
    role: 'Three linked strikes',
    impactMessage: 'Cluster impact confirmed',
  }),
});

const missileIds = Object.freeze(Object.keys(MISSILES));

function createTargets() {
  return Array.from({length: TARGET_COUNT}, (_, id) => ({
    id,
    row: Math.floor(id / GRID_COLUMNS),
    column: id % GRID_COLUMNS,
    destroyed: false,
  }));
}

function createAmmo() {
  return Object.fromEntries(missileIds.map((id) => [id, MISSILES[id].ammo]));
}

export function createGameState() {
  return {
    targets: createTargets(),
    ammo: createAmmo(),
    selectedMissile: 'precision',
    turn: 0,
    isLaunching: false,
    result: null,
    lastImpact: null,
  };
}

export function getTarget(state, targetId) {
  return state.targets.find((target) => target.id === Number(targetId));
}

export function countRemainingTargets(state) {
  return state.targets.filter((target) => !target.destroyed).length;
}

export function countRemainingAmmo(state) {
  return missileIds.reduce((total, missileId) => total + state.ammo[missileId], 0);
}

export function getImpactIds(missileId, targetId) {
  const id = Number(targetId);
  const targetRow = Math.floor(id / GRID_COLUMNS);
  const targetColumn = id % GRID_COLUMNS;

  if (missileId === 'precision') {
    return [id];
  }

  if (missileId === 'shockwave') {
    return Array.from({length: TARGET_COUNT}, (_, candidateId) => candidateId).filter((candidateId) => {
      const row = Math.floor(candidateId / GRID_COLUMNS);
      const column = candidateId % GRID_COLUMNS;
      return Math.abs(row - targetRow) <= 1 && Math.abs(column - targetColumn) <= 1;
    });
  }

  if (missileId === 'cluster') {
    return Array.from({length: GRID_ROWS}, (_, row) => targetColumn + row * GRID_COLUMNS);
  }

  return [];
}

function getImpactMessage(missileId, destroyedCount, result) {
  if (result === 'won') {
    return 'Building secured';
  }

  if (destroyedCount === 0) {
    return 'Impact registered — target already cold';
  }

  if (result === 'lost') {
    return 'Warheads depleted — sector still active';
  }

  return `${MISSILES[missileId].impactMessage} · ${destroyedCount} ${destroyedCount === 1 ? 'room' : 'rooms'} cleared`;
}

export function resolveLaunch(state, missileId, targetId) {
  const target = getTarget(state, targetId);
  const missile = MISSILES[missileId];

  if (!missile) {
    return {state, destroyedIds: [], message: 'Unknown warhead', accepted: false};
  }

  if (state.result) {
    return {state, destroyedIds: [], message: 'Round complete — restart to redeploy', accepted: false};
  }

  if (!target) {
    return {state, destroyedIds: [], message: 'Target lock failed', accepted: false};
  }

  if (state.ammo[missileId] <= 0) {
    return {state, destroyedIds: [], message: `${missile.label} rack empty`, accepted: false};
  }

  const impactIds = getImpactIds(missileId, target.id);
  const destroyedIds = impactIds.filter((impactId) => !state.targets[impactId].destroyed);
  const destroyedSet = new Set(destroyedIds);
  const targets = state.targets.map((candidate) => ({
    ...candidate,
    destroyed: candidate.destroyed || destroyedSet.has(candidate.id),
  }));
  const ammo = {...state.ammo, [missileId]: state.ammo[missileId] - 1};
  const remainingTargets = targets.filter((candidate) => !candidate.destroyed).length;
  const remainingAmmo = Object.values(ammo).reduce((total, count) => total + count, 0);
  const result = remainingTargets === 0 ? 'won' : remainingAmmo === 0 ? 'lost' : null;
  const selectedMissile = ammo[missileId] > 0
    ? state.selectedMissile
    : missileIds.find((candidateId) => ammo[candidateId] > 0) ?? missileId;

  return {
    state: {
      ...state,
      targets,
      ammo,
      selectedMissile,
      turn: state.turn + 1,
      result,
      lastImpact: {missileId, targetId: target.id, destroyedIds},
      isLaunching: false,
    },
    destroyedIds,
    message: getImpactMessage(missileId, destroyedIds.length, result),
    accepted: true,
  };
}
