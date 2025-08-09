/* ======= Data & Storage ======= */
const { set: idbSet, get: idbGet } = idbKeyval;
const STORE_KEY = 'notes-state-v1';

const defaultState = {
  siteTitle: 'Study Notes',
  sections: [
    { id: 'foundations', title: 'Foundations', notes: ['linear-regression'] },
  ],
  notes: {
    home: {
      id: 'home', title: 'Home',
      content: `<h1>Welcome</h1><p>Add sections and notes from the sidebar.</p>`,
      updatedAt: Date.now()
    },
    'linear-regression': {
      id: 'linear-regression', title: 'Linear Regression',
      content: `<h1>Linear Regression</h1>
        <p>Ordinary Least Squares minimizes \\(\\sum_i (y_i - \\hat{y}_i)^2\\).</p>
        <p>Closed form: \\(\\hat{\\beta} = (X^T X)^{-1} X^T y\\).</p>`,
      updatedAt: Date.now()
    }
  },
  selectedNoteId: 'home',
  github: { owner:'', repo:'', branch:'gh-pages', path:'data/notes.json', token:'' }
};

let state = structuredClone(defaultState);

/* ======= Utilities ======= */
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const slugify = (s) => s.toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-');
const ensureUniqueId = (baseId, existingIds) => {
  let id = slugify(baseId) || 'item';
  let i = 2;
  while (existingIds.has(id)) { id = `${id}-${i++}`; }
  return id;
};
const stripHtml = (html) => (new DOMParser().parseFromString(html, 'text/html').body.textContent || '').trim();

/* ======= Persistence ======= */
async function loadState(){
  const saved = await idbGet(STORE_KEY);
  if (saved && saved.notes && saved.sections) state = saved;
  // migrate minimal defaults
  if (!state.github) state.github = { owner:'', repo:'', branch:'gh-pages', path:'data/notes.json', token:'' };
  renderAll();
}
async function saveState(){ await idbSet(STORE_KEY, state); }

/* ======= Sidebar & Navigation ======= */
function renderSidebar(filterText=''){
  const nav = $('#nav');
  nav.innerHTML = '';

  const q = filterText.trim();
  if (q){
    renderSearchResults(q);
    return;
  } else {
    $('#searchResults').hidden = true;
  }

  const selectedId = state.selectedNoteId;
  for (const section of state.sections){
    const sEl = document.createElement('div');
    sEl.className = 'section';
    sEl.setAttribute('data-section-id', section.id);
    sEl.setAttribute('aria-expanded','true');

    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = `
      <span class="chev">▶</span>
      <div class="section-title">${section.title}</div>
      <button class="small" data-action="rename-section">Rename</button>
      <button class="small danger" data-action="delete-section">Delete</button>
    `;
    head.addEventListener('click', (e)=>{
      // Avoid toggle when clicking inline buttons
      if (e.target.closest('button')) return;
      const expanded = sEl.getAttribute('aria-expanded') === 'true';
      sEl.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });

    const list = document.createElement('div');
    list.className = 'section-notes';
    for (const noteId of section.notes){
      const note = state.notes[noteId];
      if (!note) continue;
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'note' + (noteId === selectedId ? ' active':'');
      a.textContent = note.title;
      a.addEventListener('click', (ev)=>{ ev.preventDefault(); openNote(noteId); });
      list.appendChild(a);
    }

    sEl.appendChild(head);
    sEl.appendChild(list);
    nav.appendChild(sEl);

    // Inline actions
    head.querySelector('[data-action="rename-section"]').addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const newTitle = prompt('Rename section:', section.title);
      if (!newTitle) return;
      section.title = newTitle.trim();
      saveState(); renderSidebar();
    });
    head.querySelector('[data-action="delete-section"]').addEventListener('click', (ev)=>{
      ev.stopPropagation();
      if (!confirm(`Delete section "${section.title}" and all links to its notes? Notes remain accessible via search.`)) return;
      // Remove links from section only; keep notes in DB
      section.notes = [];
      // Optionally, remove the section itself
      state.sections = state.sections.filter(s=>s.id!==section.id);
      saveState(); renderSidebar();
    });
  }
}

function renderSearchResults(query){
  const resultsBox = $('#searchResults');
  resultsBox.hidden = false;
  const notesArr = Object.values(state.notes);
  const fuse = new Fuse(notesArr, {
    keys: [{name:'title', weight:0.6}, {name:'content', getFn: (o)=>stripHtml(o.content), weight:0.4}],
    threshold: 0.35, includeScore: true
  });
  const res = fuse.search(query).slice(0, 50);
  resultsBox.innerHTML = res.length ? '' : '<div class="small">No results.</div>';
  for (const r of res){
    const div = document.createElement('div');
    div.className = 'note';
    div.innerHTML = `<strong>${r.item.title}</strong>`;
    div.addEventListener('click', ()=> openNote(r.item.id));
    resultsBox.appendChild(div);
  }
}

