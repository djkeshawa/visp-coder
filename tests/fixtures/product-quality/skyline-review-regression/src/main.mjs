import {
  MISSILES,
  TARGET_COUNT,
  countRemainingAmmo,
  countRemainingTargets,
  createGameState,
  getTarget,
  resolveLaunch,
} from './game-logic.mjs';

const refs = {
  building: document.querySelector('#building-grid'),
  scene: document.querySelector('#scene'),
  launcher: document.querySelector('#launcher'),
  trail: document.querySelector('#flight-trail'),
  impactLayer: document.querySelector('#impact-layer'),
  targetsRemaining: document.querySelector('#targets-remaining'),
  progressFill: document.querySelector('#progress-fill'),
  turnCount: document.querySelector('#turn-count'),
  ammoCount: document.querySelector('#ammo-count'),
  launchStatus: document.querySelector('#launch-status'),
  statusCard: document.querySelector('.status-card'),
  gameResult: document.querySelector('#game-result'),
  resultKicker: document.querySelector('#result-kicker'),
  resultTitle: document.querySelector('#result-title'),
  resultMessage: document.querySelector('#result-message'),
  restart: document.querySelector('#restart-button'),
  missionClock: document.querySelector('#mission-clock'),
};

let state = createGameState();
let clockStartedAt = performance.now();
let clockTimer;

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function renderTargets() {
  refs.building.innerHTML = state.targets.map((target) => {
    const room = twoDigits(target.id + 1);
    const targetState = target.destroyed ? 'is-destroyed' : '';
    const label = target.destroyed ? `Target ${room}, offline` : `Target ${room}, live heat signature`;
    return `<button class="target-window ${targetState}" data-target-id="${target.id}" type="button" aria-label="${label}" ${target.destroyed || state.isLaunching || state.result ? 'disabled' : ''}>
      <span class="room-number">${room}</span>
      <span class="window-glow" aria-hidden="true"></span>
    </button>`;
  }).join('');

  refs.building.querySelectorAll('.target-window:not(:disabled)').forEach((target) => {
    target.addEventListener('click', () => handleTargetClick(Number(target.dataset.targetId)));
  });
}

function renderMissiles() {
  document.querySelectorAll('.missile-card').forEach((button) => {
    const missileId = button.dataset.missileId;
    const ammo = state.ammo[missileId];
    button.classList.toggle('is-selected', state.selectedMissile === missileId);
    button.disabled = ammo === 0 || state.isLaunching || Boolean(state.result);
    const ammoPill = button.querySelector(`[data-ammo-for="${missileId}"]`);
    ammoPill.textContent = twoDigits(ammo);
  });
}

function renderResult() {
  const isWon = state.result === 'won';
  refs.gameResult.hidden = !state.result;
  refs.gameResult.classList.toggle('is-loss', !isWon);
  refs.resultKicker.textContent = isWon ? 'Mission report / 01' : 'Mission report / aborted';
  refs.resultTitle.innerHTML = isWon ? 'Building <em>secured.</em>' : 'Signal <em>lost.</em>';
  refs.resultMessage.textContent = isWon
    ? 'All heat signatures are down. Sector 07 is ready for recovery crews.'
    : 'All warheads are spent while live signatures remain. Recalibrate and try the block again.';
}

function renderStats() {
  const remaining = countRemainingTargets(state);
  const destroyed = TARGET_COUNT - remaining;
  const ammo = countRemainingAmmo(state);
  refs.targetsRemaining.innerHTML = `${remaining} <small>/ ${TARGET_COUNT}</small>`;
  refs.progressFill.style.width = `${(destroyed / TARGET_COUNT) * 100}%`;
  refs.turnCount.textContent = `Turn ${twoDigits(state.turn)}`;
  refs.ammoCount.textContent = `${ammo} warheads ready`;
}

function render() {
  renderTargets();
  renderMissiles();
  renderStats();
  renderResult();
}

