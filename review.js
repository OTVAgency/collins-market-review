'use strict';

// The server owns content versions and stores every review. A failed save never
// changes the displayed approval state or pretends the spreadsheet was updated.
let posts = [];
let reviews = new Map();
let selectedPostId = null;
const formats = { Post: 'Posts', Story: 'Stories', Reel: 'Reels' };
let activeFormat = Object.keys(formats).find(type => formats[type].toLowerCase() === new URLSearchParams(location.search).get('format')) || 'all';
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
  image.alt = post.title + (post.videoSrc || post.videoUrl ? ' — video preview' : ' — current draft image');
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

// Calendar dates are local noon to avoid shifting a day across time zones.
function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}
function postDay(post) { return post.date ? dateKey(new Date(post.date + ' 12:00:00')) : ''; }
const events = [
  {date:'2026-11-07',title:'Veterans Day parade'},
  {date:'2026-11-19',title:'Art for Gifts begins',url:'https://www.saartcenter.org/exhibit-calendar'},
  {date:'2026-11-26',title:'Thanksgiving'},
  {date:'2026-11-28',title:'Small Business Saturday'},
  {date:'2026-11-30',title:'Christmas parade · 7 p.m.',url:'https://www.stauntondowntown.org/downtown-staunton-christmas-parade-2026'},
  {date:'2026-12-11',title:'A Sherlock Carol opens',url:'https://www.silverlinetheatre.org/shows'}
];
function openReview(post) {
  selectedPostId = post.id;
  container.replaceChildren(makeCard(post));
  const dialog = document.querySelector('#review-dialog');
  if (!dialog.open) dialog.showModal();
}
function makePreview(post) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'mini-post ' + post.type.toLowerCase();
  button.dataset.previewId = post.id;
  button.setAttribute('aria-label', post.type + ': ' + post.title);
  const type = document.createElement('span'); type.className = 'preview-type'; type.textContent = post.type;
  const image = document.createElement('img'); image.src = post.image; image.alt = ''; image.loading = 'lazy';
  const title = document.createElement('span'); title.className = 'preview-title'; title.textContent = post.title;
  const state = stateFor(post);
  const status = document.createElement('span'); status.className = 'preview-state ' + state;
  status.textContent = state === 'approved' ? 'Approved' : state === 'changes' ? 'Changes needed' : 'To review';
  button.append(type,image,title,status);
  button.addEventListener('click',()=>openReview(post));
  return button;
}
function render() {
  for (const button of document.querySelectorAll('[data-format]')) {
    const type = button.dataset.format;
    button.setAttribute('aria-pressed', String(type === activeFormat));
    const count = button.querySelector('span');
    if (count) count.textContent = posts.filter(post => post.type === type).length;
  }
  const visible = posts.filter(post => activeFormat === 'all' || post.type === activeFormat);
  const weeks = [];
  const start = new Date('2026-11-02T12:00:00');
  const end = new Date('2026-12-13T12:00:00');
  for (let monday = new Date(start); monday <= end; monday.setDate(monday.getDate()+7)) {
    const section = document.createElement('section'); section.className = 'week';
    const sunday = new Date(monday); sunday.setDate(sunday.getDate()+6);
    const heading = document.createElement('h2');
    heading.textContent = monday.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + sunday.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const scroll = document.createElement('div'); scroll.className = 'week-scroll'; scroll.tabIndex = 0;
    scroll.setAttribute('aria-label','Week of ' + heading.textContent + ' — scroll sideways for more days');
    const grid = document.createElement('div'); grid.className = 'week-grid';
    for (let day=0; day<7; day++) {
      const date = new Date(monday); date.setDate(date.getDate()+day);
      const key = dateKey(date); const column = document.createElement('section'); column.className = 'week-day'; column.dataset.day = key;
      const label = document.createElement('h3'); label.textContent = date.toLocaleDateString('en-US',{weekday:'short',day:'numeric'}); column.append(label);
      for (const event of events.filter(event=>event.date===key)) {
        const eventLabel = document.createElement(event.url ? 'a' : 'p');
        eventLabel.className = 'event-label'; eventLabel.textContent = event.title;
        if (event.url) {eventLabel.href=event.url;eventLabel.target='_blank';eventLabel.rel='noopener';}
        column.append(eventLabel);
      }
      const items = visible.filter(post=>postDay(post)===key);
      column.append(...items.map(makePreview));
      if (!items.length) { const empty=document.createElement('p');empty.className='day-empty';empty.textContent='Open';column.append(empty); }
      grid.append(column);
    }
    scroll.append(grid); section.append(heading,scroll); weeks.push(section);
  }
  document.querySelector('#weeks').replaceChildren(...weeks);
  const undated=visible.filter(post=>!post.date);
  document.querySelector('#undated-posts').replaceChildren(...undated.map(makePreview));
  document.querySelector('#undated').hidden=!undated.length;
}

async function saveReview(post, card, action, note, caption) {
  const name = reviewer.value.trim();
  if (!name) { reviewer.focus(); setMessage(card, 'Enter your name above the preview.', true); return; }
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
    render();
    if (selectedPostId === post.id) container.replaceChildren(makeCard(post));
  } catch (error) {
    setMessage(card, error.message || 'Could not confirm this save. Reload before trying again.', true);
    buttons.forEach(button => { button.disabled = false; });
    if (post.sheetStatus === 'Rejected') card.querySelector('.approve').disabled = true;
  }
}

for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => {
  activeFormat = button.dataset.format;
  render();
});
document.querySelector('#review-dialog .close').addEventListener('click', () => document.querySelector('#review-dialog').close());
document.querySelector('#image-dialog .close').addEventListener('click', () => document.querySelector('#image-dialog').close());

async function load() {
  try {
    const content = await fetch(document.documentElement.dataset.posts || '/api/posts', {cache:'no-store'});
    if (!content.ok) throw new Error('Could not load the content plan.');
    posts = (await content.json()).posts;
    if (!Array.isArray(posts)) throw new Error('The content plan is unavailable.');
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
    connection.textContent = storageMode === 'local-preview' ? 'Local preview — reviews here are for testing, not the shared plan.' : 'Reviews save here for Cory to apply to the planning sheet.';
  } catch {
    connection.textContent = apiBase && !reviewKey ? 'View the drafts here. Open Cory’s review link to approve or request changes.' : 'Images and captions are available. Review saving is temporarily unavailable.';
    connection.classList.add('error');
  }
  render();
}
load();
