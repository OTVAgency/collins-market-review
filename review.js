'use strict';

// The server owns content versions and stores every review. A failed save never
// changes the displayed approval state or pretends the spreadsheet was updated.
let posts = [];
let reviews = new Map();
let activeFilter = 'review';
const formats = { Post: 'Posts', Story: 'Stories', Reel: 'Reels' };
let activeFormat = Object.keys(formats).find(type => formats[type].toLowerCase() === new URLSearchParams(location.search).get('format')) || 'Post';
const initialParams = new URLSearchParams(location.search);
let activeView = initialParams.get('view') === 'calendar' || !initialParams.has('format') ? 'calendar' : 'list';
let selectedDay = initialParams.get('day') || '';
let calendarMonth = null;
let storageReady = false;
let storageMode = 'unknown';
const container = document.querySelector('#posts');
const connection = document.querySelector('#connection');
const reviewer = document.querySelector('#reviewer');
const apiBase = document.documentElement.dataset.reviewApi || '';
const suppliedReviewKey = new URLSearchParams(location.hash.slice(1)).get('review') || '';
const reviewKey = /^[A-Za-z0-9_-]{43}$/.test(suppliedReviewKey) ? suppliedReviewKey : '';
// A shared review key lives in the URL fragment. Browsers normally skip loading
// the page again when only that fragment changes, so refresh to apply access.
window.addEventListener('hashchange', () => location.reload());
// Keep the approval link when someone clicks the logo to return to Posts.
const brandLink = document.querySelector('.brand');
if (brandLink && reviewKey) brandLink.href = location.href;
function reviewHeaders(json = false) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  if (reviewKey) headers['X-Review-Key'] = reviewKey;
  return headers;
}

function stateFor(post) {
  const review = reviews.get(post.id);
  if (review && review.contentVersion === post.contentVersion) return review.action;
  return post.sheetStatus === 'Approved' ? 'approved' : post.sheetStatus === 'Rejected' ? 'changes' : 'review';
}

function setMessage(card, text, error = false) {
  const message = card.querySelector('.review-message');
  message.textContent = text;
  message.classList.toggle('error', error);
}

function dayKey(value) {
  if (!value) return '';
  const [month, day, year] = value.split('/');
  return year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0');
}

function calendarDate(key) { return new Date(key + 'T12:00:00'); }

function initializeCalendar() {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York'}).format(new Date());
  const dates = [...new Set(posts.map(post => dayKey(post.date)).filter(Boolean))].sort();
  if (!dates.includes(selectedDay)) selectedDay = dates.find(date => date >= today) || dates[0] || today;
  const date = calendarDate(selectedDay);
  calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function updateViewUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', activeView);
  if (activeView === 'calendar') url.searchParams.set('day', selectedDay);
  else url.searchParams.set('format', formats[activeFormat].toLowerCase());
  history.replaceState(null, '', url);
}

function renderCalendar() {
  const panel = document.querySelector('#calendar-panel');
  panel.hidden = activeView !== 'calendar';
  document.querySelector('[data-view="calendar"]').setAttribute('aria-pressed', String(activeView === 'calendar'));
  document.querySelector('#day-heading').hidden = activeView !== 'calendar';
  if (activeView !== 'calendar') return;
  document.querySelector('#calendar-month').textContent = calendarMonth.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  const grid = document.querySelector('#calendar-days');
  const cells = [];
  for (let i = 0; i < calendarMonth.getDay(); i++) {
    const spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    cells.push(spacer);
  }
  const count = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= count; day++) {
    const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day, 12);
    const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const items = posts.filter(post => dayKey(post.date) === key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.dataset.calendarDay = key;
    button.setAttribute('aria-pressed', String(selectedDay === key));
    const number = document.createElement('span');
    number.className = 'day-number';
    number.textContent = day;
    button.append(number);
    const summary = [];
    for (const type of Object.keys(formats)) {
      const total = items.filter(post => post.type === type).length;
      if (!total) continue;
      const badge = document.createElement('span');
      badge.className = 'calendar-type ' + type.toLowerCase();
      const label = total + ' ' + (total === 1 ? type : formats[type]);
      badge.textContent = label;
      summary.push(label);
      button.append(badge);
    }
    button.setAttribute('aria-label', date.toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'}) + ': ' + (summary.join(', ') || 'No planned content'));
    button.addEventListener('click', () => { selectedDay = key; updateViewUrl(); render(); });
    cells.push(button);
  }
  grid.replaceChildren(...cells);
  const undated = posts.filter(post => !post.date).length;
  document.querySelector('#undated-content').hidden = undated === 0;
  document.querySelector('#undated-content').textContent = 'Undated drafts (' + undated + ')';
  document.querySelector('#day-heading').textContent = selectedDay === 'undated' ? 'Undated drafts' : calendarDate(selectedDay).toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'});
}