function setStatus(message, tone = 'ready') {
  refs.launchStatus.textContent = message;
  refs.statusCard.classList.toggle('is-flight', tone === 'flight');
  refs.statusCard.classList.toggle('is-success', tone === 'success');
}

function selectMissile(missileId) {
  if (state.isLaunching || state.result || state.ammo[missileId] === 0) return;
  state = {...state, selectedMissile: missileId};
  render();
  setStatus(`${MISSILES[missileId].label} armed · select a live window`, 'ready');
}

function createImpact(targetId, missileId) {
  const target = refs.building.querySelector(`[data-target-id="${targetId}"]`);
  if (!target) return;
  const sceneRect = refs.scene.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const burst = document.createElement('span');
  burst.className = `impact-burst impact-burst--${missileId}`;
  burst.style.left = `${targetRect.left - sceneRect.left + targetRect.width / 2}px`;
  burst.style.top = `${targetRect.top - sceneRect.top + targetRect.height / 2}px`;
  refs.impactLayer.appendChild(burst);
  target.classList.add('is-impacting');
  window.setTimeout(() => burst.remove(), 700);
}

function animateLaunch(targetId, missileId) {
  const target = refs.building.querySelector(`[data-target-id="${targetId}"]`);
  if (!target) return;

  const sceneRect = refs.scene.getBoundingClientRect();
  const launcherRect = refs.launcher.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const startX = launcherRect.left - sceneRect.left + launcherRect.width * 0.73;
  const startY = launcherRect.top - sceneRect.top + launcherRect.height * 0.12;
  const endX = targetRect.left - sceneRect.left + targetRect.width / 2;
  const endY = targetRect.top - sceneRect.top + targetRect.height / 2;

  refs.trail.className = `flight-trail is-visible trail-${missileId}`;
  refs.trail.style.left = `${startX - 7}px`;
  refs.trail.style.top = `${startY - 7}px`;
  refs.trail.style.setProperty('--dx', `${endX - startX}px`);
  refs.trail.style.setProperty('--dy', `${endY - startY}px`);

  window.setTimeout(() => {
    refs.trail.className = 'flight-trail';
    createImpact(targetId, missileId);
    const resolution = resolveLaunch(state, missileId, targetId);
    state = resolution.state;
    render();
    setStatus(resolution.message, resolution.state.result === 'won' ? 'success' : 'ready');
  }, 720);
}

function handleTargetClick(targetId) {
  if (state.isLaunching || state.result) return;
  const target = getTarget(state, targetId);
  if (!target || target.destroyed) return;
  const missileId = state.selectedMissile;
  if (state.ammo[missileId] <= 0) {
    setStatus(`${MISSILES[missileId].label} rack empty · choose another warhead`, 'ready');
    return;
  }

  state = {...state, isLaunching: true};
  render();
  setStatus(`${MISSILES[missileId].label} inbound · impact in progress`, 'flight');
  animateLaunch(targetId, missileId);
}

function resetRound() {
  state = createGameState();
  clockStartedAt = performance.now();
  render();
  setStatus('Choose a warhead, then pick a live window.', 'ready');
  document.querySelector('#missile-precision')?.focus();
}

function updateClock() {
  const elapsed = Math.floor((performance.now() - clockStartedAt) / 1000);
  refs.missionClock.textContent = `${twoDigits(Math.floor(elapsed / 60))}:${twoDigits(elapsed % 60)}`;
}

document.querySelectorAll('.missile-card').forEach((button) => {
  button.addEventListener('click', () => selectMissile(button.dataset.missileId));
});
refs.restart.addEventListener('click', resetRound);
window.addEventListener('keydown', (event) => {
  const shortcuts = {1: 'precision', 2: 'shockwave', 3: 'cluster'};
  if (shortcuts[event.key]) selectMissile(shortcuts[event.key]);
  if (event.key.toLowerCase() === 'r') resetRound();
});

render();
clockTimer = window.setInterval(updateClock, 1000);
updateClock();

window.addEventListener('beforeunload', () => window.clearInterval(clockTimer));
