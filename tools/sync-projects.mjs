#!/usr/bin/env node
/* Sync real projects from the backends into the Home page.

   Reads each backend's data/storyboards.db (from a temporary copy, so the live database is never
   touched) and its data/projects/<id>/ folder, then writes:
     example/projects/<id>/shotN.jpg   frames, 640 px wide
     example/projects/<id>/preview.mp4 for finished videos: 2 s of each shot, 640 px, no sound
     example/projects/data.js          window.QC_PROJECTS = [...], newest first

   Usage (Node 22.5+ for node:sqlite, ffmpeg on PATH or in FFMPEG_PATH):
     node tools/sync-projects.mjs [backend data folder ...]
   Default folders: ../video-generation-app/backend_dart/data and ../flutter_application_1/backend_dart/data
   Existing copies are kept; pass --force to make them again. */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(HTML, 'example', 'projects');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const SOURCES = args.filter((a) => !a.startsWith('--'));
if (!SOURCES.length) SOURCES.push(
  path.resolve(HTML, '../video-generation-app/backend_dart/data'),
  path.resolve(HTML, '../flutter_application_1/backend_dart/data'),
);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const PREVIEW_SECS = 2;   // seconds taken from each shot for the preview clip

function ffmpeg(argv) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffmpeg could not start (${r.error.message}). Install it or set FFMPEG_PATH.`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
}
const fresh = (file) => !FORCE && fs.existsSync(file) && fs.statSync(file).size > 0;
const rel = (file) => path.relative(HTML, file).split(path.sep).join('/');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Open a read-only copy of a backend database (with its WAL files, so recent writes are included) */
function openCopy(dataDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-sync-'));
  for (const ext of ['', '-wal', '-shm']) {
    const src = path.join(dataDir, 'storyboards.db' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'storyboards.db' + ext));
  }
  return { db: new DatabaseSync(path.join(tmp, 'storyboards.db')), tmp };
}

const projects = [];
for (const dataDir of SOURCES) {
  if (!fs.existsSync(path.join(dataDir, 'storyboards.db'))) { console.warn(`skip: no storyboards.db in ${dataDir}`); continue; }
  const app = path.basename(path.resolve(dataDir, '../..'));
  const { db, tmp } = openCopy(dataDir);
  try {
    for (const p of db.prepare('select * from projects').all()) {
      const srcDir = path.join(dataDir, 'projects', p.id), outDir = path.join(OUT, p.id);
      const rows = db.prepare('select * from shots where project_id = ? order by position').all(p.id);
      const shots = [];
      for (const s of rows) {
        const src = s.image_status === 'ready' && s.image_file ? path.join(srcDir, s.image_file) : null;
        let img = null;
        if (src && fs.existsSync(src)) {
          fs.mkdirSync(outDir, { recursive: true });
          const out = path.join(outDir, `shot${s.position}.jpg`);
          if (!fresh(out)) ffmpeg(['-i', src, '-vf', 'scale=640:-2', '-q:v', '5', out]);
          img = rel(out);
        }
        shots.push({ n: s.position, title: s.title, desc: s.description, secs: s.duration_seconds, motion: s.motion, img });
      }
      const render = db.prepare("select * from renders where project_id = ? and status = 'succeeded' and file is not null order by id desc").all(p.id)
        .find((r) => fs.existsSync(path.join(srcDir, r.file)));
      let video = null;
      if (render) {
        fs.mkdirSync(outDir, { recursive: true });
        const out = path.join(outDir, 'preview.mp4');
        if (!fresh(out)) {
          // 2 s from the start of each shot (shot starts scaled to the render's real length)
          const total = rows.reduce((a, s) => a + (s.duration_seconds || 0), 0) || render.duration_seconds;
          const k = (render.duration_seconds || total) / total;
          let at = 0;
          const parts = rows.map((s, i) => {
            const len = (s.duration_seconds || 0) * k, start = at; at += len;
            return `[0:v]trim=start=${start.toFixed(2)}:duration=${Math.min(PREVIEW_SECS, len || PREVIEW_SECS).toFixed(2)},setpts=PTS-STARTPTS[v${i}]`;
          });
          const graph = `${parts.join(';')};${rows.map((_, i) => `[v${i}]`).join('')}concat=n=${rows.length}:v=1:a=0,scale=640:-2[out]`;
          ffmpeg(['-i', path.join(srcDir, render.file), '-filter_complex', graph, '-map', '[out]', '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
        }
        video = rel(out);
      }
      const ready = shots.filter((s) => s.img).length;
      let status, progress, detail;
      if (video) { status = 'ready'; progress = 1; detail = `${shots.length} shot${shots.length === 1 ? '' : 's'}`; }
      else if (ready) {
        status = 'storyboard'; progress = ready / shots.length;
        detail = ready === shots.length ? `${ready} frames · not rendered` : `${ready} of ${shots.length} frames ready`;
      } else { status = 'draft'; progress = 0; detail = 'Story written · no frames yet'; }
      projects.push({
        id: p.id, app, title: p.title || 'Untitled', prompt: p.prompt, style: p.visual_style || '',
        created: p.created_at, updated: p.updated_at, ratio: p.aspect_ratio, secs: p.requested_duration, res: p.video_resolution,
        status, progress: +progress.toFixed(2), detail, duration: render ? clock(render.duration_seconds) : null,
        poster: shots.find((s) => s.img)?.img || null, video, shots,
      });
      console.log(`${status.padEnd(10)} ${p.title}  (${ready}/${shots.length} frames${video ? ', video' : ''})`);
    }
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
projects.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.js'),
  `/* Generated by tools/sync-projects.mjs from the backends' storyboards.db. Don't edit by hand: run\n   node tools/sync-projects.mjs to refresh it. */\nwindow.QC_PROJECTS = ${JSON.stringify(projects, null, 1)};\n`);
console.log(`\n${projects.length} projects → ${rel(path.join(OUT, 'data.js'))}`);
