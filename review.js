'use strict';

// The server owns content versions and stores every review. A failed save never
// changes the displayed approval state or pretends the spreadsheet was updated.
let posts = [];
let reviews = new Map();
let activeFilter = 'review';
const formats = { Post: 'Posts', Story: 'Stories', Reel: 'Reels' };
let activeFormat = Object.keys(formats).find(type => formats[type].toLowerCase() === new URLSearchParams(location.search).get('format')) || 'Post';
let storageReady = false;
let storageMode = 'unknown';
const container = document.querySelector('#posts');
const connection = document.querySelector('#connection');
const reviewer = document.querySelector('#reviewer');
const apiBase = document.documentElement.dataset.reviewApi || '';
const suppliedReviewKey = new URLSearchParams(location.hash.slice(1)).get('review') || '';
const reviewKey = /^[A-Za-z0-9_-]{43}$/.test(suppliedReviewKey) ? suppliedReviewKey : '';
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
  image.alt = post.title + (post.videoUrl ? ' — video preview' : ' — current calendar image');
  if (post.videoUrl) {
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
  card.querySelector('.metadata').textContent = post.type + (post.videoUrl ? ' · Video' : '') + ' · ' + post.platform;
  card.querySelector('h2').textContent = post.title;
  card.querySelector('.caption').textContent = post.caption;
  card.querySelector('.note').textContent = post.note;
  card.querySelector('.row-link').href = post.sheetUrl;
  card.querySelector('.concept').hidden = post.type !== 'Reel';
  const approve = card.querySelector('.approve');
  approve.textContent = post.type === 'Reel' ? 'Approve concept' : 'Approve post';
  approve.disabled = !storageReady || post.sheetStatus === 'Rejected';
  const form = card.querySelector('.change-form');
  form.elements.caption.value = post.caption;
  card.querySelector('.request').disabled = !storageReady;
  card.querySelector('.request').addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.note.focus();
  });
  card.querySelector('.cancel').addEventListener('click', () => { form.hidden = true; });
  approve.addEventListener('click', () => saveReview(post, card, 'approved', '', post.caption));
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveReview(post, card, 'changes', form.elements.note.value.trim(), form.elements.caption.value.trim());
  });
  if (saved && saved.contentVersion === post.contentVersion) {
    const when = new Date(saved.createdAt).toLocaleString('en-US', {timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short'});
    setMessage(card, (saved.action === 'approved' ? 'Approval saved' : 'Change request saved') + ' · ' + saved.reviewer);
    card.querySelector('.saved-detail').textContent = when + ' ET · ' + (saved.sheetSyncState === 'synced' ? 'Spreadsheet updated' : 'Spreadsheet update pending') + (saved.note ? '\n' + saved.note : '');
  } else if (post.sheetStatus === 'Rejected') {
    setMessage(card, 'This image needs a replacement before approval.', true);
  }
  return card;
}

function render() {
  // Format is the primary view; status filters apply only inside that view.
  const formatPosts = posts.filter(post => post.type === activeFormat);
  for (const button of document.querySelectorAll('[data-format]')) {
    const type = button.dataset.format;
    button.setAttribute('aria-pressed', String(type === activeFormat));
    button.querySelector('span').textContent = posts.filter(post => post.type === type).length;
  }
  document.querySelector('h1').textContent = 'November ' + formats[activeFormat].toLowerCase();
  container.setAttribute('aria-label', formats[activeFormat] + ' for review');
  const counts = {review:0, approved:0, changes:0};
  for (const post of formatPosts) counts[stateFor(post)] += 1;
  for (const key of Object.keys(counts)) document.querySelector('#' + key + '-count').textContent = counts[key];
  const visible = formatPosts.filter(post => activeFilter === 'all' || stateFor(post) === activeFilter);
  container.replaceChildren(...visible.map(makeCard));
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#empty').textContent = 'No ' + formats[activeFormat].toLowerCase() + ' in this view.';
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === activeFilter));
}

async function saveReview(post, card, action, note, caption) {
  const name = reviewer.value.trim();
  if (!name) { reviewer.focus(); setMessage(card, 'Enter your name above the posts.', true); return; }
  if (action === 'changes' && !note && caption === post.caption) { setMessage(card, 'Add a note or edit the caption first.', true); return; }
  if (!caption) { setMessage(card, 'The caption cannot be empty.', true); return; }
  // The request ID makes an uncertain/retried submission identifiable server-side.
  const requestId = crypto.randomUUID();
  const buttons = card.querySelectorAll('.actions button');
  buttons.forEach(button => { button.disabled = true; });
  setMessage(card, 'Saving…');
  try {
    const response = await fetch(apiBase + '/api/reviews', {method:'POST', headers:reviewHeaders(true), body:JSON.stringify({requestId, postId:post.id, contentVersion:post.contentVersion, action, reviewer:name, note, caption})});
    const value = await response.json();
    if (!response.ok || value.status !== 'success' || !value.review) throw new Error(value.message || 'The review was not saved.');
    reviews.set(post.id, value.review);
    render();
  } catch (error) {
    setMessage(card, error.message || 'Could not confirm this save. Reload before trying again.', true);
    buttons.forEach(button => { button.disabled = false; });
    if (post.sheetStatus === 'Rejected') card.querySelector('.approve').disabled = true;
  }
}

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { activeFilter = button.dataset.filter; render(); });
for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => {
  activeFormat = button.dataset.format;
  const url = new URL(location.href);
  url.searchParams.set('format', formats[activeFormat].toLowerCase());
  history.replaceState(null, '', url);
  render();
});
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