function makeCard(post) {
  const card = document.querySelector('#post-template').content.firstElementChild.cloneNode(true);
  const state = stateFor(post);
  const saved = reviews.get(post.id);
  card.dataset.postId = post.id;
  card.querySelector('.date').textContent = post.date ? new Date(post.date + ' 12:00:00').toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}) : 'Date to choose';
  const badge = card.querySelector('.badge');
  badge.textContent = state === 'approved' ? 'Approved' : state === 'changes' ? 'Changes needed' : 'To review';
  badge.classList.add(state);
  const image = card.querySelector('.image-button img');
  image.src = post.image;
  image.alt = post.title + (post.videoSrc || post.videoUrl ? ' — video preview' : ' — current calendar image');
  if (post.videoSrc) {
    // Finished exports play directly on the review card, including on phones.
    // The poster remains visible until the reviewer chooses to play the video.
    const video = document.createElement('video');
    video.className = 'inline-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = post.image;
    video.src = post.videoSrc;
    video.setAttribute('aria-label', 'Play ' + post.title);
    card.querySelector('.image-button').replaceWith(video);
  } else if (post.videoUrl) {
    // Keep a durable poster locally; Facebook embeds may be blocked by a
    // visitor's browser. The original video remains one click away.
    const source = document.createElement('a');
    source.className = 'image-button video-preview';
    source.href = post.videoUrl;
    source.target = '_blank';
    source.rel = 'noopener';
    source.setAttribute('aria-label', 'Watch ' + post.title + ' on Facebook');
    const label = document.createElement('span');
    label.textContent = '▶ Watch video on Facebook ↗';
    source.append(image, label);
    card.querySelector('.image-button').replaceWith(source);
  } else {
    card.querySelector('.image-button').addEventListener('click', () => {
      const dialog = document.querySelector('#image-dialog');
      dialog.querySelector('img').src = post.image;
      dialog.querySelector('img').alt = image.alt;
      dialog.showModal();
    });
  }
  card.querySelector('.metadata').textContent = post.type + (post.videoSrc || post.videoUrl ? ' · Video' : '') + ' · ' + post.platform;
  card.querySelector('h2').textContent = post.title;
  card.querySelector('.caption').textContent = post.caption;
  card.querySelector('.note').textContent = post.note;
  card.querySelector('.row-link').href = post.sheetUrl;
  card.querySelector('.concept').hidden = post.type !== 'Reel';
  const approve = card.querySelector('.approve');
  const canUndo = state === 'approved' && saved?.requestId;
  approve.textContent = canUndo ? 'Undo approval' : post.type === 'Reel' ? 'Approve concept' : 'Approve post';
  approve.disabled = !storageReady || post.sheetStatus === 'Rejected';
  const form = card.querySelector('.change-form');
  form.elements.caption.value = post.caption;
  card.querySelector('.request').disabled = !storageReady;
  card.querySelector('.request').addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.note.focus();
  });
  card.querySelector('.cancel').addEventListener('click', () => { form.hidden = true; });
  approve.addEventListener('click', () => saveReview(post, card, canUndo ? 'review' : 'approved', '', post.caption));
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveReview(post, card, 'changes', form.elements.note.value.trim(), form.elements.caption.value.trim());
  });
  if (saved && saved.contentVersion === post.contentVersion) {
    const when = new Date(saved.createdAt).toLocaleString('en-US', {timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short'});
    setMessage(card, (saved.action === 'approved' ? 'Approval saved' : saved.action === 'review' ? 'Approval undone — back to review' : 'Change request saved') + ' · ' + saved.reviewer);
    card.querySelector('.saved-detail').textContent = when + ' ET · ' + (saved.sheetSyncState === 'synced' ? 'Spreadsheet updated' : 'Spreadsheet update pending') + (saved.note ? '\n' + saved.note : '');
  } else if (post.sheetStatus === 'Rejected') {
    setMessage(card, 'This image needs a replacement before approval.', true);
  }
  return card;
}

function render() {
  // Calendar shows every format on the chosen day; list tabs retain type filters.
  if (!calendarMonth) initializeCalendar();
  renderCalendar();
  const formatPosts = activeView === 'calendar' ? posts.filter(post => selectedDay === 'undated' ? !post.date : dayKey(post.date) === selectedDay) : posts.filter(post => post.type === activeFormat);
  for (const button of document.querySelectorAll('[data-format]')) {
    const type = button.dataset.format;
    button.setAttribute('aria-pressed', String(activeView === 'list' && type === activeFormat));
    button.querySelector('span').textContent = posts.filter(post => post.type === type).length;
  }
  document.querySelector('h1').textContent = activeView === 'calendar' ? 'Content calendar' : 'Upcoming ' + formats[activeFormat].toLowerCase();
  container.setAttribute('aria-label', formats[activeFormat] + ' for review');
  const counts = {review:0, approved:0, changes:0};
  for (const post of formatPosts) counts[stateFor(post)] += 1;
  for (const key of Object.keys(counts)) document.querySelector('#' + key + '-count').textContent = counts[key];
  const visible = formatPosts.filter(post => activeFilter === 'all' || stateFor(post) === activeFilter);
  container.replaceChildren(...visible.map(makeCard));
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#empty').textContent = activeView === 'calendar' ? 'No content in this view for this day.' : 'No ' + formats[activeFormat].toLowerCase() + ' in this view.';
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === activeFilter));
}