/* ======= Main View / Editor ======= */
let quill = null;

function openNote(noteId){
  state.selectedNoteId = noteId;
  saveState();
  const note = state.notes[noteId];
  $('#breadcrumbs').textContent = buildBreadcrumb(noteId);
  $('#viewer').innerHTML = note ? note.content : '<p>Not found.</p>';
  toggleEdit(false);
  renderSidebar();
}

function buildBreadcrumb(noteId){
  if (noteId === 'home') return 'Home';
  for (const s of state.sections){
    if (s.notes.includes(noteId)){
      return `${s.title} / ${state.notes[noteId]?.title ?? 'Untitled'}`;
    }
  }
  return state.notes[noteId]?.title ?? 'Untitled';
}

function initQuill(){
  if (quill) return quill;
  quill = new Quill('#editor', {
    theme: 'snow',
    modules: {
      toolbar: '#toolbar',
      formula: true
    }
  });

  // Drag & drop images into Quill
  const editorEl = document.querySelector('#editor .ql-editor');
  editorEl.addEventListener('drop', async (e)=>{
    const files = [...(e.dataTransfer?.files || [])].filter(f=>f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files){
      const dataUrl = await fileToDataUrl(file);
      const range = quill.getSelection(true);
      quill.insertEmbed(range ? range.index : quill.getLength(), 'image', dataUrl, 'user');
    }
  });

  return quill;
}

function toggleEdit(on){
  $('#viewer').hidden = on;
  $('#editorWrap').hidden = !on;
  $('#editBtn').hidden = on;
  $('#saveBtn').hidden = !on;

  if (on){
    const q = initQuill();
    const current = state.notes[state.selectedNoteId];
    q.setContents([]);
    q.clipboard.dangerouslyPasteHTML(current?.content || '');
    q.focus();
  }
}

function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function addSection(){
  const title = prompt('New section title:');
  if (!title) return;
  const existingIds = new Set(state.sections.map(s=>s.id));
  const id = ensureUniqueId(title, existingIds);
  state.sections.push({ id, title: title.trim(), notes: [] });
  saveState(); renderSidebar();
}

function addNote(){
  if (!state.sections.length){
    if (!confirm('No sections yet. Create a "General" section?')) return;
    state.sections.push({ id:'general', title:'General', notes:[] });
  }
  const title = prompt('New note title:');
  if (!title) return;

  const noteIds = new Set(Object.keys(state.notes));
  const id = ensureUniqueId(title, noteIds);

  // Choose section: if currently viewing a note in a section, default to that section
  let section = state.sections[0];
  for (const s of state.sections){
    if (s.notes.includes(state.selectedNoteId)) { section = s; break; }
  }

  state.notes[id] = { id, title: title.trim(), content: `<h1>${title.trim()}</h1>`, updatedAt: Date.now() };
  section.notes.push(id);
  saveState();
  renderSidebar();
  openNote(id);
}

function renameCurrent(){
  const id = state.selectedNoteId;
  if (id === 'home'){
    const newTitle = prompt('Rename site title (shown in sidebar header):', state.siteTitle || 'Study Notes');
    if (newTitle){
      state.siteTitle = newTitle.trim();
      $('#siteTitle').textContent = state.siteTitle;
      saveState();
    }
    return;
  }
  const note = state.notes[id];
  if (!note) return;
  const newTitle = prompt('Rename note:', note.title);
  if (!newTitle) return;
  note.title = newTitle.trim();
  saveState();
  renderSidebar();
  $('#breadcrumbs').textContent = buildBreadcrumb(id);
}

function deleteCurrent(){
  const id = state.selectedNoteId;
  if (id === 'home') { alert('Home cannot be deleted.'); return; }
  const note = state.notes[id];
  if (!note) return;

  if (!confirm(`Delete note "${note.title}"? This cannot be undone (unless you exported).`)) return;

  // Remove from sections
  for (const s of state.sections){
    s.notes = s.notes.filter(nid => nid !== id);
  }
  // Remove from DB
  delete state.notes[id];
  saveState();
  renderSidebar();
  openNote('home');
}

function saveCurrentFromEditor(){
  const id = state.selectedNoteId;
  const note = state.notes[id];
  if (!note) return;
  const html = document.querySelector('#editor .ql-editor').innerHTML;
  note.content = html;
  note.updatedAt = Date.now();
  saveState();
  openNote(id);
}

/* ======= Import / Export ======= */
function exportAll(){
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'notes-export.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importAllFile(file){
  const fr = new FileReader();
  fr.onload = ()=>{
    try{
      const obj = JSON.parse(fr.result);
      if (!obj.notes || !obj.sections) throw new Error('Invalid file.');
      state = obj;
      saveState(); renderAll();
    } catch(e){
      alert('Import failed: ' + e.message);
    }
  };
  fr.readAsText(file);
}

/* ======= GitHub Sync (optional, no backend) ======= */
async function githubGetFile({owner, repo, branch, path, token}){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: token ? {Authorization:`token ${token}`} : {} });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  return res.json();
}
async function githubPutFile({owner, repo, branch, path, token, contentBase64, message, sha}){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, branch, content: contentBase64 };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method:'PUT',
    headers:{ 'Content-Type':'application/json', ...(token ? {Authorization:`token ${token}`} : {}) },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status}`);
  return res.json();
}

async function loadFromGitHubUI(){
  const cfg = readGhConfig();
  const status = $('#syncStatus'); status.textContent = 'Loading…';
  try{
    const meta = await githubGetFile(cfg);
    if (!meta) { status.textContent = 'No file found at that path.'; return; }
    const json = atob(meta.content.replace(/\n/g,''));
    const obj = JSON.parse(json);
    state = obj;
    state.github = {...state.github, ...cfg};
    await saveState(); renderAll();
    status.textContent = 'Loaded from GitHub.';
  }catch(e){ status.textContent = e.message; }
}

async function saveToGitHubUI(){
  const cfg = readGhConfig();
  const status = $('#syncStatus'); status.textContent = 'Checking remote…';
  try{
    const meta = await githubGetFile(cfg);
    const sha = meta?.sha;
    const json = JSON.stringify(state, null, 2);
    const base64 = btoa(unescape(encodeURIComponent(json)));
    status.textContent = 'Saving…';
    await githubPutFile({
      ...cfg,
      contentBase64: base64,
      message: `Update notes.json (${new Date().toISOString()})`,
      sha
    });
    state.github = {...state.github, ...cfg};
    await saveState();
    status.textContent = 'Saved to GitHub.';
  }catch(e){ status.textContent = e.message; }
}

function readGhConfig(){
  const owner = $('#ghOwner').value.trim();
  const repo = $('#ghRepo').value.trim();
  const branch = $('#ghBranch').value.trim() || 'gh-pages';
  const path = $('#ghPath').value.trim() || 'data/notes.json';
  const token = $('#ghToken').value.trim();
  return { owner, repo, branch, path, token };
}

/* ======= Render & Events ======= */
function renderAll(){
  $('#siteTitle').textContent = state.siteTitle || 'Study Notes';
  renderSidebar($('#searchInput').value);
  openNote(state.selectedNoteId || 'home');

  // Prefill GH modal fields
  $('#ghOwner').value = state.github.owner || '';
  $('#ghRepo').value = state.github.repo || '';
  $('#ghBranch').value = state.github.branch || 'gh-pages';
  $('#ghPath').value = state.github.path || 'data/notes.json';
  $('#ghToken').value = state.github.token || '';
}

/* ======= DOM Hooks ======= */
$('#addSectionBtn').addEventListener('click', addSection);
$('#addNoteBtn').addEventListener('click', addNote);
$('#editBtn').addEventListener('click', ()=> toggleEdit(true));
$('#saveBtn').addEventListener('click', saveCurrentFromEditor);
$('#renameBtn').addEventListener('click', renameCurrent);
$('#deleteBtn').addEventListener('click', deleteCurrent);
$('#homeBtn').addEventListener('click', ()=> openNote('home'));
$('#searchInput').addEventListener('input', (e)=> renderSidebar(e.target.value));
$('#exportBtn').addEventListener('click', exportAll);
$('#importBtn').addEventListener('click', ()=> $('#importFile').click());
$('#importFile').addEventListener('change', (e)=>{
  const f = e.target.files?.[0]; if (f) importAllFile(f); e.target.value='';
});
$('#syncBtn').addEventListener('click', ()=> $('#syncDialog').showModal());
$('#saveToGitHub').addEventListener('click', saveToGitHubUI);
$('#loadFromGitHub').addEventListener('click', loadFromGitHubUI);

// Editable site title (persist)
$('#siteTitle').addEventListener('blur', ()=>{
  state.siteTitle = $('#siteTitle').textContent.trim() || 'Study Notes';
  saveState();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
    e.preventDefault();
    if (!$('#editorWrap').hidden) saveCurrentFromEditor();
  } else if (e.key==='Escape' && !$('#editorWrap').hidden){
    toggleEdit(false);
  }
});

// Load
loadState();