async function saveReview(post, card, action, note, caption) {
  const name = reviewer.value.trim();
  if (!name) { reviewer.focus(); setMessage(card, 'Enter your name above the posts.', true); return; }
  if (action === 'changes' && !note && caption === post.caption) { setMessage(card, 'Add a note or edit the caption first.', true); return; }
  if (!caption) { setMessage(card, 'The caption cannot be empty.', true); return; }
  // The request ID makes an uncertain/retried submission identifiable server-side.
  const requestId = crypto.randomUUID();
  const previousReviewId = action === 'review' ? reviews.get(post.id)?.requestId : undefined;
  const buttons = card.querySelectorAll('.actions button');
  buttons.forEach(button => { button.disabled = true; });
  setMessage(card, 'Saving…');
  try {
    const response = await fetch(apiBase + '/api/reviews', {method:'POST', headers:reviewHeaders(true), body:JSON.stringify({requestId, postId:post.id, contentVersion:post.contentVersion, action, reviewer:name, note, caption, previousReviewId})});
    const value = await response.json();
    if (!response.ok || value.status !== 'success' || !value.review) throw new Error(value.message || 'The review was not saved.');
    reviews.set(post.id, value.review);
    if (action === 'review') activeFilter = 'review';
    render();
  } catch (error) {
    setMessage(card, error.message || 'Could not confirm this save. Reload before trying again.', true);
    buttons.forEach(button => { button.disabled = false; });
    if (post.sheetStatus === 'Rejected') card.querySelector('.approve').disabled = true;
  }
}

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { activeFilter = button.dataset.filter; render(); });
for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => {
  activeView = 'list';
  activeFormat = button.dataset.format;
  updateViewUrl();
  render();
});
document.querySelector('[data-view="calendar"]').addEventListener('click', () => { activeView = 'calendar'; updateViewUrl(); render(); });
for (const button of document.querySelectorAll('[data-month-step]')) button.addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + Number(button.dataset.monthStep), 1, 12);
  renderCalendar();
});
document.querySelector('#undated-content').addEventListener('click', () => { selectedDay = 'undated'; updateViewUrl(); render(); });
document.querySelector('#image-dialog .close').addEventListener('click', () => document.querySelector('#image-dialog').close());

async function load() {
  try {
    const content = await fetch(document.documentElement.dataset.posts || '/api/posts', {cache:'no-store'});
    if (!content.ok) throw new Error('Could not load the content calendar.');
    posts = (await content.json()).posts;
    if (!Array.isArray(posts)) throw new Error('The content calendar is unavailable.');
  } catch (error) {
    connection.textContent = error.message;
    connection.classList.add('error');
    return;
  }
  try {
    const response = await fetch(apiBase + '/api/reviews', {cache:'no-store', headers:reviewHeaders()});
    const value = await response.json();
    if (!response.ok || value.status !== 'success') throw new Error('Review storage is unavailable.');
    reviews = new Map(value.reviews.map(review => [review.postId, review]));
    storageReady = true;
    storageMode = value.storageMode;
    connection.textContent = storageMode === 'local-preview' ? 'Local preview — reviews here are for testing, not the shared calendar.' : 'Reviews save here for Cory to apply to the calendar.';
  } catch {
    connection.textContent = apiBase && !reviewKey ? 'View the drafts here. Open Cory’s review link to approve or request changes.' : 'Images and captions are available. Review saving is temporarily unavailable.';
    connection.classList.add('error');
  }
  render();
}
load();
